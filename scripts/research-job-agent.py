#!/usr/bin/env python3
"""Trusted POSIX job endpoint for SSH or local adapters; standard library only.

stdin: one schema-1 ensure/inspect request; stdout: one JobReply.
The operator pins an argv template in --config. Model input is DATA, never a
command. Not a sandbox. Lost worker ownership becomes UNKNOWN, not a rerun.
Optional resultMaxBytes requires a strict JSON object via FUTURE_JOB_RESULT_PATH;
maxLogBytes retains bounded log prefixes. Terminal artifacts have hash-checked,
bounded read_artifact pages; neither metrics nor log text authorize acceptance.
"""
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import threading
import time
from typing import Any

MAX_REQUEST = 1024 * 1024
# Startup is replayable only while the durable state is QUEUED. A runner
# publishes RUNNING under worker.lock before invoking any user command.
STARTUP_RETRY_SECONDS = 5.0
MAX_STARTUP_ATTEMPTS = 3
# A freshly spawned runner must survive brief administrative lock contention
# from concurrent ensure/inspect calls. This is deliberately much shorter than
# a job lifetime: if another worker publishes RUNNING/terminal state, the
# losing runner exits instead of waiting behind real execution.
WORKER_LOCK_HANDOFF_SECONDS = 2.0


def encoded(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def atomic(path: Path, value: Any) -> None:
    data = encoded(value)
    temporary = path.with_name(path.name + f".{os.getpid()}.{threading.get_ident()}.tmp")
    with open(temporary, "xb") as out:
        os.chmod(temporary, 0o600)
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read(path: Path) -> Any:
    if path.stat().st_size > MAX_REQUEST:
        raise ValueError("record exceeds byte budget")
    return json.loads(path.read_text())


def template(path: Path) -> dict[str, Any]:
    cfg = read(path)
    if not isinstance(cfg, dict) or set(cfg) - {"argv", "cwd", "timeoutMs", "envAllow", "resultMaxBytes", "maxLogBytes", "artifacts"}:
        raise ValueError("invalid trusted job template")
    argv = cfg.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and a and "\0" not in a for a in argv):
        raise ValueError("argv must be a nonempty string array")
    if not Path(argv[0]).is_absolute():
        raise ValueError("job executable must be absolute")
    timeout = cfg.get("timeoutMs")
    if type(timeout) is not int or not 100 <= timeout <= 604800000:
        raise ValueError("timeoutMs must be 100ms to 7 days")
    if "cwd" in cfg and (not isinstance(cfg["cwd"], str) or not Path(cfg["cwd"]).is_absolute()):
        raise ValueError("cwd must be absolute")
    env = cfg.get("envAllow", [])
    if not isinstance(env, list) or not all(isinstance(n, str) and re.fullmatch(r"[A-Z_][A-Z0-9_]*", n) for n in env):
        raise ValueError("invalid environment allowlist")
    if any(n.startswith(("LD_", "DYLD_", "NODE_OPTIONS", "PYTHONPATH", "FUTURE_JOB_")) for n in env):
        raise ValueError("loader and reserved job environment must not be forwarded")
    for name, ceiling in (("resultMaxBytes", 65536), ("maxLogBytes", 268435456)):
        if name in cfg and (type(cfg[name]) is not int or not 1 <= cfg[name] <= ceiling):
            raise ValueError(f"invalid {name}")
    artifacts = cfg.get("artifacts", {})
    if not isinstance(artifacts, dict) or len(artifacts) > 32:
        raise ValueError("invalid declared artifacts")
    total = 0
    for name, spec in artifacts.items():
        if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name)
                or name in ("stdout", "stderr", "result", "__proto__", "constructor", "prototype")
                or not isinstance(spec, dict) or set(spec) != {"maxBytes"}
                or type(spec["maxBytes"]) is not int or not 1 <= spec["maxBytes"] <= 268435456):
            raise ValueError("invalid declared artifact name or byte limit")
        total += spec["maxBytes"]
    if total > 268435456:
        raise ValueError("declared artifact total exceeds byte limit")
    return cfg


def regular_file(path: Path):
    """No symlink traversal or blocking on a FIFO when reading result evidence."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("evidence must be a regular file")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def unique_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate structured result key")
        out[key] = value
    return out


def invalid_constant(_value):
    raise ValueError("nonfinite structured result")


def structured_result(directory: Path, limit: int) -> tuple[dict[str, Any], dict[str, Any]]:
    with regular_file(directory / "result.json") as source:
        if os.fstat(source.fileno()).st_size > limit:
            raise ValueError("structured result exceeds byte budget")
        raw = source.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("structured result exceeds byte budget")
    data = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=invalid_constant)
    if not isinstance(data, dict):
        raise ValueError("structured result must be an object")
    encoded(data)  # Also rejects numeric overflow such as 1e999 -> infinity.
    # Publish an exact cold copy only after parsing, never a stdout extraction.
    fd = os.open(directory / "result.bin", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(raw)
        out.flush()
        os.fsync(out.fileno())
    return data, {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}


def capture_artifact(directory: Path, output_fd: int, name: str, limit: int) -> dict[str, Any]:
    """Snapshot an operator-declared flat output through its original directory FD.
    Renaming/replacing the output directory cannot redirect the capture outside it.
    An interrupted capture can leave an uncited file, never a successful manifest.
    """
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=output_fd)
    with os.fdopen(fd, "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError("declared artifact is not a bounded regular file")
        dest = os.open(directory / f"{name}.bin", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        size, checksum = 0, hashlib.sha256()
        with os.fdopen(dest, "wb") as out:
            while chunk := source.read(min(65536, limit + 1 - size)):
                size += len(chunk)
                if size > limit:
                    raise ValueError("declared artifact exceeds byte limit")
                out.write(chunk)
                checksum.update(chunk)
            after = os.fstat(source.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or size != before.st_size:
                raise ValueError("declared artifact changed while capturing")
            out.flush()
            os.fsync(out.fileno())
    return {"sha256": checksum.hexdigest(), "bytes": size}


def artifact_page(directory: Path, key: str, request: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    if set(request) - {"schema", "operation", "key", "jobId", "artifact", "offset", "length"}:
        raise ValueError("invalid artifact request")
    if read(directory / "request.json")["config"] != cfg:
        raise ValueError("job template drift")
    record = read(directory / "state.json")
    if record["status"] not in ("SUCCEEDED", "FAILED", "CANCELLED"):
        raise ValueError("artifact is not terminal evidence")
    name = request.get("artifact")
    if not isinstance(name, str) or (name not in ("stdout", "stderr", "result") and name not in cfg.get("artifacts", {})):
        raise ValueError("unknown artifact")
    offset, length = request.get("offset", 0), request.get("length", 4096)
    if type(offset) is not int or offset < 0 or type(length) is not int or not 1 <= length <= 8192:
        raise ValueError("invalid artifact range")
    meta = record.get("result", {}).get("artifacts", {}).get(name)
    limit = cfg["artifacts"][name]["maxBytes"] if name in cfg.get("artifacts", {}) else cfg.get("resultMaxBytes" if name == "result" else "maxLogBytes", 0)
    if not isinstance(meta, dict) or type(meta.get("bytes")) is not int or not 0 <= meta["bytes"] <= limit:
        raise ValueError("invalid artifact metadata")
    size, checksum = 0, hashlib.sha256()
    content = bytearray()
    with regular_file(directory / f"{name}.bin") as source:
        if os.fstat(source.fileno()).st_size != meta["bytes"]:
            raise ValueError("artifact size changed")
        while chunk := source.read(65536):
            if size + len(chunk) > meta["bytes"]:
                raise ValueError("artifact grew while reading")
            # Return the bytes from the SAME stream that is hashed, including
            # arbitrary UTF-8 cut boundaries; base64 is lossless and JSON safe.
            start, end = max(0, offset - size), min(len(chunk), offset + length - size)
            if start < end:
                content.extend(chunk[start:end])
            size += len(chunk)
            checksum.update(chunk)
    if size != meta["bytes"] or checksum.hexdigest() != meta.get("sha256"):
        raise ValueError("artifact integrity failure")
    return {"schema": 1, "key": key, "jobId": key, "artifact": name, "sha256": meta["sha256"],
            "offset": offset, "bytes": size, "contentBase64": base64.b64encode(content).decode("ascii"),
            "nextOffset": offset + len(content) if offset + len(content) < size else None}


def lock_free(path: Path) -> bool:
    with open(path, "a+b") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(handle, fcntl.LOCK_UN)
        return True


def observation(directory: Path, key: str) -> dict[str, Any]:
    state = read(directory / "state.json")
    status = state["status"]
    # A dead supervisor does not prove its child/external side effect ended.
    if status == "RUNNING" and lock_free(directory / "worker.lock"):
        status = "UNKNOWN"
    reply: dict[str, Any] = {"schema": 1, "key": key, "jobId": key, "status": status}
    try:
        progress = read(directory / "progress.json")
        sequence = progress.get("sequence")
        if type(sequence) is int and sequence >= 0:
            reply["progressToken"] = str(sequence)
    except (OSError, ValueError, AttributeError):
        pass
    if "result" in state:
        reply["result"] = state["result"]
    return reply


def reconcile_startup(directory: Path) -> None:
    """Called under registry.lock by ensure AND inspect.

    Recover a runner lost before RUNNING, never a possibly executed job. Read
    and update QUEUED under worker.lock so startup bookkeeping cannot overwrite
    a concurrent RUNNING publication. Release it before spawning the runner.
    """
    with open(directory / "worker.lock", "a+b") as guard:
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state = read(directory / "state.json")
        if state["status"] != "QUEUED":
            return
        attempts = state.get("launchAttempts", 0)
        last = state.get("launchRequestedAt")
        if type(attempts) is not int or not 0 <= attempts <= MAX_STARTUP_ATTEMPTS:
            raise ValueError("invalid durable startup counter")
        if last is not None and (type(last) not in (int, float) or not math.isfinite(last)):
            raise ValueError("invalid durable startup timestamp")
        now = time.time()
        if last is not None and 0 <= now - last < STARTUP_RETRY_SECONDS:
            return
        if attempts >= MAX_STARTUP_ATTEMPTS:
            atomic(directory / "state.json", {**state, "status": "FAILED", "result": {
                "exitCode": None, "error": "startup retry budget exhausted before command execution; inspect runner infrastructure"}})
            return
        atomic(directory / "state.json", {**state, "launchAttempts": attempts + 1, "launchRequestedAt": now})
    # A delayed older runner can win the lock. Every runner rechecks QUEUED;
    # exactly one can publish RUNNING, including after concurrent inspections.
    try:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--worker", str(directory)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)
    except OSError:
        # Keep the stable job ID and retryable QUEUED record. Returning a fatal
        # adapter error here would strand the host's remote-capacity reservation.
        pass


def endpoint(root: Path, config: Path, request: Any) -> dict[str, Any]:
    if not isinstance(request, dict) or request.get("schema") != 1:
        raise ValueError("invalid request")
    key = request.get("key")
    if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key):
        raise ValueError("invalid stable job key")
    if request.get("operation") not in ("ensure", "inspect", "read_artifact"):
        raise ValueError("unsupported operation")
    if request.get("jobId") not in (None, key):
        raise ValueError("job identity mismatch")
    if request.get("operation") in ("inspect", "read_artifact") and request.get("jobId") != key:
        raise ValueError("read needs a known job ID")
    cfg = template(config)
    if request["operation"] == "read_artifact":
        return artifact_page(root / key, key, request, cfg)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = root / key
    # Administrative lock also serializes concurrent ensure calls before mkdir.
    with open(root / "registry.lock", "a+b") as registry:
        fcntl.flock(registry, fcntl.LOCK_EX)
        identity = hashlib.sha256(encoded({"input": request.get("input"), "inputHash": request.get("inputHash"), "template": cfg})).hexdigest()
        if not directory.exists():
            if request["operation"] == "inspect":
                return {"schema": 1, "key": key, "jobId": key, "status": "UNKNOWN"}
            directory.mkdir(mode=0o700)
            atomic(directory / "request.json", {"identity": identity, "input": request.get("input"), "config": cfg})
            atomic(directory / "state.json", {"status": "QUEUED", "created": time.time()})
        else:
            # State loss or corruption requires reconciliation; do not erase it.
            if read(directory / "request.json")["identity"] != identity:
                raise ValueError("job input/template drift")
        reconcile_startup(directory)
        return observation(directory, key)


def worker(directory: Path) -> None:
    with open(directory / "worker.lock", "a+b") as guard:
        # Pollers also take worker.lock briefly while reconciling QUEUED startup.
        # A one-shot LOCK_NB made a valid freshly spawned runner disappear if it
        # raced one of those pollers. Retry only during a short startup handoff;
        # if another runner wins and publishes RUNNING/terminal state, exit.
        deadline = time.monotonic() + WORKER_LOCK_HANDOFF_SECONDS
        while True:
            try:
                fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                try:
                    status = read(directory / "state.json").get("status")
                except (OSError, ValueError, AttributeError):
                    return
                if status != "QUEUED" or time.monotonic() >= deadline:
                    return
                time.sleep(0.01)
        record = read(directory / "state.json")
        if record["status"] != "QUEUED":
            return
        request = read(directory / "request.json")
        cfg = request["config"]
        atomic(directory / "input.json", request["input"])
        atomic(directory / "state.json", {**record, "status": "RUNNING", "workerPid": os.getpid()})
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(directory),
               "FUTURE_JOB_KEY": directory.name, "FUTURE_JOB_INPUT_PATH": str(directory / "input.json"),
               "FUTURE_JOB_PROGRESS_PATH": str(directory / "progress.json")}
        env.update({k: os.environ[k] for k in cfg.get("envAllow", []) if k in os.environ})
        if "resultMaxBytes" in cfg:
            env["FUTURE_JOB_RESULT_PATH"] = str(directory / "result.json")
        output_fd = None
        if cfg.get("artifacts"):
            outputs = directory / "outputs"
            outputs.mkdir(mode=0o700)
            output_fd = os.open(outputs, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            env["FUTURE_JOB_ARTIFACT_DIR"] = str(outputs)
        tails: dict[str, bytes] = {"stdout": b"", "stderr": b""}
        artifacts: dict[str, Any] = {}
        capture_errors: dict[str, str] = {}

        def drain(stream: Any, name: str) -> None:
            limit = cfg.get("maxLogBytes", 0)
            out = None
            retained, observed = 0, 0
            checksum, observed_checksum = hashlib.sha256(), hashlib.sha256()
            if limit:
                try:
                    fd = os.open(directory / f"{name}.bin", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    out = os.fdopen(fd, "wb")
                except OSError:
                    capture_errors[name] = "log artifact could not open"
            try:
                while chunk := stream.read(4096):
                    tails[name] = (tails[name] + chunk)[-65536:]
                    if limit:
                        observed += len(chunk)
                        observed_checksum.update(chunk)
                    if out is not None and retained < limit:
                        prefix = chunk[:max(0, limit - retained)]
                        try:
                            out.write(prefix)
                            checksum.update(prefix)
                            retained += len(prefix)
                        except OSError:
                            capture_errors[name] = "log artifact write failed"
                            # Keep draining after disk errors so a verbose child
                            # cannot deadlock against a full pipe.
                            try:
                                out.close()
                            except OSError:
                                pass
                            out = None
            except OSError:
                capture_errors[name] = "log stream could not drain"
            finally:
                stream.close()
                if out is not None:
                    try:
                        out.flush()
                        os.fsync(out.fileno())
                    except OSError:
                        capture_errors[name] = "log artifact could not persist"
                    finally:
                        try:
                            out.close()
                        except OSError:
                            capture_errors[name] = "log artifact could not close"
                if limit and name not in capture_errors:
                    artifacts[name] = {"sha256": checksum.hexdigest(), "bytes": retained,
                                       "observedBytes": observed, "observedSha256": observed_checksum.hexdigest(),
                                       "truncated": observed > retained}

        started = time.monotonic()
        code = -1
        reason = None
        child = None
        threads: list[threading.Thread] = []
        try:
            with open(directory / "input.json", "rb") as data:
                child = subprocess.Popen(cfg["argv"], cwd=cfg.get("cwd", str(directory)), env=env,
                                         stdin=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         close_fds=True, start_new_session=True)
            for name, stream in (("stdout", child.stdout), ("stderr", child.stderr)):
                t = threading.Thread(target=drain, args=(stream, name), daemon=True)
                t.start()
                threads.append(t)
            try:
                code = child.wait(timeout=cfg["timeoutMs"] / 1000)
            except subprocess.TimeoutExpired:
                reason = "trusted job deadline exceeded"
        except OSError:
            reason = "trusted executable could not start"
        finally:
            if child:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                code = child.wait()
            for t in threads:
                t.join(timeout=1)
            if any(t.is_alive() for t in threads):
                reason = reason or "log streams did not finish"
            elif capture_errors:
                reason = reason or "log evidence capture failed"
        result = {"exitCode": code, "durationMs": round((time.monotonic() - started) * 1000),
                  "configurationHash": hashlib.sha256(encoded(cfg)).hexdigest(),
                  "stdoutTail": tails["stdout"][-4096:].decode("utf-8", errors="replace"),
                  "stderrTail": tails["stderr"][-4096:].decode("utf-8", errors="replace")}
        if "resultMaxBytes" in cfg:
            try:
                data, meta = structured_result(directory, cfg["resultMaxBytes"])
                result["data"] = data
                artifacts["result"] = meta
            except (OSError, ValueError, RecursionError):
                reason = reason or "structured result missing, invalid, or exceeds byte budget"
        if output_fd is not None:
            try:
                for name, spec in cfg["artifacts"].items():
                    try:
                        artifacts[name] = capture_artifact(directory, output_fd, name, spec["maxBytes"])
                    except (OSError, ValueError):
                        reason = reason or "declared artifact missing, invalid, or exceeds byte budget"
            finally:
                os.close(output_fd)
        if artifacts:
            result["artifacts"] = artifacts
        if reason:
            result["error"] = reason
        atomic(directory / "state.json", {**record, "status": "SUCCEEDED" if code == 0 and reason is None else "FAILED", "result": result})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        worker(args.worker.resolve())
        return 0
    if not args.root or not args.config:
        parser.error("--root and --config are required")
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise ValueError("request too large")
    result = endpoint(args.root.resolve(), args.config.resolve(), json.loads(raw))
    sys.stdout.buffer.write(encoded(result) + b"\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError, TypeError, AttributeError):
        print("Invalid request, configuration, or durable record; operator reconciliation required", file=sys.stderr)
        raise SystemExit(64)
