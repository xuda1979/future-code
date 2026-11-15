#!/usr/bin/env python3
"""Publish and select complete, contract-bound checkpoint generations.

Only project code knows what a component means. It must supply every required
component with its actual completed step and verify its save/resume trajectory.
This helper freezes bytes and checks identities; it cannot infer a step from
arbitrary weights or execution state. No completed generation is overwritten or
deleted, and readers never combine components from different generations.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time
import uuid
from typing import Any


MAX_BYTES = 1024 ** 4
MAX_COMPONENTS = 32
MAX_GENERATIONS = 4096
MAX_MANIFEST = 65536
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate checkpoint manifest key")
        result[key] = value
    return result


def _json(raw: bytes) -> Any:
    def invalid(_value):
        raise ValueError("nonfinite checkpoint value")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique, parse_constant=invalid)


def _identity(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _name(name: str) -> None:
    if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name)
            or name == "manifest.json"):
        raise ValueError("invalid checkpoint component name")


def _contract(contract: str) -> None:
    if not isinstance(contract, str) or not re.fullmatch(r"[a-f0-9]{64}", contract):
        raise ValueError("checkpoint contract must be a SHA-256 identity")


def _step(step: int) -> None:
    if type(step) is not int or not 0 <= step <= 2 ** 53 - 1:
        raise ValueError("invalid completed checkpoint step")


def _budget(max_bytes: int) -> None:
    if type(max_bytes) is not int or not 1 <= max_bytes <= MAX_BYTES:
        raise ValueError("checkpoint byte budget must be 1 byte to 1 TiB")


def _check_deadline(deadline: float | None) -> None:
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError("checkpoint resolution exceeded job deadline")


def _open_component(directory_fd: int, path: str) -> int:
    """Open a relative regular file without following any symlink component."""
    if (not isinstance(path, str) or not path or "\0" in path or path.startswith("/")
            or any(part in ("", ".", "..") for part in path.split("/"))):
        raise ValueError("checkpoint component path must be relative without traversal")
    parts = path.split("/")
    parent = os.dup(directory_fd)
    try:
        for part in parts[:-1]:
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=parent)
            os.close(parent)
            parent = child
        fd = os.open(parts[-1], FILE_FLAGS, dir_fd=parent)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise ValueError("checkpoint component must be a regular file")
        return fd
    finally:
        os.close(parent)


def _sync_directory(path: Path) -> None:
    fd = os.open(path, DIRECTORY_FLAGS)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish_bundle(root: Path, source: Path, step: int, contract: str,
                   components: dict[str, dict[str, Any]], *, max_bytes: int = MAX_BYTES) -> Path:
    """Snapshot same-step components, fsync, and atomically publish one directory.

    ``components`` maps logical names to ``{"path": relative_path, "step": n}``.
    Step declarations must all match. Interrupted staging directories are ignored
    by readers. The caller retains responsibility for truthful component steps.
    """
    _contract(contract)
    _step(step)
    _budget(max_bytes)
    if not isinstance(components, dict) or not 1 <= len(components) <= MAX_COMPONENTS:
        raise ValueError("checkpoint needs 1 to 32 components")
    for name, component in components.items():
        _name(name)
        if not isinstance(component, dict) or set(component) != {"path", "step"}:
            raise ValueError("invalid checkpoint component declaration")
        _step(component["step"])
        if component["step"] != step:
            raise ValueError("checkpoint components have different completed steps")
    root, source = Path(root).absolute(), Path(source).absolute()
    source_fd = os.open(source, DIRECTORY_FLAGS)
    sources: dict[str, tuple[int, os.stat_result]] = {}
    pending = None
    try:
        total = 0
        for name, component in components.items():
            fd = _open_component(source_fd, component["path"])
            before = os.fstat(fd)
            sources[name] = (fd, before)
            total += before.st_size
            if total > max_bytes:
                raise ValueError("checkpoint exceeds byte budget")
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        root_fd = os.open(root, DIRECTORY_FLAGS)
        os.close(root_fd)
        generation = uuid.uuid4().hex
        pending = root / f".pending-{generation}"
        pending.mkdir(mode=0o700)
        files = {}
        for name, (fd, before) in sources.items():
            size, checksum = 0, hashlib.sha256()
            with os.fdopen(os.dup(fd), "rb") as inp, open(pending / name, "xb") as out:
                os.chmod(pending / name, 0o600)
                while chunk := inp.read(1024 * 1024):
                    size += len(chunk)
                    if size > before.st_size:
                        raise ValueError("checkpoint source grew during publication")
                    out.write(chunk)
                    checksum.update(chunk)
                out.flush()
                os.fsync(out.fileno())
            if size != before.st_size:
                raise ValueError("checkpoint source changed during publication")
            files[name] = {"step": step, "bytes": size, "sha256": checksum.hexdigest()}
        # Check ALL sources after ALL copying, not just each file in isolation.
        for name, (fd, before) in sources.items():
            check_fd = _open_component(source_fd, components[name]["path"])
            try:
                if _identity(before) != _identity(os.fstat(fd)) or _identity(before) != _identity(os.fstat(check_fd)):
                    raise ValueError("checkpoint source changed during publication")
            finally:
                os.close(check_fd)
        manifest = {"schema": 1, "contract": contract, "step": step, "files": files}
        with open(pending / "manifest.json", "xb") as out:
            os.chmod(pending / "manifest.json", 0o600)
            out.write(json.dumps(manifest, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())
            out.flush()
            os.fsync(out.fileno())
        _sync_directory(pending)
        destination = root / f"checkpoint-{step}-{generation}"
        if destination.exists():
            raise FileExistsError("checkpoint generation already exists")
        os.rename(pending, destination)
        pending = None
        _sync_directory(root)
        return destination
    finally:
        for fd, _info in sources.values():
            os.close(fd)
        os.close(source_fd)
        if pending is not None:
            # Only our unpublished staging directory; never a completed bundle.
            shutil.rmtree(pending)


def _manifest(directory_fd: int) -> dict[str, Any]:
    fd = _open_component(directory_fd, "manifest.json")
    with os.fdopen(fd, "rb") as source:
        if os.fstat(source.fileno()).st_size > MAX_MANIFEST:
            raise ValueError("checkpoint manifest exceeds byte budget")
        data = source.read(MAX_MANIFEST + 1)
        if len(data) > MAX_MANIFEST:
            raise ValueError("checkpoint manifest exceeds byte budget")
        return _json(data)


def resolve_bundle(root: Path, contract: str, required_components: list[str], *,
                   max_bytes: int = MAX_BYTES, deadline: float | None = None) -> dict[str, Any] | None:
    """Select newest valid complete same-contract bundle; never mix generations.

    Returns ``{path, step, contract, files}``, or None if no complete generation
    validates. Corrupt/partial/foreign candidates do not invalidate an older
    complete generation. Names are deliberately irrelevant to discovery.
    ``deadline`` is an optional absolute monotonic deadline. Discovery and
    hashing check it between bounded reads and raise TimeoutError on expiry;
    an expired validation is never treated as a missing/corrupt checkpoint.
    """
    _contract(contract)
    _budget(max_bytes)
    if deadline is not None and (type(deadline) not in (int, float) or not math.isfinite(deadline)):
        raise ValueError("checkpoint deadline must be a finite monotonic timestamp")
    _check_deadline(deadline)
    if not isinstance(required_components, list) or not 1 <= len(required_components) <= MAX_COMPONENTS:
        raise ValueError("checkpoint needs 1 to 32 distinct component names")
    for name in required_components:
        _name(name)
    if len(set(required_components)) != len(required_components):
        raise ValueError("checkpoint needs distinct component names")
    root = Path(root).absolute()
    try:
        root_fd = os.open(root, DIRECTORY_FLAGS)
    except FileNotFoundError:
        return None
    candidates = []
    try:
        entries = os.listdir(root_fd)
        _check_deadline(deadline)
        if len(entries) > MAX_GENERATIONS:
            raise ValueError("checkpoint generation inventory exceeds limit")
        for name in entries:
            _check_deadline(deadline)
            if name.startswith(".pending-"):
                continue
            directory_fd = None
            try:
                directory_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=root_fd)
                manifest = _manifest(directory_fd)
                if not isinstance(manifest, dict) or set(manifest) != {"schema", "contract", "step", "files"}:
                    continue
                if type(manifest["schema"]) is not int or manifest["schema"] != 1 or manifest["contract"] != contract:
                    continue
                _step(manifest["step"])
                files = manifest["files"]
                if not isinstance(files, dict) or set(files) != set(required_components):
                    continue
                if set(os.listdir(directory_fd)) != {*required_components, "manifest.json"}:
                    continue
                # Validate metadata before expensive hashing.
                total = 0
                for component in files.values():
                    if (not isinstance(component, dict) or set(component) != {"step", "bytes", "sha256"}
                            or type(component["step"]) is not int or component["step"] != manifest["step"]
                            or type(component["bytes"]) is not int or component["bytes"] < 0):
                        raise ValueError("invalid checkpoint component metadata")
                    _contract(component["sha256"])
                    total += component["bytes"]
                if total > max_bytes:
                    continue
                candidates.append((manifest["step"], name, manifest))
            except TimeoutError:
                raise
            except (OSError, ValueError, TypeError, KeyError, RecursionError):
                continue
            finally:
                if directory_fd is not None:
                    os.close(directory_fd)
        # Stop hashing after the newest valid bundle, so old large weights are
        # not reread on every resume. Metadata is not a validity receipt.
        for _step_number, name, manifest in sorted(candidates, key=lambda row: (row[0], row[1]), reverse=True):
            _check_deadline(deadline)
            directory_fd = None
            resolved: dict[str, tuple[int, os.stat_result]] = {}
            try:
                directory_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=root_fd)
                directory_identity = _identity(os.fstat(directory_fd))
                if _manifest(directory_fd) != manifest or set(os.listdir(directory_fd)) != {*required_components, "manifest.json"}:
                    continue
                for component_name, meta in manifest["files"].items():
                    _check_deadline(deadline)
                    fd = _open_component(directory_fd, component_name)
                    before = os.fstat(fd)
                    resolved[component_name] = (fd, before)
                    # Retain the original descriptor until ALL components have
                    # been checked, so a later hash cannot hide an earlier
                    # component mutation or a path replacement.
                    with os.fdopen(os.dup(fd), "rb") as source:
                        if before.st_size != meta["bytes"]:
                            raise ValueError("checkpoint size mismatch")
                        checksum, size = hashlib.sha256(), 0
                        while True:
                            _check_deadline(deadline)
                            chunk = source.read(1024 * 1024)
                            _check_deadline(deadline)
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > meta["bytes"]:
                                raise ValueError("checkpoint grew while validating")
                            checksum.update(chunk)
                        if (_identity(before) != _identity(os.fstat(source.fileno())) or size != meta["bytes"]
                                or checksum.hexdigest() != meta["sha256"]):
                            raise ValueError("checkpoint integrity failure")
                if (_manifest(directory_fd) != manifest
                        or set(os.listdir(directory_fd)) != {*required_components, "manifest.json"}):
                    continue
                for component_name, (fd, before) in resolved.items():
                    _check_deadline(deadline)
                    current_fd = _open_component(directory_fd, component_name)
                    try:
                        if (_identity(before) != _identity(os.fstat(fd))
                                or _identity(before) != _identity(os.fstat(current_fd))):
                            raise ValueError("checkpoint changed while validating another component")
                    finally:
                        os.close(current_fd)
                if (directory_identity != _identity(os.fstat(directory_fd))
                        or directory_identity != _identity(os.stat(name, dir_fd=root_fd, follow_symlinks=False))):
                    raise ValueError("checkpoint directory replaced during validation")
                _check_deadline(deadline)
                return {"path": str(root / name), "step": manifest["step"], "contract": contract, "files": manifest["files"]}
            except TimeoutError:
                raise
            except (OSError, ValueError, TypeError, KeyError, RecursionError):
                continue
            finally:
                for fd, _before in resolved.values():
                    os.close(fd)
                if directory_fd is not None:
                    os.close(directory_fd)
        _check_deadline(deadline)
        return None
    finally:
        os.close(root_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="operation", required=True)
    publication = subcommands.add_parser("publish")
    publication.add_argument("--source", type=Path, required=True)
    publication.add_argument("--step", type=int, required=True)
    publication.add_argument("--components", type=Path, required=True)
    selection = subcommands.add_parser("resolve")
    selection.add_argument("--component", action="append", required=True)
    for command in (publication, selection):
        command.add_argument("--root", type=Path, required=True)
        command.add_argument("--contract", required=True)
        command.add_argument("--max-bytes", type=int, default=MAX_BYTES)
    args = parser.parse_args()
    if args.operation == "publish":
        raw = args.components.read_bytes()
        if len(raw) > MAX_MANIFEST:
            raise ValueError("checkpoint component declaration exceeds byte budget")
        result = {"path": str(publish_bundle(args.root, args.source, args.step, args.contract,
                                            _json(raw), max_bytes=args.max_bytes))}
    else:
        result = resolve_bundle(args.root, args.contract, args.component, max_bytes=args.max_bytes)
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, TypeError, KeyError, RecursionError) as error:
        print(f"Checkpoint rejected: {error}", file=sys.stderr)
        raise SystemExit(64)
