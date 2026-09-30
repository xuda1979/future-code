#!/usr/bin/env python3
"""Trusted multi-host execution endpoint for Future-Code Swarm.

One JSON request on stdin -> one JSON reply on stdout. The operator fixes
--repo/--root/--config in the pinned adapter command (for example behind SSH).
Remote workers are disposable execution accelerators; they never certify PASS.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
from typing import Any

MAX_REQUEST = 64 * 1024 * 1024


def encoded(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def atomic(path: Path, value: Any) -> None:
    data = encoded(value)
    temp = path.with_name(path.name + f".{os.getpid()}.tmp")
    with open(temp, "xb") as out:
        os.chmod(temp, 0o600)
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, path)


def safe_rel(path: str) -> Path:
    if not isinstance(path, str) or not path or path.startswith("/") or "\x00" in path or "\\" in path or ":" in path:
        raise ValueError("unsafe path")
    parts = path.split("/")
    if any(not p or p in (".", "..", ".git", ".future-code") for p in parts):
        raise ValueError("unsafe path")
    return Path(*parts)


def in_scope(path: str, scopes: list[str]) -> bool:
    return any(path == scope or path.startswith(scope + "/") for scope in scopes)


def run(argv: list[str], cwd: Path, timeout_ms: int, max_bytes: int, stdin: bytes | None = None,
        env_allow: list[str] | None = None) -> dict[str, Any]:
    if not argv or not isinstance(argv[0], str) or not Path(argv[0]).is_absolute():
        raise ValueError("worker command must use absolute executable")
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(cwd),
        "TMPDIR": str(cwd),
        "TMP": str(cwd),
        "TEMP": str(cwd),
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
    }
    for name in env_allow or []:
        if name in os.environ:
            env[name] = os.environ[name]
    proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
    try:
        out, err = proc.communicate(stdin, timeout=max(0.001, timeout_ms / 1000))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        out, err = proc.communicate()
        return {"code": -1, "stdout": out[-max_bytes:].decode("utf-8", "replace"),
                "stderr": (err[-max_bytes:] + b"\nworker command deadline exceeded")[-max_bytes:].decode("utf-8", "replace")}
    total = len(out) + len(err)
    if total > max_bytes:
        return {"code": proc.returncode, "stdout": out[-max_bytes // 2:].decode("utf-8", "replace"),
                "stderr": (err[-max_bytes // 2:] + b"\nworker output exceeded byte budget")[-max_bytes:].decode("utf-8", "replace")}
    return {"code": proc.returncode, "stdout": out.decode("utf-8", "replace"), "stderr": err.decode("utf-8", "replace")}


GIT = shutil.which("git")
if not GIT:
    raise RuntimeError("git executable not found")


def git(repo: Path, args: list[str], timeout_ms: int = 30000, stdin: bytes | None = None) -> str:
    result = run([GIT, "--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                  "-c", "core.autocrlf=false", *args], repo, timeout_ms, 16 * 1024 * 1024, stdin)
    if result["code"] != 0:
        raise ValueError(f"git {args[0]} failed: {result['stderr'][-1200:]}")
    return result["stdout"]


def load_template(path: Path) -> dict[str, Any]:
    cfg = read_json(path)
    if not isinstance(cfg, dict) or set(cfg) - {"checks"}:
        raise ValueError("invalid worker template")
    checks = cfg.get("checks", {})
    if not isinstance(checks, dict):
        raise ValueError("invalid worker checks")
    for name, spec in checks.items():
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", name) or not isinstance(spec, dict):
            raise ValueError("invalid worker check")
        if set(spec) - {"argv", "envAllow"}:
            raise ValueError("invalid worker check")
        argv = spec.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(x, str) and x and "\x00" not in x for x in argv):
            raise ValueError("invalid worker check argv")
        if not Path(argv[0]).is_absolute():
            raise ValueError("worker check executable must be absolute")
        env = spec.get("envAllow", [])
        if not isinstance(env, list) or not all(isinstance(x, str) and re.fullmatch(r"[A-Z_][A-Z0-9_]*", x) for x in env):
            raise ValueError("invalid worker check envAllow")
        if any(x.startswith(("LD_", "DYLD_", "NODE_OPTIONS", "PYTHONPATH")) for x in env):
            raise ValueError("unsafe worker check envAllow")
    return cfg


def state_dir(root: Path, workspace: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{64}", workspace):
        raise ValueError("invalid workspace")
    return root / workspace


def check_no_symlinks(tree: Path, rel: Path) -> None:
    current = tree
    for part in rel.parts:
        current = current / part
        if current.exists() and current.is_symlink():
            raise ValueError("symlink access forbidden")


def prepare(root: Path, repo: Path, request: dict[str, Any]) -> dict[str, Any]:
    workspace = request.get("workspace")
    directory = state_dir(root, workspace)
    tree = directory / "tree"
    binding = encoded({k: request.get(k) for k in (
        "baseCommit", "dependencyPatches", "restorePatch", "task", "protectedPaths", "allowedChecks", "limits"
    )}).hex()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(root / "registry.lock", "a+b") as registry:
        fcntl.flock(registry, fcntl.LOCK_EX)
        state_path = directory / "state.json"
        if state_path.exists():
            state = read_json(state_path)
            if state.get("binding") != binding:
                raise ValueError("workspace binding drift")
            if tree.exists():
                return {"ok": True, "result": {"workspace": workspace, "reused": True}}
        if tree.exists():
            shutil.rmtree(tree)
        git(repo, ["cat-file", "-e", f"{request['baseCommit']}^{{commit}}"])
        git(repo, ["worktree", "add", "--detach", str(tree), request["baseCommit"]])
        try:
            for patch in request.get("dependencyPatches", []):
                if not isinstance(patch, str):
                    raise ValueError("invalid dependency patch")
                if patch:
                    git(tree, ["apply", "--index", "--whitespace=nowarn", "-"], stdin=patch.encode())
            # The worker's own patch must exclude already-verified dependency
            # changes. Pin their composed tree before applying the task's
            # resumable patch.
            base_tree = git(tree, ["write-tree"]).strip()
            restore = request.get("restorePatch")
            if restore:
                if not isinstance(restore, str):
                    raise ValueError("invalid restore patch")
                git(tree, ["apply", "--index", "--whitespace=nowarn", "-"], stdin=restore.encode())
            prepared = {**request, "baseTree": base_tree}
            atomic(state_path, {"binding": binding, "request": prepared, "created": time.time()})
        except Exception:
            try:
                git(repo, ["worktree", "remove", "--force", str(tree)])
            except Exception:
                pass
            shutil.rmtree(directory, ignore_errors=True)
            raise
    return {"ok": True, "result": {"workspace": workspace, "reused": False}}


def context(root: Path, workspace: str) -> tuple[Path, dict[str, Any]]:
    directory = state_dir(root, workspace)
    state = read_json(directory / "state.json")
    tree = directory / "tree"
    if not tree.exists():
        raise ValueError("workspace missing")
    return tree, state["request"]


def tool(root: Path, template: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    tree, prepared = context(root, request["workspace"])
    call = request.get("call")
    if not isinstance(call, dict) or not isinstance(call.get("name"), str) or not isinstance(call.get("arguments"), dict):
        raise ValueError("invalid tool call")
    name = call["name"]
    args = call["arguments"]
    task = prepared["task"]
    write_scope = task.get("writeScope", [])
    read_scope = [*write_scope, *task.get("readScope", [])]
    protected = prepared.get("protectedPaths", [])
    limits = prepared["limits"]
    max_out = limits["maxToolOutputBytes"]
    timeout = limits["toolTimeoutMs"]

    if name == "list_files":
        offset = args.get("offset", 0)
        limit = args.get("limit", 100)
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("invalid listing range")
        names = git(tree, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0")
        files = sorted({p for p in names if p and in_scope(p, read_scope)})
        return {"ok": True, "result": {"files": files[offset:offset + limit], "total": len(files)}}

    if name in ("read_file", "write_file", "edit_file", "delete_file"):
        path = args.get("path")
        rel = safe_rel(path)
        scopes = write_scope if name != "read_file" else read_scope
        if not in_scope(path, scopes):
            raise ValueError("path outside task scope")
        if name != "read_file" and any(in_scope(path, [p]) or in_scope(p, [path]) for p in protected):
            raise ValueError("protected path")
        check_no_symlinks(tree, rel)
        target = tree / rel
        if name == "read_file":
            start = args.get("start", 1)
            count = args.get("lines", 100)
            if type(start) is not int or start <= 0 or type(count) is not int or not 1 <= count <= 300:
                raise ValueError("invalid line range")
            if not target.is_file() or target.stat().st_size > max_out:
                raise ValueError("file too large or not regular")
            data = target.read_bytes()
            if b"\x00" in data:
                raise ValueError("binary file unsupported")
            text = data.decode("utf-8")
            lines = text.split("\n")
            return {"ok": True, "result": {"path": path, "start": start, "totalLines": len(lines),
                                             "content": "\n".join(lines[start - 1:start - 1 + count])}}
        if name == "delete_file":
            if not target.is_file():
                raise ValueError("not a regular file")
            target.unlink()
            return {"ok": True, "result": {"path": path, "deleted": True}}
        if name == "write_file":
            content = args.get("content")
            if not isinstance(content, str):
                raise ValueError("content must be text")
        else:
            old = args.get("oldText")
            new = args.get("newText")
            if not isinstance(old, str) or not old or not isinstance(new, str):
                raise ValueError("invalid literal edit")
            content = target.read_text()
            if content.count(old) != 1:
                raise ValueError("edit requires exactly one match")
            content = content.replace(old, new, 1)
        if "\x00" in content or len(content.encode()) > max_out:
            raise ValueError("file exceeds text budget")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        git(tree, ["add", "-f", "--", path])
        return {"ok": True, "result": {"path": path, "bytes": len(content.encode()), "changed": True}}

    if name == "run_check":
        check_name = args.get("name")
        if check_name not in prepared.get("allowedChecks", []):
            raise ValueError("check not permitted")
        spec = template.get("checks", {}).get(check_name)
        if not spec:
            raise ValueError("worker check not configured")
        result = run(spec["argv"], tree, timeout, max_out, env_allow=spec.get("envAllow", []))
        return {"ok": True, "result": result}

    raise ValueError("unknown remote tool")


def snapshot(root: Path, request: dict[str, Any]) -> dict[str, Any]:
    tree, prepared = context(root, request["workspace"])
    max_patch = prepared["limits"]["maxPatchBytes"]
    git(tree, ["add", "-A", "--", "."])
    base_tree = prepared["baseTree"]
    names = git(tree, ["diff", "--cached", "--no-renames", "--name-only", "-z", base_tree]).split("\0")
    for name in filter(None, names):
        safe_rel(name)
        if not in_scope(name, prepared["task"].get("writeScope", [])):
            raise ValueError(f"patch scope violation: {name}")
        if any(in_scope(name, [p]) or in_scope(p, [name]) for p in prepared.get("protectedPaths", [])):
            raise ValueError("protected patch path")
        check_no_symlinks(tree, safe_rel(name))
    patch = git(tree, ["diff", "--cached", "--no-ext-diff", "--no-renames", "--binary", base_tree])
    if len(patch.encode()) > max_patch:
        raise ValueError("patch exceeds budget")
    return {"ok": True, "patch": patch}


def dispose(root: Path, repo: Path, workspace: str) -> dict[str, Any]:
    directory = state_dir(root, workspace)
    tree = directory / "tree"
    with open(root / "registry.lock", "a+b") as registry:
        fcntl.flock(registry, fcntl.LOCK_EX)
        if tree.exists():
            try:
                git(repo, ["worktree", "remove", "--force", str(tree)])
            except Exception:
                return {"ok": False, "error": "remote worktree cleanup failed; preserved for inspection"}
        shutil.rmtree(directory, ignore_errors=True)
    return {"ok": True, "result": {"disposed": True}}


def endpoint(root: Path, repo: Path, template: dict[str, Any], request: Any) -> dict[str, Any]:
    if not isinstance(request, dict) or request.get("schema") != 1:
        raise ValueError("invalid request")
    op = request.get("op")
    if op == "prepare":
        return prepare(root, repo, request)
    if op == "tool":
        return tool(root, template, request)
    if op == "snapshot":
        return snapshot(root, request)
    if op == "dispose":
        return dispose(root, repo, request.get("workspace"))
    raise ValueError("unknown operation")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    repo = args.repo.resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not (repo / ".git").exists():
        raise ValueError("worker repo must be a Git repository")
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise ValueError("request too large")
    request = json.loads(raw)
    template = load_template(args.config.resolve())
    try:
        reply = endpoint(root, repo, template, request)
    except Exception as exc:
        reply = {"ok": False, "error": str(exc)[:2048]}
    sys.stdout.buffer.write(encoded(reply) + b"\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f"worker endpoint failure: {str(exc)[:512]}", file=sys.stderr)
        raise SystemExit(64)
