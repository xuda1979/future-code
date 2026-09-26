import asyncio
import json
from pathlib import Path
import time
import pytest

from conftest import ScriptBackend, queue, read_tasks
from future_code.contracts import BudgetExceeded, Config, ContractError, Endpoint, GateSpec, TaskSpec
from future_code.runtime import Supervisor
from future_code.store import Store
from future_code.transport import PermanentEndpointError, TemporaryEndpointError
from future_code.worker import Worker, build_messages, parse_action

FINISH = {"action": "finish", "summary": "Implemented requested artifact", "uncertainties": ["Only configured gates were tested"]}


async def test_actual_parallel_workers_and_clean_integration(tmp_path, config):
    tasks = [TaskSpec(x, x, f"Create {x}.txt", write_scope=[f"{x}.txt"], gates=["ok"]) for x in ("a", "b", "c", "d")]
    queue(tmp_path, tasks)
    backend = ScriptBackend({x: [{"action": "write", "path": f"{x}.txt", "content": x}, FINISH] for x in ("a", "b", "c", "d")}, delay=0.03)
    run = Supervisor(tmp_path, config, backend=backend)
    result = await run.run(until_idle=True)
    assert set(result["task_states"].values()) == {"done"}
    assert result["peak_workers"] == 4 and backend.peak >= 2
    assert all((tmp_path / f"{x}.txt").read_text() == x for x in ("a", "b", "c", "d"))
    assert list((tmp_path / ".future-code/workspaces").iterdir()) == []
    assert backend.closed_count == 1
    assert (tmp_path / ".future-code/reports/status.html").is_file()


async def test_failed_gate_self_correction_before_promotion(tmp_path, config):
    (tmp_path / "calculator.py").write_text("def add(a, b):\n    return a - b\n")
    config.gates["unit"] = GateSpec(["$PYTHON", "-c", "from calculator import add; assert add(2,3)==5; assert add(-2,3)==1; assert add(0,0)==0"])
    task = TaskSpec("fix", "Fix addition", "Fix add without changing tests", write_scope=["calculator.py"], gates=["unit"])
    queue(tmp_path, [task])
    backend = ScriptBackend({"fix": [
        {"action": "read", "path": "calculator.py"},
        {"action": "write", "path": "calculator.py", "content": "def add(a,b):\n    return a * b\n"},
        FINISH,
        {"action": "write", "path": "calculator.py", "content": "def add(a,b):\n    return a + b\n"},
        FINISH]})
    result = await Supervisor(tmp_path, config, backend=backend).run(until_idle=True)
    assert result["task_states"] == {"fix": "done"}
    with Store(tmp_path / ".future-code/state.db") as db:
        verdicts = [r["verdict"] for r in db.rows("SELECT verdict FROM evidence ORDER BY created_at")]
        assert verdicts == ["FAIL", "PASS"]
        assert db.task("fix")["result"]["quality"] == "PASS"
    assert "return a + b" in (tmp_path / "calculator.py").read_text()
    # The subsequent model request actually contains failure feedback from production gates.
    assert "FAIL" in json.dumps(backend.requests[3][1])


async def test_dynamic_delegation_preserves_parent_gate(tmp_path, config):
    config.gates.update({"a_gate": GateSpec(["$PYTHON", "-c", "from a import value; assert value == 1"]),
                         "b_gate": GateSpec(["$PYTHON", "-c", "from b import value; assert value == 2"]),
                         "integration": GateSpec(["$PYTHON", "-c", "import a,b; assert a.value+b.value==3"])})
    parent = TaskSpec("parent", "Build two components", "Divide independent files then verify integration", write_scope=["a.py", "b.py"], gates=["integration"])
    queue(tmp_path, [parent])
    children = [{"id": "a", "title": "A", "instructions": "Create a.py", "write_scope": ["a.py"], "gates": ["a_gate"]},
                {"id": "b", "title": "B", "instructions": "Create b.py", "write_scope": ["b.py"], "gates": ["b_gate"]}]
    backend = ScriptBackend({"parent": [{"action": "delegate", "tasks": children}, FINISH],
                             "a": [{"action": "write", "path": "a.py", "content": "value = 1\n"}, FINISH],
                             "b": [{"action": "write", "path": "b.py", "content": "value = 2\n"}, FINISH]}, delay=0.02)
    result = await Supervisor(tmp_path, config, backend=backend).run(until_idle=True)
    assert result["task_states"] == {"a": "done", "b": "done", "parent": "done"}
    assert result["peak_workers"] >= 2
    with Store(tmp_path / ".future-code/state.db") as db:
        assert db.task("parent")["spec"]["gates"] == ["integration"]
        assert set(db.task("parent")["spec"]["dependencies"]) == {"a", "b"}
        assert db.rows("SELECT verdict FROM evidence WHERE task_id='parent' AND kind='integration'")[0]["verdict"] == "PASS"


async def test_checkpoint_resume_after_transport_outage(tmp_path, config):
    (tmp_path / "file.txt").write_text("before")
    queue(tmp_path, [TaskSpec("a", "A", "Change text", write_scope=["file.txt"], gates=["ok"])])
    first = ScriptBackend({"a": [{"action": "read", "path": "file.txt"},
                                  {"action": "write", "path": "file.txt", "content": "after"},
                                  TemporaryEndpointError("fixture outage", 1)]})
    result = await Supervisor(tmp_path, config, backend=first).run(until_idle=True)
    assert result["task_states"]["a"] == "retry_wait"
    assert (tmp_path / "file.txt").read_text() == "before"
    with Store(tmp_path / ".future-code/state.db") as db:
        db.conn.execute("UPDATE tasks SET available_at=0")
    second = ScriptBackend({"a": [FINISH]})
    result = await Supervisor(tmp_path, config, backend=second).run(until_idle=True)
    assert result["task_states"]["a"] == "done"
    assert (tmp_path / "file.txt").read_text() == "after"
    with Store(tmp_path / ".future-code/state.db") as db:
        assert db.rows("SELECT kind FROM events WHERE kind='checkpoint.restored'")


async def test_daemon_stays_alive_when_idle_and_honors_stop(tmp_path, config):
    backend = ScriptBackend()
    run = Supervisor(tmp_path, config, backend=backend)
    future = asyncio.create_task(run.run())
    await asyncio.sleep(0.15)
    assert not future.done() and backend.requests == []
    with Store(tmp_path / ".future-code/state.db") as db:
        assert db.get_meta("runtime")["state"] == "IDLE"
        db.set_meta("stop_requested_owner", run.owner)
    await asyncio.wait_for(future, 3)
    assert backend.closed_count == 1


async def test_cancelled_task_and_shutdown_do_not_leave_workers(tmp_path, config):
    queue(tmp_path, [TaskSpec("a", "A", "A", gates=["ok"])])
    backend = ScriptBackend(delay=20)
    run = Supervisor(tmp_path, config, backend=backend)
    future = asyncio.create_task(run.run())
    for _ in range(100):
        if backend.active:
            break
        await asyncio.sleep(0.01)
    with Store(tmp_path / ".future-code/state.db") as db:
        db.cancel("a")
    await asyncio.sleep(0.1)
    assert backend.active == 0
    run.stop()
    await asyncio.wait_for(future, 3)
    assert read_tasks(tmp_path)[0]["status"] == "cancelled"


@pytest.mark.parametrize("failure,category", [(BudgetExceeded("limit"), "budget"), (PermanentEndpointError("auth required"), "external_configuration"),
                                              (ContractError("invalid contract"), "task_contract")])
async def test_blocked_task_has_incident_not_false_success(tmp_path, config, failure, category):
    queue(tmp_path, [TaskSpec("a", "A", "A")])
    result = await Supervisor(tmp_path, config, backend=ScriptBackend({"a": [failure]})).run(until_idle=True)
    assert result["task_states"]["a"] == "blocked"
    with Store(tmp_path / ".future-code/state.db") as db:
        assert db.rows("SELECT category FROM issues")[0]["category"] == category
        assert db.task("a")["result"] is None


async def test_task_deadline_blocks_and_asks_for_decomposition(tmp_path, config):
    queue(tmp_path, [TaskSpec("a", "A", "A", timeout_seconds=0.15)])
    backend = ScriptBackend(delay=5)
    result = await Supervisor(tmp_path, config, backend=backend).run(until_idle=True)
    assert result["task_states"]["a"] == "blocked"
    assert backend.active == 0
    assert "decompose" in read_tasks(tmp_path)[0]["error"]


async def test_invalid_actions_cannot_invent_success(tmp_path, config):
    queue(tmp_path, [TaskSpec("a", "A", "A", max_steps=3)])
    backend = ScriptBackend({"a": ["All tests pass!", {"action": "execute_shell", "command": "rm -rf /"}, {"action": "finish", "summary": "fake", "uncertainties": [], "quality": "PASS"}]})
    result = await Supervisor(tmp_path, config, backend=backend).run(until_idle=True)
    assert result["task_states"]["a"] == "blocked"


async def test_review_failure_then_repair(tmp_path, config):
    config.reviewer_endpoint = Endpoint(name="reviewer")
    queue(tmp_path, [TaskSpec("a", "A", "A", write_scope=["a.txt"], gates=["ok"], require_review=True)])
    backend = ScriptBackend({"a": [{"action": "write", "path": "a.txt", "content": "draft"}, FINISH,
                                   {"action": "write", "path": "a.txt", "content": "corrected"}, FINISH]})
    reviewer = ScriptBackend({"a": [{"verdict": "FAIL", "issues": ["Draft is not complete"]}, {"verdict": "PASS", "issues": []}]})
    result = await Supervisor(tmp_path, config, backend=backend, reviewer=reviewer).run(until_idle=True)
    assert result["task_states"]["a"] == "done"
    assert (tmp_path / "a.txt").read_text() == "corrected"
    assert len(reviewer.requests) == 2


async def test_inter_agent_messages_reach_context(tmp_path, config):
    queue(tmp_path, [TaskSpec("a", "A", "A"), TaskSpec("b", "B", "B", dependencies=["a"])])
    backend = ScriptBackend({"a": [{"action": "message", "recipient": "b", "content": "Interface version is v2"}, FINISH], "b": [FINISH]})
    result = await Supervisor(tmp_path, config, backend=backend).run(until_idle=True)
    assert set(result["task_states"].values()) == {"done"}
    requests = [m for task, m, _ in backend.requests if task == "b"]
    assert "Interface version is v2" in json.dumps(requests)
    assert read_tasks(tmp_path)[0]["result"]["quality"] == "UNKNOWN"


def test_context_is_bounded_and_required_contract_is_not_silently_dropped(config):
    task = TaskSpec("a", "A", "A")
    messages = build_messages(task, config, [{"result": "x" * 20000}] * 20, [], [])
    assert len(json.dumps(messages)) <= config.max_context_chars
    assert "acceptance" in json.dumps(messages)
    config.max_context_chars = 4000
    with pytest.raises(ContractError):
        build_messages(TaskSpec("b", "B", "X" * 12000), config, [], [], [])


@pytest.mark.parametrize("text", ["[]", "{}", '"hello"', '```json\n{}\n```', '{"action":"write"}', '{"action":"list","shell":"ls"}'])
def test_invalid_action_schema(text):
    with pytest.raises(ContractError):
        parse_action(text)


@pytest.mark.parametrize("mode,expected", [("http", "retry_wait"), ("command", "blocked")])
async def test_shutdown_result_matches_post_cancellation_database(tmp_path, config, mode, expected):
    config.backend = mode
    config.command_argv = ["fixture-not-executed"]
    queue(tmp_path, [TaskSpec("active", "Active task", "Work")])
    backend = ScriptBackend(delay=10)
    supervisor = Supervisor(tmp_path, config, backend=backend)
    future = asyncio.create_task(supervisor.run())
    for _ in range(100):
        if backend.active:
            break
        await asyncio.sleep(0.01)
    assert backend.active == 1
    supervisor.stop()
    result = await asyncio.wait_for(future, 3)
    assert result["task_states"]["active"] == expected
    assert read_tasks(tmp_path)[0]["status"] == expected
    assert backend.active == 0
