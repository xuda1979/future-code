"""Project-neutral local command stages and immutable prepared artifacts.

Optional adapters can amortize deterministic preparation across parameterized
checks. This module contains no domain registry, evidence parser or acceptance
policy. The caller freezes commands, dependencies and budgets; consumers must
recheck the published manifest before accepting results.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import time


def require(condition, message):
    if not condition:
        raise ValueError(message)


def file_identity(path, limit=None):
    # O_NONBLOCK prevents a malicious FIFO from hanging evidence collection.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        before = os.fstat(source.fileno())
        require(stat.S_ISREG(before.st_mode), "evidence must be a regular file")
        require(limit is None or before.st_size <= limit, "artifact exceeds budget")
        checksum, size = hashlib.sha256(), 0
        while chunk := source.read(65536):
            size += len(chunk)
            require(limit is None or size <= limit, "artifact exceeds budget")
            checksum.update(chunk)
        after = os.fstat(source.fileno())
        require((before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_size, after.st_mtime_ns, after.st_ctime_ns) and size == after.st_size,
                "input or evidence changed while hashing")
        return {"sha256": checksum.hexdigest(), "bytes": size}


def _kill_tree(child):
    # Inherit the host's process group: killing a Foundry check also kills tools.
    # Per-step deadlines kill descendants first without killing sibling seeds.
    try:
        if Path("/proc/self/stat").exists():
            parents = []
            for entry in Path("/proc").iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    parts = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
                    parents.append((int(entry.name), int(parts[1])))
                except (OSError, IndexError, ValueError):
                    pass
        else:
            rows = subprocess.check_output(["/bin/ps", "-eo", "pid=,ppid="], text=True, timeout=2, stderr=subprocess.DEVNULL)
            parents = [tuple(map(int, row.split())) for row in rows.splitlines()]
        owned = {child.pid}
        for _ in range(len(parents) + 1):
            more = {pid for pid, parent in parents if parent in owned}
            if more <= owned:
                break
            owned.update(more)
        for pid in sorted(owned - {child.pid}, reverse=True):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    try:
        child.kill()
    except ProcessLookupError:
        pass
    child.wait(timeout=5)


def _execute(argv, cwd, env, timeout, limit, log):
    started = time.monotonic()
    reason, size = None, 0
    child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    try:
        with open(log, "xb") as output:
            while selector.get_map():
                if time.monotonic() - started >= timeout:
                    reason = "TIMEOUT"
                    break
                for key, _ in selector.select(min(0.05, timeout)):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    remaining = max(0, limit - size)
                    output.write(chunk[:remaining])
                    size += len(chunk)
                    if size > limit:
                        reason = "OUTPUT_LIMIT"
                        break
                if reason:
                    break
        if reason:
            _kill_tree(child)
        else:
            try:
                child.wait(timeout=max(0.001, timeout - (time.monotonic() - started)))
            except subprocess.TimeoutExpired:
                reason = "TIMEOUT"
                _kill_tree(child)
        return {"code": child.returncode, "reason": reason, "elapsedMs": round((time.monotonic() - started) * 1000),
                "log": log.name, "truncated": size > limit}
    finally:
        if child.poll() is None:
            _kill_tree(child)
        selector.close()
        child.stdout.close()


def run_steps(steps, directory, env, bindings, deadline, output_limit):
    """Run already admitted argv, preserving the host process group and budget."""
    row = {"verdict": "PASS", "steps": [], "artifacts": {}}
    remaining = output_limit
    try:
        for index, step in enumerate(steps):
            left = deadline - time.monotonic()
            require(left > 0, "stage deadline exceeded")
            argv = list(step["argv"])
            for name, value in bindings.items():
                argv = [arg.replace("{" + name + "}", str(value)) for arg in argv]
            result = _execute(argv, directory, env, min(left, step["timeoutMs"] / 1000),
                              remaining, directory / f"step-{index}.log")
            row["steps"].append(result)
            meta = file_identity(directory / result["log"], output_limit)
            row["artifacts"][result["log"]] = meta
            remaining -= meta["bytes"]
            if result["reason"] or result["code"] != 0:
                row.update(verdict="UNKNOWN" if result["reason"] else "FAIL",
                           error=result["reason"] or "TOOL_EXIT",
                           diagnostic=(directory / result["log"]).read_text(errors="replace")[-2048:])
                break
    except Exception as error:
        row.update(verdict="UNKNOWN", error=f"{type(error).__name__}: {error}")
    return row


def artifact_path(directory, name):
    require(isinstance(name, str) and name and not name.startswith("/")
            and not any(c in name for c in ("\\", "\0", ":"))
            and all(p and p not in (".", "..") for p in name.split("/")), "unsafe prepared artifact path")
    path = (directory / name).resolve()
    require(path.is_relative_to(directory.resolve()), "prepared artifact escapes stage")
    return path


def prepare_stage(spec, directory, env, bindings, deadline, output_limit, artifact_limit):
    """Build once in a fresh directory and cold-publish only declared files.

    This is local, opt-in preparation, not a persistent cross-candidate cache.
    Every independent verification call must prepare its own stage.
    """
    directory.mkdir()
    work, published = directory / "work", directory / "published"
    work.mkdir()
    published.mkdir()
    env = {**env, "HOME": str(work), "TMPDIR": str(work)}
    row = run_steps(spec["steps"], work, env, {**bindings, "work": work}, deadline, output_limit)
    row.update(directory=str(directory), published=str(published), manifest={})
    if row["verdict"] != "PASS":
        return row
    try:
        total = 0
        for name in spec["artifacts"]:
            source, target = artifact_path(work, name), artifact_path(published, name)
            before = file_identity(source, artifact_limit)
            total += before["bytes"]
            require(total <= artifact_limit, "prepared artifacts exceed stage budget")
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(source, "rb") as src, open(target, "xb") as dst:
                while chunk := src.read(65536):
                    dst.write(chunk)
                    require(dst.tell() <= before["bytes"], "prepared artifact grew while copying")
            require(before == file_identity(target, artifact_limit) == file_identity(source, artifact_limit),
                    "prepared artifact changed while publishing")
            target.chmod(0o444 | (source.stat().st_mode & 0o111))
            row["manifest"][name] = before
    except Exception as error:
        row.update(verdict="UNKNOWN", error=f"{type(error).__name__}: {error}")
    return row


def prepared_unchanged(stage, artifact_limit):
    """Consumers cannot accept evidence from a missing, failed or changed stage."""
    if stage["verdict"] != "PASS" or not stage["manifest"]:
        return False
    try:
        return all(file_identity(artifact_path(Path(stage["published"]), name), artifact_limit) == meta
                   for name, meta in stage["manifest"].items())
    except (OSError, ValueError):
        return False
