from concurrent.futures import ThreadPoolExecutor
import json
import time
import pytest
from future_code.contracts import BudgetExceeded, ContractError, FencedError, TaskSpec
from future_code.store import Store


def test_dag_order_and_parallel_scopes(db):
    db.add_tasks([TaskSpec("a", "A", "A", write_scope=["a.py"]),
                  TaskSpec("b", "B", "B", write_scope=["b.py"]),
                  TaskSpec("c", "C", "C", dependencies=["a", "b"], priority=0)])
    a = db.claim("w1"); b = db.claim("w2")
    assert {a["id"], b["id"]} == {"a", "b"}
    assert db.claim("w3") is None
    for row in (a, b):
        db.finish(row["id"], row["fence"], "done")
    assert db.claim("w3")["id"] == "c"


def test_priority_bug_fix_first(db):
    db.add_tasks([TaskSpec("feature", "Feature", "Feature", priority=50), TaskSpec("bug", "Bug", "Bug", priority=0)])
    assert db.claim("worker")["id"] == "bug"


def test_atomic_graph_rejection(db):
    db.add_tasks([TaskSpec("a", "A", "A")])
    with pytest.raises(ContractError):
        db.add_tasks([TaskSpec("b", "B", "B", dependencies=["missing"])])
    assert [x["id"] for x in db.tasks()] == ["a"]
    with pytest.raises(ContractError):
        db.add_tasks([TaskSpec("a", "A", "A")])
    with pytest.raises(ContractError):
        db.add_tasks([])
    with pytest.raises(ContractError):
        db.add_tasks([TaskSpec("b", "B", "B")], max_total=1)


def test_expired_worker_fencing(db):
    db.add_tasks([TaskSpec("a", "A", "A")])
    first = db.claim("one")
    db.conn.execute("UPDATE tasks SET lease_until=0 WHERE id='a'")
    with pytest.raises(FencedError):
        db.heartbeat("a", first["fence"])
    assert db.recover_expired() == 1
    second = db.claim("two")
    assert second["fence"] > first["fence"]
    with pytest.raises(FencedError):
        db.finish("a", first["fence"], "done")
    db.finish("a", second["fence"], "done")
    assert db.task("a")["status"] == "done"


def test_cancel_parent_and_children_fences_workers(db):
    db.add_tasks([TaskSpec("p", "P", "P")])
    p = db.claim("p-worker")
    db.delegate("p", p["fence"], [TaskSpec("c", "C", "C", parent_id="p", depth=1)], max_total=10)
    c = db.claim("c-worker")
    db.cancel("p")
    assert db.task("c")["status"] == "cancelled"
    with pytest.raises(FencedError):
        db.finish("c", c["fence"], "done")


def test_messages_persist_and_validate(db):
    db.add_tasks([TaskSpec("a", "A", "A"), TaskSpec("b", "B", "B")])
    a = db.claim("one")
    db.send_message("a", a["fence"], "b", "Use the frozen API")
    assert db.messages("b")[0]["content"] == "Use the frozen API"
    assert db.messages("b", after=100) == []
    with pytest.raises(ContractError):
        db.send_message("a", a["fence"], "missing", "hi")
    with pytest.raises(ContractError):
        db.send_message("a", a["fence"], "b", "")


def test_pause_retry_and_failed_dependency(db):
    db.add_tasks([TaskSpec("a", "A", "A"), TaskSpec("b", "B", "B", dependencies=["a"])])
    db.set_meta("paused", True)
    assert db.claim("w") is None
    db.set_meta("paused", False)
    a = db.claim("w")
    db.finish("a", a["fence"], "failed", error="deterministic defect")
    assert db.claim("w") is None
    assert db.task("b")["status"] == "blocked"
    with pytest.raises(ContractError):
        db.retry_task("a", reason="")
    db.retry_task("a", reason="Changed the failing implementation")
    assert db.task("a")["status"] == "queued"


def test_transport_does_not_burn_code_attempts(db):
    db.add_tasks([TaskSpec("a", "A", "A", max_attempts=1)])
    a = db.claim("w")
    db.defer_transport("a", a["fence"], "network unavailable", 0)
    assert db.task("a")["attempts"] == 0
    assert db.claim("w") is not None


def test_attempt_limit_and_issue_resolution(db):
    db.add_tasks([TaskSpec("a", "A", "A", max_attempts=1)])
    a = db.claim("w")
    db.finish("a", a["fence"], "retry_wait")
    assert db.claim("w") is None
    assert db.task("a")["status"] == "blocked"
    i = db.issue("x", "finding", "a")
    assert i == db.issue("x", "finding", "a")
    assert db.rows("SELECT count FROM issues WHERE id=?", (i,))[0]["count"] == 2
    db.resolve_issue(i, "Regression passed")
    assert db.rows("SELECT status FROM issues WHERE id=?", (i,))[0]["status"] == "resolved"


def test_runtime_singleton_and_expiry(tmp_path):
    with Store(tmp_path / "db") as one, Store(tmp_path / "db") as two:
        one.acquire_runtime("one", lease_seconds=30)
        with pytest.raises(ContractError):
            two.acquire_runtime("two", lease_seconds=30)
        one.runtime_heartbeat("one", "IDLE", lease_seconds=30)
        one.release_runtime("one")
        two.acquire_runtime("two", lease_seconds=30)
        with pytest.raises(FencedError):
            one.runtime_heartbeat("one", "IDLE", lease_seconds=30)


def test_budget_atomic_across_connections(tmp_path):
    path = tmp_path / "db"
    with Store(path):
        pass
    def reserve(i):
        with Store(path) as db:
            try:
                db.reserve(str(i), 10, max_requests=7, max_tokens=70)
                return True
            except BudgetExceeded:
                return False
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(reserve, range(30))) == 7
    with Store(path) as db:
        assert db.conn.execute("SELECT SUM(tokens) FROM reservations").fetchone()[0] == 70


def test_schema_rejects_newer_state(tmp_path):
    path = tmp_path / "db"
    with Store(path) as db:
        db.set_meta("schema_version", 99)
    with pytest.raises(ContractError):
        Store(path)


def test_delegation_cycle_rolls_back(db):
    db.add_tasks([TaskSpec("p", "P", "P")])
    p = db.claim("w")
    with pytest.raises(ContractError):
        db.delegate("p", p["fence"], [TaskSpec("child", "Child", "Child", dependencies=["p"], parent_id="p")], max_total=5)
    assert [t["id"] for t in db.tasks()] == ["p"]
    assert db.task("p")["status"] == "running"
