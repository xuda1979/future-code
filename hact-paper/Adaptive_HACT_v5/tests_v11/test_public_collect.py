"""Evidence recorder semantics checked with real pytest subprocesses."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]


def test_probe_retains_skips_xfails_xpasses_and_failures(tmp_path):
    (tmp_path / "test_statuses.py").write_text('''
import pytest
def test_pass(): pass
def test_fail(): assert False
@pytest.mark.skip(reason="unavailable")
def test_skip(): pass
@pytest.mark.xfail(reason="expected", strict=False)
def test_xfail(): assert False
@pytest.mark.xfail(reason="unexpected", strict=False)
def test_xpass(): pass
''')
    output = tmp_path / "evidence.json"
    env = dict(os.environ, PYTEST_DISABLE_PLUGIN_AUTOLOAD="1",
               PYTHONPATH=str(ROOT), HACT_V11_PROBE_OUTPUT=str(output),
               HACT_V11_SOURCE_ROOT=str(tmp_path))
    run = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p",
                          "experiments_v11.public_probe"], cwd=tmp_path,
                         env=env, capture_output=True, text=True)
    assert run.returncode == 1, run.stdout + run.stderr
    value = json.loads(output.read_text())
    assert len(value["registry"]) == len(value["executed"]) == 5
    assert value["executed"] == value["registry"]
    expected = dict(test_pass="PASS", test_fail="FAIL", test_skip="UNKNOWN",
                    test_xfail="UNKNOWN", test_xpass="UNKNOWN")
    for cid, row in value["records"].items():
        assert row["status"] == expected[cid.rsplit("::", 1)[-1]]
        assert row["wall_seconds"] >= 0
        assert row["completed_at_seconds"] >= 0
    assert value["collection_errors"] == []


def test_probe_retains_collection_error(tmp_path):
    (tmp_path / "test_bad.py").write_text("def invalid(:\n")
    output = tmp_path / "evidence.json"
    run = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p",
                          "experiments_v11.public_probe"], cwd=tmp_path,
                         env=dict(os.environ, PYTEST_DISABLE_PLUGIN_AUTOLOAD="1",
                                  PYTHONPATH=str(ROOT),
                                  HACT_V11_PROBE_OUTPUT=str(output),
                                  HACT_V11_SOURCE_ROOT=str(tmp_path)),
                         capture_output=True, text=True)
    assert run.returncode == 2
    value = json.loads(output.read_text())
    assert value["collection_errors"]
    assert value["registry"] == value["executed"] == []


def test_trace_adapter_rejects_duplicate_or_unfinished_evidence():
    from experiments_v11.public_collect import validate_evidence
    with pytest.raises(ValueError, match="duplicate"):
        validate_evidence({"registry": ["a", "a"], "executed": [], "records": {}})
    with pytest.raises(ValueError, match="not complete"):
        validate_evidence({"registry": ["a"], "executed": [], "records": {}})


def test_normalization_changes_only_registry_coordinates_and_preserves_raw(tmp_path, monkeypatch):
    from experiments_v11 import public_collect as collect
    raw_root = tmp_path / "results/v11/public_checks"
    raw_root.mkdir(parents=True)
    (raw_root / "FROZEN_MANIFEST.json").write_text("{}\n")
    monkeypatch.setattr(collect, "ROOT", tmp_path)
    monkeypatch.setattr(collect, "OUTPUT", raw_root)
    monkeypatch.setattr(collect, "PROJECTS", (("sample", "org/sample", "1", ("sample",)),))
    originals = {}
    for run_id in range(5):
        directory = raw_root / "sample" / f"run_{run_id}"
        evidence = {
            "registry": ["b", "a"], "scheduled": ["b", "a"], "executed": ["b", "a"],
            "records": {cid: {"status": "PASS", "wall_seconds": 0.1,
                              "phases": {"call": {"outcome": "passed"}}} for cid in ("b", "a")},
            "session_finished": True, "collection_errors": [],
            "package_origins": {"sample": {"inside_source_root": True}},
            "production_calls_observed": [{"path": "src/sample.py"}],
        }
        collect.write_json(directory / "pytest_evidence.json", evidence)
        collect.write_json(directory / "report.json", {"registry_hash": "raw"})
        collect.write_json(directory / "receipt.json", {"project": "sample", "run_id": run_id})
        originals[directory / "pytest_evidence.json"] = (directory / "pytest_evidence.json").read_bytes()
    collect.normalize_existing()
    out = json.loads((tmp_path / "results/v11/public_checks_normalized/sample/run_0/pytest_evidence.json").read_text())
    assert out["registry"] == ["a", "b"]
    assert out["collected_registry"] == out["scheduled"] == out["executed"] == ["b", "a"]
    assert out["normalization"]["execution_order_changed"] is False
    for file, original in originals.items():
        assert file.read_bytes() == original
