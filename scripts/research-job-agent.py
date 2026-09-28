#!/usr/bin/env python3
"""Trusted POSIX job endpoint for SSH or local adapters; standard library only.

stdin: one schema-1 ensure/inspect request; stdout: one JobReply.
The operator pins an argv template in --config. Model input is DATA, never a
command. Not a sandbox. Lost worker ownership becomes UNKNOWN, not a rerun.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
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
    if not isinstance(cfg, dict) or set(cfg) - {"argv", "cwd", "timeoutMs", "envAllow"}:
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
    if any(n.startswith(("LD_", "DYLD_", "NODE_OPTIONS", "PYTHONPATH")) for n in env):
        raise ValueError("loader environment must not be forwarded")
    return cfg


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
    if request.get("operation") not in ("ensure", "inspect"):
        raise ValueError("unsupported operation")
    if request.get("jobId") not in (None, key):
        raise ValueError("job identity mismatch")
    if request.get("operation") == "inspect" and request.get("jobId") != key:
        raise ValueError("inspect needs a known job ID")
    cfg = template(config)
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
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
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
        tails: dict[str, bytes] = {"stdout": b"", "stderr": b""}

        def drain(stream: Any, name: str) -> None:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                tails[name] = (tails[name] + chunk)[-65536:]
            stream.close()

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
        result = {"exitCode": code, "durationMs": round((time.monotonic() - started) * 1000),
                  "configurationHash": hashlib.sha256(encoded(cfg)).hexdigest(),
                  "stdoutTail": tails["stdout"][-4096:].decode("utf-8", errors="replace"),
                  "stderrTail": tails["stderr"][-4096:].decode("utf-8", errors="replace")}
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
    except (ValueError, OSError, KeyError, TypeError):
        print("Invalid request, configuration, or durable record; operator reconciliation required", file=sys.stderr)
        raise SystemExit(64)
