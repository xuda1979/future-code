import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import pytest

from future_code.contracts import ContractError, GateSpec, TaskSpec
from future_code.process import run_process
from future_code.quality import run_gate, validate_experiment, validate_research
from future_code.security import Redactor, child_environment
from future_code.workspace import Workspace


async def test_subprocess_success_and_bounded_output(tmp_path):
    result = await run_process([sys.executable, "-c", "print('x' * 20000)"], tmp_path, timeout=5, max_output=100)
    assert result.returncode == 0
    assert len(result.stdout) == 100
    assert result.output_truncated
    result = await run_process([sys.executable, "-c", "import sys; print(sys.stdin.read())"], tmp_path, timeout=5, input_text="hello")
    assert result.stdout.strip() == "hello"


async def test_subprocess_timeout(tmp_path):
    result = await run_process([sys.executable, "-c", "import time; time.sleep(30)"], tmp_path, timeout=0.1)
    assert result.timed_out and result.returncode != 0
    assert result.duration_seconds < 5


async def test_cancellation_kills_process_tree(tmp_path):
    marker = tmp_path / "late-write"
    code = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',\"import time,pathlib; time.sleep(1); pathlib.Path('late-write').write_text('BAD')\"]); time.sleep(30)"
    future = asyncio.create_task(run_process([sys.executable, "-c", code], tmp_path, timeout=20))
    await asyncio.sleep(0.15)
    future.cancel()
    with pytest.raises(asyncio.CancelledError):
        await future
    await asyncio.sleep(1.1)
    assert not marker.exists()


def test_environment_and_redaction(monkeypatch, tmp_path):
    monkeypatch.setenv("FUTURE_CODE_API_KEY", "SECRET_EXAMPLE_ABC123")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "SECRET_AWS_EXAMPLE")
    env = child_environment(tmp_path)
    assert "FUTURE_CODE_API_KEY" not in env and "AWS_SECRET_ACCESS_KEY" not in env
    assert child_environment(tmp_path, ["FUTURE_CODE_API_KEY"])["FUTURE_CODE_API_KEY"] == "SECRET_EXAMPLE_ABC123"
    r = Redactor(["SECRET_EXAMPLE_ABC123"])
    text = r.text("SECRET_EXAMPLE_ABC123 Bearer SOME_TOKEN api_key=abc \x1b[31mRED")
    assert "SECRET_EXAMPLE_ABC123" not in text and "SOME_TOKEN" not in text and "api_key=abc" not in text and "\x1b" not in text


async def test_gate_pass_fail_and_tamper(tmp_path, config, db):
    task = TaskSpec("a", "A", "A", write_scope=["file.txt"], gates=["ok"])
    db.add_tasks([task]); claim = db.claim("w")
    ws = Workspace(tmp_path, task, claim["attempt_id"], config); ws.prepare()
    assert (await run_gate("ok", ws, db, config, Redactor()))["verdict"] == "PASS"
    assert (await run_gate("fail", ws, db, config, Redactor()))["verdict"] == "FAIL"
    config.gates["tamper"] = GateSpec(["$PYTHON", "-c", "from pathlib import Path; Path('file.txt').write_text('test changed source')"])
    result = await run_gate("tamper", ws, db, config, Redactor())
    assert result["verdict"] == "FAIL"
    assert "modified" in result["detail"]["reason"]
    config.gates["missing"] = GateSpec(["/definitely-not-an-executable"])
    assert (await run_gate("missing", ws, db, config, Redactor()))["verdict"] == "FAIL"


def experiment(tmp_path):
    (tmp_path / "scores.json").write_text('{"score":0.9}')
    sha = hashlib.sha256((tmp_path / "scores.json").read_bytes()).hexdigest()
    return {"schema_version": 1, "experiment_id": "EXP-1", "code_sha256": "a" * 64, "config_sha256": "b" * 64,
            "model_sha256": "c" * 64, "dataset_manifest_sha256": "d" * 64, "seed": 42,
            "train_ids": ["train1"], "eval_ids": ["eval1", "eval2"],
            "primary": {"name": "accuracy", "value": 0.9, "baseline": 0.8, "direction": "maximize", "min_improvement": 0.05, "samples": 2},
            "guardrails": [{"name": "memory_gb", "value": 4, "operator": "<=", "threshold": 8}],
            "evidence_files": [{"path": "scores.json", "sha256": sha}],
            "runtime": {"python": "3.11", "framework": "fixture", "device": "cpu"}}


def test_experiment_valid_and_tampered_evidence(tmp_path):
    data = experiment(tmp_path)
    assert validate_experiment(data, tmp_path)["verdict"] == "PASS"
    (tmp_path / "scores.json").write_text("changed")
    with pytest.raises(ContractError, match="checksum"):
        validate_experiment(data, tmp_path)


@pytest.mark.parametrize("case", ["overlap", "nan", "count", "worse", "guardrail", "duplicates", "hash", "runtime"])
def test_experiment_rejects_invalid_measurement(tmp_path, case):
    data = experiment(tmp_path)
    if case == "overlap": data["eval_ids"][0] = "train1"
    if case == "nan": data["primary"]["value"] = float("nan")
    if case == "count": data["primary"]["samples"] = 1
    if case == "worse": data["primary"]["value"] = 0.7
    if case == "guardrail": data["guardrails"][0]["value"] = 20
    if case == "duplicates": data["train_ids"] = ["a", "a"]
    if case == "hash": data["code_sha256"] = "not-a-hash"
    if case == "runtime": data["runtime"] = {}
    with pytest.raises(ContractError):
        validate_experiment(data, tmp_path)


def test_research_evidence_links_are_required(tmp_path):
    ex = experiment(tmp_path)
    data = {"claims": [{"text": "Observed score", "source": "fixture experiment", "evidence_path": "scores.json", "status": "observed"}],
            "evidence_files": ex["evidence_files"], "limitations": ["Fixture is not real research"]}
    assert validate_research(data, tmp_path)["verdict"] == "PASS"
    data["claims"][0]["evidence_path"] = "missing.json"
    with pytest.raises(ContractError):
        validate_research(data, tmp_path)
