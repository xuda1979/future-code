"""Regression tests for the P0-6 numbers audit.

The audit must (a) PASS on the frozen artifacts as committed, and (b) FAIL
when any audited number is tampered with. These tests pin both directions so
the audit cannot silently degrade into a constant-PASS stub.
"""

import importlib.util
import json
from pathlib import Path

import pytest

P = Path(__file__).resolve().parents[1] / "audit/numbers_audit.py"
spec = importlib.util.spec_from_file_location("numbers_audit", P)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

ROOT = audit.ROOT


def _entries():
    return (audit.audit_practical_tex() + audit.audit_replay_tex()
            + audit.audit_v3_rows() + audit.audit_v7_strong()
            + audit.audit_service_equivalence() + audit.audit_real_query_cost()
            + audit.audit_higher_order())


def test_all_sections_run_and_pass():
    entries = _entries()
    assert entries, "audit produced no entries"
    bad = [e["claim"] for e in entries if e["status"] != "OK"]
    assert not bad, "non-OK entries: %s" % bad


def test_counts_match_committed_report():
    result = json.loads((ROOT / "audit/numbers_audit.json").read_text())
    entries = _entries()
    assert result["counts"]["audited"] == len(entries)
    assert result["counts"]["mismatch"] == 0
    assert result["counts"]["ungenerable"] == 0


def test_parse_tex_rows_handles_glued_bottomrule():
    rows = audit.parse_tex_rows(
        "a & 1.00 & 2.00\\\\\nb & 3.00 & 4.00\\\\\\bottomrule\n")
    assert rows == [["a", "1.00", "2.00"], ["b", "3.00", "4.00"]]


def test_audit_detects_tampered_practical_cell(tmp_path, monkeypatch):
    tex = (ROOT / "paper" / "generated_v5" / "practical.tex")
    original = tex.read_text()
    try:
        tampered = original.replace("23.43", "23.93", 1)
        assert tampered != original
        tex.write_text(tampered)
        entries = audit.audit_practical_tex()
        bad = [e for e in entries if e["status"] == "MISMATCH"]
        assert any("128/cluster" in e["claim"] for e in bad)
    finally:
        tex.write_text(original)


def test_audit_detects_tampered_replay_penalty(tmp_path):
    tex = (ROOT / "paper" / "generated_v5" / "replay.tex")
    original = tex.read_text()
    try:
        tampered = original.replace("11.68", "11.08", 1)
        assert tampered != original
        tex.write_text(tampered)
        entries = audit.audit_replay_tex()
        bad = [e for e in entries if e["status"] == "MISMATCH"]
        assert any("networkx" in e["claim"] for e in bad)
    finally:
        tex.write_text(original)


def test_audit_detects_tampered_bootstrap_ci():
    tex = (ROOT / "paper" / "generated" / "ordering_rows.tex")
    original = tex.read_text()
    try:
        tampered = original.replace("26.38", "26.98", 1)
        assert tampered != original
        tex.write_text(tampered)
        entries = audit.audit_v3_rows()
        bad = [e for e in entries if e["status"] == "MISMATCH"]
        assert any("cluster vs original" in e["claim"] for e in bad)
    finally:
        tex.write_text(original)


def test_audit_detects_tampered_v7strong_hact_column():
    tex = (ROOT / "paper" / "v7_comparison.tex")
    original = tex.read_text()
    try:
        # the HACT column value 13.91 belongs to the frequency column; change
        # a genuine HACT cell instead
        tampered = original.replace("& 23.43 &", "& 24.43 &", 1)
        assert tampered != original
        tex.write_text(tampered)
        entries = audit.audit_v7_strong()
        bad = [e for e in entries if e["status"] == "MISMATCH"]
        assert any("128/clustered" in e["claim"] for e in bad)
    finally:
        tex.write_text(original)


def test_audit_detects_flipped_hoa_verdict():
    path = (ROOT / "results" / "v8" / "higher_order_ablation.json")
    original = path.read_text()
    data = json.loads(original)
    try:
        # 0 of 9 clustered workloads have rung3 beating rung2; claim the
        # opposite and the verdict must flag as inconsistent
        data["summary"]["verdict"] = (
            "higher-order contribution is ablation-supported: rung-3 beats "
            "rung-2 on clustered held-out cost")
        path.write_text(json.dumps(data))
        entries = audit.audit_higher_order()
        bad = [e for e in entries if e["status"] == "MISMATCH"]
        assert any("verdict" in e["claim"] for e in bad)
    finally:
        path.write_text(original)


def test_audit_detects_tampered_decision_table(tmp_path):
    path = (ROOT / "results" / "v8" / "real_query_cost_study.json")
    original = path.read_text()
    data = json.loads(original)
    try:
        for row in data["decision_table"]:
            if row["query_family"] == "Q1":
                row["hact_beneficial"] = True  # contradicts its own rows
        path.write_text(json.dumps(data))
        entries = audit.audit_real_query_cost()
        bad = [e for e in entries if e["status"] == "MISMATCH"]
        assert any("family Q1" in e["claim"] for e in bad)
    finally:
        path.write_text(original)
