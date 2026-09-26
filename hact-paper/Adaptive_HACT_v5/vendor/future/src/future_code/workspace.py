"""Staged project edits and recoverable, optimistic file integration.

Directories are private to one attempt. Only named write scopes can be integrated.
POSIX atomic replacement is per-file; the durable journal supplies multi-file recovery,
not a claim of a filesystem-wide atomic transaction.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
from typing import TYPE_CHECKING

from .contracts import Config, ConflictError, ContractError, TaskSpec, is_secret_path, relative_path, within_scope
from .security import atomic_write, ensure_control

if TYPE_CHECKING:
    from .store import Store


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_hash(path: Path) -> str | None:
    if path.is_symlink():
        raise ContractError("Symlinks are not supported in managed file operations")
    return digest(path.read_bytes()) if path.is_file() else None


def safe_path(root: Path, relative: str) -> Path:
    relative = relative_path(relative)
    path = root
    for part in relative.split("/"):
        path = path / part
        if path.is_symlink():
            raise ContractError("Symlink traversal is forbidden")
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError as e:
        raise ContractError("Path escapes project root") from e
    return path


def inventory(root: Path, config: Config) -> tuple[dict[str, str], list[dict]]:
    hashes: dict[str, str] = {}
    omitted: list[dict] = []
    total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in config.ignored_dirs and
                         not is_secret_path((Path(directory) / d).relative_to(root).as_posix()) and
                         not (Path(directory) / d).is_symlink())
        for filename in sorted(files):
            p = Path(directory) / filename
            rel = p.relative_to(root).as_posix()
            if is_secret_path(rel) or filename in config.ignored_dirs or filename == ".fc-owned.json":
                continue
            if p.is_symlink() or not p.is_file():
                omitted.append({"path": rel, "reason": "not a regular file"})
                continue
            size = p.stat().st_size
            if size > config.max_file_bytes:
                omitted.append({"path": rel, "reason": "file size limit"})
                continue
            total += size
            if total > config.max_workspace_bytes:
                raise ContractError("Project snapshot exceeds configured workspace byte limit; narrow the project")
            hashes[rel] = file_hash(p)
    return hashes, omitted


def inventory_hash(hashes: dict[str, str]) -> str:
    return digest(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode())


class Workspace:
    def __init__(self, root: Path, task: TaskSpec, attempt_id: str, config: Config):
        import re
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}", attempt_id):
            raise ContractError("Invalid attempt id")
        self.root = root.resolve()
        self.task = task
        self.config = config
        self.attempt_id = attempt_id
        self.control = ensure_control(self.root)
        self.path = safe_path(self.control, f"workspaces/{attempt_id}")
        self.artifacts = safe_path(self.control, f"artifacts/{attempt_id}")
        self.base: dict[str, str] = {}
        self.read_set: dict[str, str | None] = {}
        self.omitted: list[dict] = []

    def prepare(self) -> None:
        if self.path.exists():
            raise ContractError("Attempt workspace already exists; refusing to overwrite evidence")
        self.path.mkdir(mode=0o700)
        self.artifacts.mkdir(mode=0o700)
        atomic_write(self.path / ".fc-owned.json", json.dumps({"task_id": self.task.id, "attempt_id": self.attempt_id}).encode())
        self.base, self.omitted = inventory(self.root, self.config)
        for rel, expected in self.base.items():
            src, dst = safe_path(self.root, rel), safe_path(self.path, rel)
            data = src.read_bytes()
            if digest(data) != expected:
                raise ConflictError("Project changed during snapshot creation")
            atomic_write(dst, data, mode=stat.S_IMODE(src.stat().st_mode) & 0o777)
        atomic_write(self.artifacts / "snapshot.json", json.dumps({"base": self.base, "omitted": self.omitted}, sort_keys=True).encode())

    def _allowed(self, rel: str, *, write: bool = False) -> str:
        rel = relative_path(rel)
        if is_secret_path(rel) or rel == ".fc-owned.json":
            raise ContractError("Secret and runtime-control files are inaccessible")
        if write:
            if not within_scope(rel, self.task.write_scope):
                raise ContractError("Write is outside the task's leased scope")
            protected = self.config.protected_paths + [p for gate in self.config.gates.values() for p in gate.protected_inputs]
            if within_scope(rel, protected):
                raise ContractError("Protected acceptance inputs cannot be edited")
            if rel not in self.base and safe_path(self.root, rel).exists():
                raise ContractError("Existing file was omitted from snapshot; cannot overwrite it")
        safe_path(self.path, rel)
        safe_path(self.root, rel)
        return rel

    def read(self, rel: str, *, start_line: int = 1, max_lines: int = 120) -> dict:
        rel = self._allowed(rel)
        if type(start_line) is not int or start_line < 1 or type(max_lines) is not int or not 1 <= max_lines <= 300:
            raise ContractError("Read range must start at >=1 and contain 1..300 lines")
        p = safe_path(self.path, rel)
        if not p.is_file() or p.stat().st_size > self.config.max_file_bytes:
            raise ContractError("File unavailable or too large")
        self.read_set.setdefault(rel, self.base.get(rel))
        try:
            text = p.read_text(encoding="utf-8")
        except UnicodeError as e:
            raise ContractError("Read tool accepts UTF-8 text, not binary data") from e
        lines = text.splitlines()
        selected = "\n".join(f"{i+1}: {line}" for i, line in enumerate(lines) if start_line <= i + 1 < start_line + max_lines)
        return {"path": rel, "content": selected[:10000], "total_lines": len(lines),
                "truncated": len(selected) > 10000 or start_line + max_lines <= len(lines)}

    def list_files(self, prefix: str = "", *, limit: int = 300) -> dict:
        if prefix:
            prefix = relative_path(prefix)
            if is_secret_path(prefix):
                raise ContractError("Secret paths are inaccessible")
        current, omitted = inventory(self.path, self.config)
        names = [p for p in sorted(current) if not prefix or p == prefix or p.startswith(prefix + "/")]
        return {"files": names[:limit], "total": len(names), "truncated": len(names) > limit, "omitted_count": len(omitted) + len(self.omitted)}

    def search(self, query: str, prefix: str = "") -> dict:
        if not isinstance(query, str) or not 1 <= len(query) <= 200:
            raise ContractError("Search query must contain 1..200 characters")
        names = self.list_files(prefix, limit=2000)["files"]
        hits = []
        for rel in names:
            try:
                text = safe_path(self.path, rel).read_text(encoding="utf-8")
            except UnicodeError:
                continue
            self.read_set.setdefault(rel, self.base.get(rel))
            for i, line in enumerate(text.splitlines(), 1):
                if query in line:
                    hits.append({"path": rel, "line": i, "text": line[:300]})
                    if len(hits) == 40:
                        return {"matches": hits, "truncated": True}
        return {"matches": hits, "truncated": False}

    def write(self, rel: str, content: str) -> dict:
        rel = self._allowed(rel, write=True)
        if not isinstance(content, str):
            raise ContractError("File content must be text")
        data = content.encode("utf-8")
        if len(data) > self.config.max_file_bytes:
            raise ContractError("Write exceeds file byte limit")
        p = safe_path(self.path, rel)
        mode = stat.S_IMODE(p.stat().st_mode) & 0o777 if p.exists() else 0o644
        atomic_write(p, data, mode=mode)
        return {"path": rel, "sha256": digest(data), "bytes": len(data), "location": "staged_only"}

    def changes(self) -> dict[str, str]:
        current, omitted = inventory(self.path, self.config)
        if omitted:
            raise ContractError("Workspace contains oversized, special or symlink files")
        deleted = self.base.keys() - current.keys()
        if deleted:
            raise ContractError("Source deletion is not authorized; restore removed files")
        changed = {p: h for p, h in current.items() if self.base.get(p) != h}
        for rel in changed:
            self._allowed(rel, write=True)
        # Command adapters must not smuggle secret/control files into an integration.
        return changed

    def fingerprint(self) -> str:
        hashes, omitted = inventory(self.path, self.config)
        if omitted:
            raise ContractError("Cannot authenticate an incomplete workspace")
        return inventory_hash(hashes)

    def refresh_for_commit(self) -> dict[str, str]:
        changes = self.changes()
        for rel in set(changes) | set(self.read_set):
            if file_hash(safe_path(self.root, rel)) != self.base.get(rel):
                raise ConflictError(f"Read/write conflict on {rel}; regenerate against current source")
        fresh, omitted = inventory(self.root, self.config)
        # Rebase untouched files, then execute gates against the combined current tree.
        for rel in self.base.keys() - fresh.keys():
            if rel not in changes:
                safe_path(self.path, rel).unlink(missing_ok=True)
        for rel, expected in fresh.items():
            if rel not in changes:
                src = safe_path(self.root, rel)
                data = src.read_bytes()
                if digest(data) != expected:
                    raise ConflictError("Project changed during integration rebase")
                atomic_write(safe_path(self.path, rel), data, mode=stat.S_IMODE(src.stat().st_mode) & 0o777)
        self.base, self.omitted = fresh, omitted
        return fresh

    def commit(self, db: Store, fence: int, result: dict, *, verified_fingerprint: str, expected_root: dict[str, str]) -> str:
        db.assert_owner(self.task.id, fence)
        if self.fingerprint() != verified_fingerprint:
            raise ConflictError("Staged files changed after verification")
        current, _ = inventory(self.root, self.config)
        if current != expected_root:
            raise ConflictError("Project changed while acceptance gates were running")
        changes = self.changes()
        records = []
        for index, (rel, after) in enumerate(sorted(changes.items())):
            src = safe_path(self.path, rel)
            payload_rel = f"artifacts/{self.attempt_id}/change-{index}.bin"
            data = src.read_bytes()
            if digest(data) != after:
                raise ConflictError("Staged file changed while preparing integration")
            atomic_write(safe_path(self.control, payload_rel), data)
            before = self.base.get(rel)
            if before is not None:
                atomic_write(self.artifacts / f"before-{index}.bin", safe_path(self.root, rel).read_bytes())
            records.append({"path": rel, "before": before, "after": after, "payload": payload_rel,
                            "mode": stat.S_IMODE(src.stat().st_mode) & 0o777})
        manifest = {"version": 1, "attempt_id": self.attempt_id, "root_base": self.base,
                    "verified_fingerprint": verified_fingerprint, "files": records,
                    "write_scope": self.task.write_scope}
        atomic_write(self.artifacts / "integration.json", json.dumps(manifest, sort_keys=True, indent=2).encode())
        result = dict(result, artifacts=[{"path": r["path"], "sha256": r["after"]} for r in records])
        journal_id = db.prepare_integration(self.task.id, fence, manifest, result)
        apply_journal(self.root, self.control, manifest, self.config, self.task)
        db.complete_integration(journal_id)
        return journal_id

    def cleanup(self) -> None:
        marker = safe_path(self.path, ".fc-owned.json")
        if not marker.is_file() or json.loads(marker.read_text()).get("attempt_id") != self.attempt_id:
            raise ContractError("Workspace ownership marker missing or mismatched; cleanup refused")
        if self.path.parent != self.control / "workspaces" or self.path.is_symlink():
            raise ContractError("Unsafe cleanup target")
        shutil.rmtree(self.path)


def apply_journal(root: Path, control: Path, manifest: dict, config: Config, task: TaskSpec) -> None:
    if manifest.get("version") != 1 or manifest.get("write_scope") != task.write_scope:
        raise ContractError("Invalid integration manifest")
    files = manifest.get("files", [])
    paths = [record["path"] for record in files]
    if len(paths) != len(set(paths)):
        raise ContractError("Duplicate paths in integration journal")
    current, _ = inventory(root, config)
    normalized = dict(current)
    pending: list[tuple[Path, bytes, int]] = []
    reconstructed = dict(manifest["root_base"])
    protected = config.protected_paths + [p for gate in config.gates.values() for p in gate.protected_inputs]
    for record in files:
        rel = relative_path(record["path"])
        if is_secret_path(rel) or not within_scope(rel, task.write_scope) or within_scope(rel, protected):
            raise ContractError("Journal tries to modify forbidden path")
        path = safe_path(root, rel)
        actual = file_hash(path)
        if actual not in {record["before"], record["after"]}:
            raise ConflictError(f"Cannot replay integration: external modification at {rel}")
        payload_rel = relative_path(record["payload"])
        if not payload_rel.startswith(f"artifacts/{manifest['attempt_id']}/"):
            raise ContractError("Journal payload escapes attempt artifact directory")
        payload = safe_path(control, payload_rel)
        if not payload.is_file() or payload.stat().st_size > config.max_file_bytes:
            raise ContractError("Integration payload missing or oversized")
        data = payload.read_bytes()
        if digest(data) != record["after"]:
            raise ContractError("Integration payload checksum mismatch")
        if record["before"] is None:
            normalized.pop(rel, None)
        else:
            normalized[rel] = record["before"]
        reconstructed[rel] = record["after"]
        if actual != record["after"]:
            pending.append((path, data, int(record["mode"]) & 0o777))
    if normalized != manifest["root_base"]:
        raise ConflictError("Unrelated project files changed since verification; integration requires review")
    if inventory_hash(reconstructed) != manifest.get("verified_fingerprint"):
        raise ContractError("Integration fingerprint does not authenticate reconstructed output")
    # All payloads and destinations are authenticated before the first side effect.
    for path, data, mode in pending:
        atomic_write(path, data, mode=mode)


def recover_integrations(root: Path, db: Store, config: Config) -> list[dict]:
    control = ensure_control(root)
    results = []
    for journal in db.rows("SELECT * FROM integrations WHERE status='prepared' ORDER BY created_at,id"):
        try:
            spec = TaskSpec.from_dict(db.task(journal["task_id"])["spec"])
            apply_journal(root, control, json.loads(journal["manifest"]), config, spec)
            db.complete_integration(journal["id"], recovery=True)
            results.append({"id": journal["id"], "status": "recovered"})
        except (ContractError, OSError, KeyError, TypeError, ValueError) as e:
            detail = f"Integration recovery refused: {type(e).__name__}: {e}"
            db.block_integration(journal["id"], detail)
            results.append({"id": journal["id"], "status": "blocked"})
    return results


def hygiene_scan(root: Path, config: Config) -> list[dict]:
    hashes, omitted = inventory(root, config)
    findings = list(omitted)
    for rel in sorted(hashes):
        p = Path(rel)
        if p.suffix in {".tmp", ".bak", ".orig", ".rej"} or p.name.startswith("scratch_"):
            findings.append({"path": rel, "reason": "Possible disposable source artifact; review required, not deleted"})
        if p.suffix in {".py", ".ts", ".tsx", ".js", ".md", ".json"}:
            text = safe_path(root, rel).read_text(encoding="utf-8", errors="replace")
            if any(line.startswith(("<<<<<<< ", ">>>>>>> ")) for line in text.splitlines()):
                findings.append({"path": rel, "reason": "Unresolved merge conflict marker"})
    return findings
