from __future__ import annotations
import asyncio
import importlib.util
import json
from pathlib import Path
import threading
import time

import httpx
import pytest

from future_code.cli import main
from future_code.contracts import ContractError, TaskSpec
from future_code.dashboard import make_server
from future_code.reporting import TABLES, render_html, render_markdown, render_metrics, snapshot
from future_code.runtime import Supervisor
from future_code.store import Store
from future_code.transport import HTTPBackend, PermanentEndpointError
from future_code.workspace import recover_integrations
from conftest import ScriptBackend, queue
from test_workspace import prepare_interrupted


def test_real_http_end_to_end(tmp_path):
    spec = importlib.util.spec_from_file_location("demo_fixture", Path(__file__).parents[1] / "examples/demo.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = module.run_demo(tmp_path / "demo")
    assert result["verdict"] == "PASS"
    assert result["task_states"] == {"addition": "done", "project": "done", "statistics": "done"}
    assert result["peak_workers"] >= 2
    assert result["injected_http_503"] == 1
    assert result["http_requests"] > result["tcp_connections"]  # actual HTTP/1.1 connection reuse
    assert [r["verdict"] for r in result["gate_history"] if r["task_id"] == "addition"] == ["FAIL", "PASS"]
    assert "return a + b" in (tmp_path / "demo/calculator.py").read_text()
    with pytest.raises(ValueError, match="empty"):
        module.run_demo(tmp_path / "demo")


def test_fixed_report_schema_escaping_and_staleness(db):
    db.add_tasks([TaskSpec("x", '<script>alert(1)</script>|new\nline', "Read")])
    db.set_meta("runtime", {"state": "RUNNING", "heartbeat_at": 100})
    data = snapshot(db, now=101)
    assert list(data["tables"]) == list(TABLES)
    assert data["system"][0]["state"] == "RUNNING"
    for name, rows in data["tables"].items():
        assert all(set(row) == {key for key, _ in TABLES[name]} for row in rows)
    assert render_markdown(data).count("\n## ") == 13
    assert render_html(data).count("<section ") == 13
    assert "<script>" not in render_html(data)
    assert "&lt;script&gt;" in render_html(data)
    assert "\\|new line" in render_markdown(data)
    assert "future_code_tasks" in render_metrics(data)
    assert snapshot(db, now=200)["system"][0]["state"] == "UNKNOWN"
    # Report ordering is deterministic for a given snapshot, independent of model text.
    assert render_markdown(data) == render_markdown(data)


@pytest.mark.parametrize("token", ["", "local-secret-fixture"])
def test_dashboard_real_http_read_only_auth_and_health(db, token):
    server = make_server(db.path, port=0, token=token)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    thread.start()
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{server.server_port}", trust_env=False) as client:
            if token:
                assert client.get("/").status_code == 401
                client.headers["Authorization"] = "Bearer " + token
            assert client.get("/", headers={"Host": "evil.example"}).status_code == 403
            response = client.get("/")
            assert response.status_code == 200
            assert response.text.count("<section ") == 13
            assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
            assert client.get("/v1/status").json()["schema_version"] == 2
            assert client.get("/metrics").status_code == 200
            assert client.get("/health/live").status_code == 503
            assert client.get("/health/ready").status_code == 503
            db.set_meta("runtime", {"state": "IDLE", "heartbeat_at": time.time()})
            assert client.get("/health/live").status_code == 200
            assert client.get("/health/ready").status_code == 200
            db.set_meta("runtime", {"state": "WAITING_EXTERNAL", "heartbeat_at": time.time()})
            assert client.get("/health/live").status_code == 200
            assert client.get("/health/ready").status_code == 503
            assert client.get("/missing").status_code == 404
            assert client.post("/v1/status", json={"state": "PASS"}).status_code == 501
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_cli_lifecycle_and_errors(tmp_path, capsys):
    prefix = ["--project", str(tmp_path)]
    assert main(prefix + ["status"]) == 2
    capsys.readouterr()
    assert main(prefix + ["init"]) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "INITIALIZED"
    assert main(prefix + ["init"]) == 2
    capsys.readouterr()
    file = tmp_path / "tasks.json"
    file.write_text(json.dumps([TaskSpec("read", "Read only", "Inspect project").to_dict()]))
    for arguments in (["submit", str(file)], ["inspect", "read"], ["pause"], ["resume", "--reason", "reviewed"],
                      ["doctor"], ["cleanup"], ["events"], ["status", "--json"], ["cancel", "read"], ["stop"]):
        assert main(prefix + arguments) == 0
        capsys.readouterr()
    for arguments in (["retry", "read", "--reason", "cancelled"], ["events", "--limit", "0"], ["status", "--interval", "0"], ["resume", "--reason", " "]):
        assert main(prefix + arguments) == 2
        assert json.loads(capsys.readouterr().err)["state"] == "ERROR"
    # No runnable work is an explicit, bounded one-shot operation.
    assert main(prefix + ["run", "--until-idle", "--quiet"]) == 3
    capsys.readouterr()


def test_journal_fingerprint_tamper_rejected(tmp_path, config, monkeypatch):
    ws, db = prepare_interrupted(tmp_path, config, monkeypatch)
    try:
        row = db.rows("SELECT id,manifest FROM integrations")[0]
        manifest = json.loads(row["manifest"])
        manifest["verified_fingerprint"] = "0" * 64
        db.conn.execute("UPDATE integrations SET manifest=? WHERE id=?", (json.dumps(manifest), row["id"]))
        assert recover_integrations(tmp_path, db, config)[0]["status"] == "blocked"
        assert not (tmp_path / "file.txt").exists()
    finally:
        db.close()


def test_expired_command_attempt_requires_operator(db):
    db.add_tasks([TaskSpec("x", "X", "X")])
    db.claim("agent", lease_seconds=0.001)
    time.sleep(0.005)
    assert db.recover_expired(retry_safe=False) == 1
    assert db.task("x")["status"] == "blocked"


@pytest.mark.parametrize("bad", [{"max_steps": "many"}, {"max_attempts": True}, {"timeout_seconds": []}, {"dependencies": "parent"}, {"dependencies": [2]}, {"require_review": "false"}])
async def test_malformed_child_parameters_are_rejected_not_worker_crashes(tmp_path, config, bad):
    task = TaskSpec("parent", "Parent", "Delegate", write_scope=["x.py"], gates=["ok"], max_steps=3)
    queue(tmp_path, [task])
    child = {"id": "child", "title": "Child", "instructions": "Write", "write_scope": ["x.py"], "gates": ["ok"], **bad}
    backend = ScriptBackend({"parent": [{"action": "delegate", "tasks": [child]}, {"action": "finish", "summary": "No edit was required", "uncertainties": []}]})
    await Supervisor(tmp_path, config, backend=backend).run(until_idle=True)
    assert "rejected" in json.dumps(backend.requests[1][1])
    with Store(tmp_path / ".future-code/state.db") as db:
        assert not db.rows("SELECT * FROM issues WHERE category='worker_error'")
        assert not db.rows("SELECT * FROM tasks WHERE id='child'")


async def test_credential_header_newline_never_sent(db, config, monkeypatch):
    monkeypatch.setenv(config.endpoint.api_key_env, "secret\r\nInjected: bad")
    backend = HTTPBackend(config, db)
    try:
        with pytest.raises(PermanentEndpointError, match="newline"):
            await backend.complete([{"role": "user", "content": "test"}], "task")
    finally:
        await backend.close()


async def test_many_small_agents_complete_without_duplicate_commits(tmp_path, config):
    config.max_workers = 16
    config.lease_seconds = 10
    tasks = [TaskSpec(f"task-{i:03d}", f"Inspect {i}", "Read-only review", max_steps=2) for i in range(80)]
    queue(tmp_path, tasks)
    backend = ScriptBackend(delay=0.03)
    result = await Supervisor(tmp_path, config, backend=backend).run(until_idle=True)
    assert len(result["task_states"]) == 80
    assert set(result["task_states"].values()) == {"done"}
    assert result["peak_workers"] == 16
    assert backend.peak >= 2
    with Store(tmp_path / ".future-code/state.db") as db:
        assert len(db.rows("SELECT * FROM integrations WHERE status='committed'")) == 80
        assert len(db.rows("SELECT DISTINCT task_id FROM integrations")) == 80
        assert len(db.rows("SELECT * FROM attempts")) == 80


@pytest.mark.parametrize("policy", [
    {"command_argv": "echo unsafe"}, {"command_env_allowlist": "PATH"},
    {"command_env_allowlist": [2]}, {"protected_paths": "tests"},
    {"gates": {"x": {"argv": ["echo"], "protected_inputs": "tests"}}},
    {"reviewer_endpoint": {"name": "primary"}},
])
def test_wrong_container_types_in_policy_rejected(policy):
    from future_code.contracts import Config
    with pytest.raises(ContractError):
        Config.from_dict(policy)


async def test_command_string_is_not_treated_as_argv(tmp_path):
    from future_code.process import run_process
    with pytest.raises(ContractError):
        await run_process("echo unsafe", tmp_path, timeout=1)


@pytest.mark.parametrize("one_shot,exit_code", [(False, 0), (True, 3)])
def test_continuous_administrative_stop_is_not_a_restart_failure(tmp_path, monkeypatch, capsys, one_shot, exit_code):
    import future_code.cli as cli
    prefix = ["--project", str(tmp_path)]
    assert cli.main(prefix + ["init"]) == 0
    capsys.readouterr()
    async def stopped(*args):
        return {"peak_workers": 1, "task_states": {"unfinished": "retry_wait"}}
    monkeypatch.setattr(cli, "run_daemon", stopped)
    args = prefix + ["run", "--quiet"] + (["--until-idle"] if one_shot else [])
    assert cli.main(args) == exit_code
    assert json.loads(capsys.readouterr().out)["task_states"]["unfinished"] == "retry_wait"
