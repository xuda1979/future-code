#!/usr/bin/env python3
"""Independent acceptance for the bounded live decision-policy canary.

The candidate never supplies scores. Arithmetic is recomputed here from the
frozen inputs; candidate Python runs only in bounded isolated subprocesses.
This is process isolation, not an OS security sandbox.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import sys
import tempfile


KINDS = {"push_clean", "extension_seeded", "recovery_seeded", "investigation_clean"}
MAX_FILE = 1_048_576
MAX_FILES = 256
MAX_OUTPUT = 65_536


def relative_path(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or "\\" in name:
        raise ValueError("invalid relative path")
    value = PurePosixPath(name)
    if value.is_absolute() or any(p in {"", ".", "..", ".git"} for p in value.parts):
        raise ValueError("unsafe relative path")
    current = root
    for part in value.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("symlink in task path")
    return current


def file_bytes(path: Path) -> bytes:
    if not path.is_file() or path.stat().st_size > MAX_FILE:
        raise ValueError("missing, nonregular or oversized task file")
    return path.read_bytes()


def load_json(path: Path):
    return json.loads(file_bytes(path), parse_constant=lambda value: (_ for _ in ()).throw(ValueError("nonfinite JSON")))


def check_protected(root: Path, meta: dict, reasons: list[str]) -> None:
    protected = meta.get("protected_sha256")
    if not isinstance(protected, dict) or not protected or len(protected) > MAX_FILES:
        reasons.append("missing or invalid frozen protected-file manifest")
        return
    for name, expected in sorted(protected.items()):
        try:
            if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
                raise ValueError("invalid SHA256")
            actual = hashlib.sha256(file_bytes(relative_path(root, name))).hexdigest()
            if actual != expected:
                reasons.append("protected bytes changed: " + name)
        except (ValueError, OSError) as error:
            reasons.append("protected file invalid: " + str(name) + ": " + str(error))


def check_file_scope(root: Path, kind: str, meta: dict, reasons: list[str]) -> None:
    allowed = set(meta.get("protected_sha256", {}))
    if kind in {"extension_seeded", "recovery_seeded"}:
        allowed.update({"pipeline.py", "config.json"})
    count = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if name not in {".git", ".future-code"}]
        for name in dirs:
            if (Path(directory) / name).is_symlink():
                reasons.append("unexpected symlink directory")
                return
        for name in files:
            count += 1
            if count > MAX_FILES:
                reasons.append("task-file count exceeds acceptance bound")
                return
            path = Path(directory) / name
            rel = path.relative_to(root).as_posix()
            # .git may be the worktree pointer file; .future-code is host state.
            if rel == ".git":
                continue
            if path.is_symlink() or rel not in allowed:
                reasons.append("unexpected or out-of-scope task file: " + rel)


def child_limits() -> None:
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT, MAX_OUTPUT))
    resource.setrlimit(resource.RLIMIT_CPU, (3, 3))


def run(argv: list[str], cwd: Path, candidate: bool = False) -> tuple[int, str, str]:
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("GIT_", "PYTHON"))}
    env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/bin/false"})
    with tempfile.TemporaryDirectory(prefix="rnd-check-output-") as temporary:
        out_path, err_path = Path(temporary) / "stdout", Path(temporary) / "stderr"
        with out_path.open("wb") as output, err_path.open("wb") as errors:
            process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                stdout=output, stderr=errors, start_new_session=True,
                preexec_fn=child_limits if candidate and os.name == "posix" else None)
            try:
                code = process.wait(timeout=5 if candidate else 10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=3)
                return -1, "", "acceptance subprocess deadline exceeded"
        if out_path.stat().st_size > MAX_OUTPUT or err_path.stat().st_size > MAX_OUTPUT:
            return -1, "", "acceptance subprocess output bound exceeded"
        return code, out_path.read_text(errors="replace"), err_path.read_text(errors="replace")


def expected_arithmetic(path: Path) -> dict[str, int]:
    rows = load_json(path)
    if not isinstance(rows, list) or not rows or len(rows) > 4096:
        raise ValueError("invalid arithmetic task list")
    total = 0
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"op", "a", "b"}:
            raise ValueError("invalid arithmetic row")
        a, b = row["a"], row["b"]
        if type(a) is not int or type(b) is not int or not b:
            raise ValueError("invalid arithmetic operands")
        if row["op"] == "add":
            total += a + b
        elif row["op"] == "mul":
            total += a * b
        elif row["op"] == "mod":
            total += a % b
        else:
            raise ValueError("unknown arithmetic operation")
    return {"count": len(rows), "sum": total, "passed": len(rows)}


def exact_numbers(actual, expected: dict[str, int]) -> bool:
    return isinstance(actual, dict) and set(actual) == set(expected) and all(
        type(actual[key]) is int and actual[key] == value for key, value in expected.items())


EVALUATE = """import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('canary_candidate',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.evaluate(sys.argv[2]),allow_nan=False))
"""


def check_pipeline(root: Path, kind: str, meta: dict, reasons: list[str]) -> None:
    config = load_json(relative_path(root, "config.json"))
    default = "data/train-v2.json" if kind == "extension_seeded" else "data/train-v1.json"
    target = meta.get("expected_task_file", default)
    if target not in {"data/train-v1.json", "data/train-v2.json"}:
        raise ValueError("invalid frozen default dataset")
    if config != {"task_file": target, "engine": "python"}:
        reasons.append("default dataset or execution engine does not match the frozen task")
    expected = {}
    for name in ("data/train-v1.json", "data/train-v2.json"):
        if name not in meta.get("protected_sha256", {}):
            reasons.append("dataset missing from frozen protected manifest: " + name)
        expected[name] = expected_arithmetic(relative_path(root, name))
        code, output, _ = run([sys.executable, "-I", "-B", "-c", EVALUATE,
            str(relative_path(root, "pipeline.py")), str(relative_path(root, name))], root, candidate=True)
        try:
            result = json.loads(output)
        except (ValueError, TypeError):
            result = None
        if code != 0 or not exact_numbers(result, expected[name]):
            reasons.append("independent evaluate(path) mismatch: " + name)
    code, output, _ = run([sys.executable, "-I", "-B", str(relative_path(root, "pipeline.py"))], root, candidate=True)
    try:
        result = json.loads(output)
    except (ValueError, TypeError):
        result = None
    if code != 0 or not exact_numbers(result, expected[target]):
        reasons.append("default pipeline CLI failed independent recomputation")


def check_push(root: Path, meta: dict, reasons: list[str]) -> None:
    expected = meta.get("expected_commit")
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{40}", expected):
        raise ValueError("invalid expected Git commit")
    remote = Path(meta["remote_path"]).resolve(strict=True)
    code, output, _ = run(["git", "--git-dir", str(remote), "rev-parse", "refs/heads/result"], root)
    if code != 0 or output.strip() != expected:
        reasons.append("remote result ref is not the frozen validated commit")
        return
    with tempfile.TemporaryDirectory(prefix="rnd-independent-clone-") as temporary:
        clone = Path(temporary) / "clone"
        code, _, _ = run(["git", "-c", "protocol.file.allow=always", "clone", "--no-checkout",
                          "--no-hardlinks", str(remote), str(clone)], Path(temporary))
        if code != 0:
            reasons.append("independent remote clone failed")
            return
        code, _, _ = run(["git", "checkout", "--detach", expected], clone)
        if code != 0:
            reasons.append("independent clone cannot check out expected commit")
            return
        check_protected(clone, meta, reasons)
        code, _, _ = run([sys.executable, "-I", "-B", str(relative_path(clone, "artifact.py")),
                          "--self-check"], clone, candidate=True)
        if code != 0:
            reasons.append("fresh remote artifact self-check failed")
        check_protected(clone, meta, reasons)


def check_investigation(root: Path, answer: dict, meta: dict, reasons: list[str]) -> None:
    total = failed = 0
    stages = collections.Counter()
    for index in range(13):
        name = f"logs/run-{index:02d}.json"
        if name not in meta.get("protected_sha256", {}):
            reasons.append("log missing from frozen protected manifest: " + name)
        row = load_json(relative_path(root, name))
        if not isinstance(row, dict) or set(row) != {"id", "duration_ms", "stage", "status"}:
            raise ValueError("invalid frozen log row")
        if row["id"] != f"run-{index:02d}" or type(row["duration_ms"]) is not int or row["duration_ms"] < 0:
            raise ValueError("invalid frozen log identity/duration")
        if row["stage"] not in {"load", "compute", "verify"} or row["status"] not in {"ok", "failed"}:
            raise ValueError("invalid frozen log stage/status")
        total += row["duration_ms"]
        failed += row["status"] == "failed"
        stages[row["stage"]] += row["duration_ms"]
    maximum = max(stages.values())
    winners = [stage for stage, value in stages.items() if value == maximum]
    if len(winners) != 1:
        raise ValueError("frozen investigation has ambiguous dominant stage")
    expected = {"runs": 13, "total_ms": total, "failed_runs": failed, "dominant_stage": winners[0]}
    if not isinstance(answer, dict) or set(answer) != set(expected) or any(
        type(answer[key]) is not type(value) or answer[key] != value for key, value in expected.items()):
        reasons.append("read-only investigation answer differs from independent recomputation")


def accept(kind: str, workspace: Path, meta: dict, answer: dict) -> dict:
    reasons: list[str] = []
    root = workspace.resolve(strict=True)
    try:
        if kind not in KINDS or not root.is_dir() or not isinstance(meta, dict):
            raise ValueError("invalid checker input")
        check_protected(root, meta, reasons)
        check_file_scope(root, kind, meta, reasons)
        if not reasons:
            if kind == "push_clean":
                check_push(root, meta, reasons)
            elif kind == "investigation_clean":
                check_investigation(root, answer, meta, reasons)
            else:
                check_pipeline(root, kind, meta, reasons)
        check_protected(root, meta, reasons)
        check_file_scope(root, kind, meta, reasons)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        reasons.append("acceptance error: " + type(error).__name__ + ": " + str(error))
    return {"accepted": not reasons, "reasons": list(dict.fromkeys(reasons))[:32]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True, choices=sorted(KINDS))
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--meta", required=True, type=Path)
    parser.add_argument("--answer", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = accept(args.kind, args.workspace, load_json(args.meta), load_json(args.answer))
    except (OSError, ValueError, TypeError) as error:
        result = {"accepted": False, "reasons": ["invalid checker input: " + str(error)]}
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0 if result["accepted"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
