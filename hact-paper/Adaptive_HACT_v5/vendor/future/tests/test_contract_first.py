"""Acceptance contracts declared before runtime implementation."""
from pathlib import Path
import pytest
from future_code.contracts import TaskSpec, Config, ContractError
from future_code.store import Store
from future_code.reporting import snapshot, render_markdown, TABLES
from future_code.workspace import safe_path, Workspace


def test_path_escape_rejected(tmp_path):
    with pytest.raises(ContractError):
        safe_path(tmp_path, "../outside.txt")


def test_task_cycle_rejected_atomically(tmp_path):
    with Store(tmp_path / "state.db") as db:
        with pytest.raises(ContractError):
            db.add_tasks([TaskSpec("a", "A", "A", dependencies=["b"]),
                          TaskSpec("b", "B", "B", dependencies=["a"])])
        assert db.tasks() == []


def test_unknown_health_is_not_success(tmp_path):
    with Store(tmp_path / "state.db") as db:
        data = snapshot(db)
        assert data["system"][0]["state"] == "UNKNOWN"
        assert list(data["tables"]) == list(TABLES)
        assert "UNKNOWN" in render_markdown(data)


def test_scope_lease_serializes_writers(tmp_path):
    with Store(tmp_path / "state.db") as db:
        db.add_tasks([TaskSpec("a", "A", "A", write_scope=["src"]),
                      TaskSpec("b", "B", "B", write_scope=["src/a.py"])])
        first = db.claim("one", lease_seconds=30)
        assert first is not None
        assert db.claim("two", lease_seconds=30) is None
