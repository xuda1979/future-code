import json
from pathlib import Path
import pytest
from future_code.contracts import Config, ConflictError, ContractError, TaskSpec
from future_code.security import ensure_control
from future_code.store import Store
from future_code.workspace import Workspace, digest, hygiene_scan, recover_integrations, safe_path


def make_workspace(root, config, scope=None):
    task = TaskSpec("a", "A", "A", write_scope=scope or ["file.txt"], gates=["ok"])
    ws = Workspace(root, task, "a.1", config)
    ws.prepare()
    return ws


def test_staged_writes_do_not_touch_project(tmp_path, config):
    (tmp_path / "file.txt").write_text("before")
    ws = make_workspace(tmp_path, config)
    ws.read("file.txt")
    ws.write("file.txt", "after")
    assert (tmp_path / "file.txt").read_text() == "before"
    assert ws.changes() == {"file.txt": digest(b"after")}
    assert ws.read("file.txt")["content"] == "1: after"


def test_paths_symlinks_and_scope_blocked(tmp_path, config):
    outside = tmp_path.parent / (tmp_path.name + "-outside")
    outside.mkdir()
    (tmp_path / "link").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ContractError):
        safe_path(tmp_path, "link/file")
    ws = make_workspace(tmp_path, config)
    for path in ("../file.txt", ".env", "other.txt", ".future-code/config.json"):
        with pytest.raises(ContractError):
            ws.write(path, "bad")
    assert not (outside / "file").exists()


def test_secret_files_are_not_copied(tmp_path, config):
    (tmp_path / "deepseek.env").write_text("API_KEY=secret")
    (tmp_path / ".env").write_text("SECRET=secret")
    (tmp_path / "file.txt").write_text("safe")
    ws = make_workspace(tmp_path, config)
    assert ws.list_files()["files"] == ["file.txt"]
    with pytest.raises(ContractError):
        ws.read("deepseek.env")


def test_untrusted_cli_scope_change_is_detected(tmp_path, config):
    (tmp_path / "unrelated.txt").write_text("keep")
    ws = make_workspace(tmp_path, config)
    (ws.path / "unrelated.txt").write_text("tampered")
    with pytest.raises(ContractError, match="scope"):
        ws.changes()
    assert (tmp_path / "unrelated.txt").read_text() == "keep"


def test_source_deletion_is_rejected(tmp_path, config):
    (tmp_path / "file.txt").write_text("keep")
    ws = make_workspace(tmp_path, config)
    (ws.path / "file.txt").unlink()
    with pytest.raises(ContractError, match="deletion"):
        ws.changes()


def test_stale_read_rejected_and_disjoint_rebase_allowed(tmp_path, config):
    (tmp_path / "file.txt").write_text("before")
    (tmp_path / "dependency.txt").write_text("version1")
    ws = make_workspace(tmp_path, config)
    ws.write("file.txt", "after")
    (tmp_path / "new.txt").write_text("independent addition")
    ws.refresh_for_commit()
    assert (ws.path / "new.txt").read_text() == "independent addition"
    ws.read("dependency.txt")
    (tmp_path / "dependency.txt").write_text("version2")
    with pytest.raises(ConflictError):
        ws.refresh_for_commit()


def test_commit_evidence_is_fingerprint_bound(tmp_path, config):
    ws = make_workspace(tmp_path, config)
    ws.write("file.txt", "new")
    root_hashes = ws.refresh_for_commit()
    verified = ws.fingerprint()
    ws.write("file.txt", "changed after tests")
    with Store(ws.control / "state.db") as db:
        db.add_tasks([ws.task]); claim = db.claim("worker")
        with pytest.raises(ConflictError, match="after verification"):
            ws.commit(db, claim["fence"], {"quality": "PASS"}, verified_fingerprint=verified, expected_root=root_hashes)
    assert not (tmp_path / "file.txt").exists()


def test_commit_rejects_external_edit_during_gate(tmp_path, config):
    ws = make_workspace(tmp_path, config)
    ws.write("file.txt", "new")
    root_hashes = ws.refresh_for_commit()
    (tmp_path / "external.txt").write_text("changed while gate ran")
    with Store(ws.control / "state.db") as db:
        db.add_tasks([ws.task]); claim = db.claim("worker")
        with pytest.raises(ConflictError):
            ws.commit(db, claim["fence"], {}, verified_fingerprint=ws.fingerprint(), expected_root=root_hashes)


def test_multifile_crash_rollforward_recovery(tmp_path, config, monkeypatch):
    import future_code.workspace as module
    (tmp_path / "a.txt").write_text("old a")
    (tmp_path / "b.txt").write_text("old b")
    ws = make_workspace(tmp_path, config, ["a.txt", "b.txt"])
    ws.write("a.txt", "new a"); ws.write("b.txt", "new b")
    original_write = module.atomic_write
    def crash(path, data, **kwargs):
        if path == tmp_path / "b.txt":
            raise OSError("simulated crash after first root replacement")
        return original_write(path, data, **kwargs)
    with Store(ws.control / "state.db") as db:
        db.add_tasks([ws.task]); claim = db.claim("worker")
        expected = ws.refresh_for_commit()
        monkeypatch.setattr(module, "atomic_write", crash)
        with pytest.raises(OSError):
            ws.commit(db, claim["fence"], {"quality": "PASS"}, verified_fingerprint=ws.fingerprint(), expected_root=expected)
        assert (tmp_path / "a.txt").read_text() == "new a"
        assert (tmp_path / "b.txt").read_text() == "old b"
        assert db.rows("SELECT status FROM integrations")[0]["status"] == "prepared"
    monkeypatch.setattr(module, "atomic_write", original_write)
    with Store(ws.control / "state.db") as db:
        assert recover_integrations(tmp_path, db, config)[0]["status"] == "recovered"
        assert db.task("a")["status"] == "done"
    assert (tmp_path / "b.txt").read_text() == "new b"


def prepare_interrupted(root, config, monkeypatch):
    import future_code.workspace as module
    ws = make_workspace(root, config)
    ws.write("file.txt", "new")
    db = Store(ws.control / "state.db")
    db.add_tasks([ws.task]); claim = db.claim("worker")
    original = module.apply_journal
    monkeypatch.setattr(module, "apply_journal", lambda *a, **kw: (_ for _ in ()).throw(OSError("crash before write")))
    with pytest.raises(OSError):
        ws.commit(db, claim["fence"], {"quality": "PASS"}, verified_fingerprint=ws.fingerprint(), expected_root=ws.base)
    monkeypatch.setattr(module, "apply_journal", original)
    return ws, db


def test_tampered_payload_fails_closed(tmp_path, config, monkeypatch):
    ws, db = prepare_interrupted(tmp_path, config, monkeypatch)
    try:
        (ws.artifacts / "change-0.bin").write_bytes(b"tampered")
        assert recover_integrations(tmp_path, db, config)[0]["status"] == "blocked"
        assert db.task("a")["status"] == "blocked"
        assert not (tmp_path / "file.txt").exists()
    finally:
        db.close()


def test_external_change_during_crash_is_not_overwritten(tmp_path, config, monkeypatch):
    ws, db = prepare_interrupted(tmp_path, config, monkeypatch)
    try:
        (tmp_path / "file.txt").write_text("user edit")
        assert recover_integrations(tmp_path, db, config)[0]["status"] == "blocked"
        assert (tmp_path / "file.txt").read_text() == "user edit"
    finally:
        db.close()


def test_cleanup_ownership_and_project_preservation(tmp_path, config):
    (tmp_path / "scratch_keep.tmp").write_text("user work")
    ws = make_workspace(tmp_path, config)
    marker = ws.path / ".fc-owned.json"
    original = marker.read_text()
    marker.write_text('{"attempt_id":"wrong"}')
    with pytest.raises(ContractError):
        ws.cleanup()
    marker.write_text(original)
    ws.cleanup()
    assert not ws.path.exists()
    assert (tmp_path / "scratch_keep.tmp").read_text() == "user work"
    assert any(x["path"] == "scratch_keep.tmp" for x in hygiene_scan(tmp_path, config))


def test_snapshot_size_and_binary_read(tmp_path, config):
    (tmp_path / "file.txt").write_bytes(b"\xff\xfe")
    ws = make_workspace(tmp_path, config)
    with pytest.raises(ContractError):
        ws.read("file.txt")
    with pytest.raises(ContractError):
        ws.write("file.txt", "x" * (config.max_file_bytes + 1))
    with pytest.raises(ContractError):
        ws.read("file.txt", max_lines=0)


def test_protected_control_dir_symlink(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / ".future-code").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ContractError):
        ensure_control(tmp_path)
