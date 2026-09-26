#!/usr/bin/env python3
"""Freeze explicit files, build a deterministic source ZIP, verify SHA-256.

The manifest detects changes relative to itself; it is not a signed attestation.
Freeze is an explicit preparation step; build never discovers extra files implicitly.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import zipfile

TREES = {"src", "tests", "scripts", "examples", "docs", "docker", ".github", ".ai-loop", "evidence", "provenance", "compat"}
ROOT_FILES = {"README.md", "TEST_REPORT.md", "pyproject.toml", "requirements.lock", "requirements-dev.lock", ".gitignore", ".dockerignore", "NOTICE.md", "RELEASE-FILES.txt"}
IGNORED = {"__pycache__", ".pytest_cache", ".venv", "venv", "build", "dist", ".git", ".future-code", ".remember", ".env", ".ssh", ".aws", ".azure", ".gnupg"}
MANIFEST = "RELEASE-MANIFEST.json"


def relative(value: str) -> str:
    path = PurePosixPath(value)
    if not value or path.is_absolute() or any(p in {".", ".."} for p in value.split("/")) or "\\" in value or ":" in value or "\x00" in value or str(path) != value:
        raise ValueError("Unsafe manifest path")
    return value


def eligible(path: str) -> bool:
    p = PurePosixPath(path)
    if any(part in IGNORED or part.endswith(".egg-info") or part.startswith(".env.") for part in p.parts):
        return False
    return (len(p.parts) == 1 and path in ROOT_FILES) or (p.parts[0] in TREES and p.suffix not in {".pyc", ".pyo", ".zip", ".env", ".key", ".pem"})


def actual_files(root: Path) -> set[str]:
    return {p.relative_to(root).as_posix() for p in root.rglob("*") if (p.is_file() or p.is_symlink()) and eligible(p.relative_to(root).as_posix())}


def freeze(root: Path, output: Path) -> list[str]:
    names = sorted(actual_files(root) | {"RELEASE-FILES.txt"})
    for name in names:
        relative(name)
    output.write_text("\n".join(names) + "\n", encoding="utf-8")
    return names


def record(root: Path, name: str) -> dict:
    relative(name)
    path = root / name
    if path.is_symlink() or not path.is_file() or any(p.is_symlink() for p in path.parents if p != root.parent):
        raise ValueError("Missing, non-regular or symlink release member")
    data = path.read_bytes()
    return {"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def build(root: Path, file_list: Path, output: Path) -> dict:
    names = file_list.read_text(encoding="utf-8").splitlines()
    if not names or names != sorted(set(names)) or any(not eligible(n) or n == MANIFEST for n in names):
        raise ValueError("Frozen file list must be sorted, unique and allowlisted")
    manifest = {"schema_version": 1, "package": "future-code-control", "version": "1.2.0",
                "scope": "Companion, not a rebuilt original application", "files": [record(root, name) for name in names]}
    (root / MANIFEST).write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in names + [MANIFEST]:
            info = zipfile.ZipInfo("future-code-control-1.2.0/" + name, (2026, 9, 18, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, (root / name).read_bytes(), compresslevel=9)
    return {"verdict": "PASS", "members": len(names) + 1,
            "zip_sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "zip_bytes": output.stat().st_size}


def verify(root: Path, path: Path) -> dict:
    data = json.loads(path.read_text())
    if data.get("schema_version") != 1 or not isinstance(data.get("files"), list):
        raise ValueError("Invalid manifest schema")
    names = [r["path"] for r in data["files"]]
    if names != sorted(set(names)):
        raise ValueError("Manifest names must be sorted and unique")
    for expected in data["files"]:
        if record(root, expected["path"]) != expected:
            raise ValueError(f"Integrity mismatch: {expected['path']}")
    if actual_files(root) != set(names):
        raise ValueError("Unexpected or missing allowlisted release file")
    return {"verdict": "PASS", "files_verified": len(names), "scope": "Hashes and sizes relative to this unsigned manifest"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("freeze", "build", "verify"):
        p = sub.add_parser(name)
        p.add_argument("--root", type=Path, default=Path.cwd())
        if name == "verify":
            p.add_argument("--manifest", type=Path, default=Path(MANIFEST))
        else:
            p.add_argument("--output", type=Path, required=True)
            if name == "build":
                p.add_argument("--file-list", type=Path, default=Path("RELEASE-FILES.txt"))
    args = parser.parse_args()
    root = args.root.resolve()
    if args.command == "freeze":
        print(json.dumps({"files": len(freeze(root, args.output))}))
    elif args.command == "build":
        print(json.dumps(build(root, args.file_list, args.output)))
    else:
        print(json.dumps(verify(root, args.manifest)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
