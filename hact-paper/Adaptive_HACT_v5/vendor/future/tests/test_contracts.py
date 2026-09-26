import json
import math
from pathlib import Path
import pytest
from future_code.contracts import (BudgetExceeded, Config, ContractError, Endpoint, GateSpec,
                                   TaskSpec, is_secret_path, overlaps, relative_path)


@pytest.mark.parametrize("path", ["../x", "/tmp/x", "C:\\x", "a/../../b", "", ".", "a\x00b", "a\\b", "C:x"])
def test_bad_paths(path):
    with pytest.raises(ContractError):
        relative_path(path)


@pytest.mark.parametrize("path", [".env", "src/.env.prod", "deepseek.env", ".git/config", "keys/key.pem", ".future-code/config.json", ".ssh/id_rsa"])
def test_secret_paths(path):
    assert is_secret_path(path)


def test_scope_overlap_is_component_based():
    assert overlaps(["src"], ["src/a.py"])
    assert overlaps(["src/a.py"], ["src"])
    assert not overlaps(["src"], ["src2/a.py"])
    assert not overlaps([], ["src"])


@pytest.mark.parametrize("changes", [{"max_steps": 0}, {"max_steps": True}, {"timeout_seconds": math.inf},
                                    {"timeout_seconds": math.nan}, {"dependencies": ["a"]},
                                    {"acceptance": []}, {"write_scope": [".git"]},
                                    {"profile": "whatever"}, {"role": "admin"},
                                    {"priority": -1}, {"require_review": "yes"},
                                    {"dependencies": ["b", "b"]}, {"gates": ["bad id"]}])
def test_invalid_task_contract(changes):
    with pytest.raises(ContractError):
        TaskSpec("a", "Title", "Instructions", **changes)


def test_task_roundtrip_and_unknown_key():
    task = TaskSpec("a", "A", "A", write_scope=["src"], gates=["unit"])
    assert TaskSpec.from_dict(task.to_dict()) == task
    with pytest.raises(ContractError):
        TaskSpec.from_dict({**task.to_dict(), "disable_safety": True})
    with pytest.raises(ContractError):
        TaskSpec.from_dict({"id": "a"})


@pytest.mark.parametrize("changes", [{"max_workers": 0}, {"max_requests": True}, {"heartbeat_seconds": 0},
                                    {"lease_seconds": 1, "heartbeat_seconds": 5}, {"stale_seconds": 1},
                                    {"backend": "shell"}, {"backend": "command"},
                                    {"protected_paths": ["../tests"]}, {"required_gates": {}},
                                    {"ignored_dirs": [".."]}, {"retry_cap_seconds": 0.1}])
def test_bad_config(changes):
    with pytest.raises(ContractError):
        Config(**changes)


def test_config_roundtrip_and_write_gating(tmp_path):
    cfg = Config()
    p = tmp_path / "config.json"
    p.write_text(json.dumps(cfg.to_dict()))
    assert Config.load(p).to_dict() == cfg.to_dict()
    with pytest.raises(ContractError, match="gate"):
        cfg.validate_task(TaskSpec("a", "A", "A", write_scope=["src"]))
    with pytest.raises(ContractError):
        Config.from_dict({"bad": 1})
    p.write_text("not json")
    with pytest.raises(ContractError):
        Config.load(p)


def test_protected_gates_and_reviewer(config):
    config.gates["ok"].protected_inputs = ["tests/holdout.py"]
    with pytest.raises(ContractError):
        config.validate_task(TaskSpec("a", "A", "A", write_scope=["tests"], gates=["ok"]))
    with pytest.raises(ContractError):
        config.validate_task(TaskSpec("a", "A", "A", require_review=True))
    config.allow_ungated_readonly = False
    with pytest.raises(ContractError):
        config.validate_task(TaskSpec("a", "A", "A"))


@pytest.mark.parametrize("changes", [{"url": "file:///etc/passwd"}, {"url": "https://user:pass@example.org/v1"},
                                    {"url": "https://example.org/?api_key=a"}, {"health_url": "https://evil.example/health"},
                                    {"api_key_env": "bad name"}, {"headers_env": {"Host": "HOST"}},
                                    {"read_timeout": 0}])
def test_bad_endpoint(changes):
    with pytest.raises(ContractError):
        Endpoint(**changes)


def test_gate_validation():
    with pytest.raises(ContractError):
        GateSpec([])
    with pytest.raises(ContractError):
        GateSpec(["python"], timeout_seconds=float("nan"))
