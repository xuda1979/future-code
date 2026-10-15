"""Regression gates for the P0-3 real-query cost study.

These tests pin the properties the study claims (docs/V8_SERVICE_CONTRACT.md
sections 7 and 9; docs/V8_MAJOR_REVISION_PLAN.md section 3.3):

  * the workload is deterministic (fixed seed) and covers the 12 archived
    trajectories, Q2 on exactly the 9 failing runs;
  * every measured row is at equal semantics (bytes compare only at equal
    answer completeness);
  * complete-answer bytes are identical across arms when semantics are equal
    (both pack the same semantic through the same encoder);
  * the decision rule is applied as frozen: bytes AND arrival time, with
    maintenance included, per query family;
  * the Amdahl decomposition is derived from measured rows only.

The study is cheap (<2 s) so the full corpus runs in the fast tier.
"""
import json
from pathlib import Path

import pytest

from experiments_v8 import real_query_study as rqs
from experiments_v8 import service_core as core

ROOT = Path(__file__).resolve().parent.parent

ARTIFACT = ROOT / "results" / "v8" / "real_query_cost_study.json"


@pytest.fixture(scope="module")
def rows():
    return rqs.run_study()


# ---------------------------------------------------------------------------
# Workload gates
# ---------------------------------------------------------------------------

def test_workload_covers_all_12_trajectories():
    workload = rqs.study_workload()
    assert set(workload) == set(core.CORPUS)
    for queries in workload.values():
        assert queries, "every trajectory must have queries"


def test_workload_is_deterministic():
    assert rqs.study_workload() == rqs.study_workload(), (
        "same seed must reproduce the workload exactly")


def test_q2_only_on_the_9_failing_runs():
    workload = rqs.study_workload()
    failing = set(rqs.failing_cases())
    assert len(failing) == 9
    for key, queries in workload.items():
        has_q2 = any(q.query_id == "Q2" for q in queries)
        assert has_q2 == (key in failing)


def test_every_trajectory_has_the_frozen_core_queries():
    workload = rqs.study_workload()
    for queries in workload.values():
        ids = {q.query_id for q in queries}
        assert {"Q1", "Q4", "Q5", "Q6a", "Q6b"} <= ids


# ---------------------------------------------------------------------------
# Measurement gates
# ---------------------------------------------------------------------------

def test_all_rows_equal_semantics(rows):
    assert rows
    for r in rows:
        assert r.equal_semantics, (r.project, r.case, r.query_id, r.mode)


def test_equal_rows_have_identical_answer_bytes(rows):
    for r in rows:
        assert r.hact.complete_answer_bytes == r.flat.complete_answer_bytes
        assert r.hact.compressed_answer_bytes == r.flat.compressed_answer_bytes


def test_maintenance_charged_once_per_trajectory(rows):
    """Construction+ingestion is attributed to the first query only."""
    by_traj: dict[tuple, list] = {}
    for r in rows:
        by_traj.setdefault((r.project, r.case), []).append(r)
    for key, rs in by_traj.items():
        for arm in ("hact", "flat"):
            builds = [getattr(r, arm).index_build_bytes for r in rs]
            assert builds[0] >= 0 and all(b == 0 for b in builds[1:]), (
                key, arm, "index build must be charged to the first query only")
            stores = [getattr(r, arm).storage_bytes for r in rs]
            assert stores[0] >= 0 and all(s == 0 for s in stores[1:]), (
                key, arm, "storage must be charged to the first query only")


def test_replay_arrival_scales_with_wave(rows):
    by_case = {}
    for r in rows:
        if r.query_id == "Q5":
            by_case.setdefault((r.project, r.case), []).append(r)
    any_checked = False
    for key, rs in by_case.items():
        rs = sorted(rs, key=lambda r: r.wave)
        if len(rs) < 2:
            continue
        any_checked = True
        times = [r.hact_arrival["archived_completion_seconds"] for r in rs]
        assert times == sorted(times) and times[0] < times[-1], (
            key, "later replay waves must arrive later in the archived model")
    assert any_checked, "workload must include multi-wave replay cases"


# ---------------------------------------------------------------------------
# Decision-rule gates (contract section 9, frozen)
# ---------------------------------------------------------------------------

def test_decision_table_covers_all_families(rows):
    table = rqs.decision_table(rows)
    families = {r.query_id for r in rows}
    assert {t["query_family"] for t in table} == families


def test_decision_rule_is_bytes_and_time(rows):
    """beneficial iff (equal AND bytes_better AND time_better)."""
    for t in rqs.decision_table(rows):
        expected = (t["equal_semantics_all"] and t["bytes_better"]
                    and t["time_better"] is True)
        assert t["hact_beneficial"] == expected, t["query_family"]


def test_decision_table_totals_match_rows(rows):
    for t in rqs.decision_table(rows):
        fam = [r for r in rows if r.query_id == t["query_family"]]
        h = sum(r.hact.complete_answer_bytes
                + r.hact.index_build_bytes + r.hact.index_maintenance_bytes
                + r.hact.storage_bytes for r in fam)
        f = sum(r.flat.complete_answer_bytes
                + r.flat.index_build_bytes + r.flat.index_maintenance_bytes
                + r.flat.storage_bytes for r in fam)
        assert t["hact_bytes_with_maintenance"] == h
        assert t["flat_bytes_with_maintenance"] == f


# ---------------------------------------------------------------------------
# Amdahl + summary gates
# ---------------------------------------------------------------------------

def test_amdahl_from_measured_rows(rows):
    a = rqs.amdahl_from_rows(rows)
    assert a["flat_cpu_seconds"] == sum(
        r.flat_arrival["aggregation_cpu_seconds"] for r in rows)
    assert a["hact_cpu_seconds"] == sum(
        r.hact_arrival["aggregation_cpu_seconds"] for r in rows)
    assert 0.0 <= a["f_measured"] <= 1.0
    f, s = a["f_measured"], a["s_measured"]
    expected = 1.0 / ((1.0 - f) + f / s)
    assert abs(a["speedup_ceiling"] - expected) < 1e-12


def test_summary_totals_match_rows(rows):
    s = rqs.summarize(rows)
    assert s["n_rows"] == len(rows)
    assert s["hact"]["complete_answer_bytes"] == sum(
        r.hact.complete_answer_bytes for r in rows)
    assert s["indexed_flat"]["complete_answer_bytes"] == sum(
        r.flat.complete_answer_bytes for r in rows)


# ---------------------------------------------------------------------------
# Artifact gate
# ---------------------------------------------------------------------------

def test_committed_artifact_matches_fresh_run(rows):
    """The committed artifact must be regenerable (bytes fields exact;
    CPU-second fields are wall-clock and excluded from equality)."""
    if not ARTIFACT.exists():
        pytest.skip("artifact not yet committed")
    committed = json.loads(ARTIFACT.read_text())
    assert committed["schema"] == "v8-real-query-cost-study-1"
    assert committed["workload_seed"] == rqs.WORKLOAD_SEED
    assert len(committed["rows"]) == len(rows)
    for stored, fresh in zip(committed["rows"], rows):
        assert stored["project"] == fresh.project
        assert stored["case"] == fresh.case
        assert stored["query_id"] == fresh.query_id
        for arm in ("hact", "flat"):
            c_stored, c_fresh = stored[arm], getattr(fresh, arm).as_dict()
            for k in ("complete_answer_bytes", "compressed_answer_bytes",
                      "pages", "round_trips", "aggregation_cpu_calls",
                      "aggregation_bytes_scanned", "index_build_bytes",
                      "index_maintenance_bytes", "storage_bytes"):
                assert c_stored[k] == c_fresh[k], (stored["case"], arm, k)
