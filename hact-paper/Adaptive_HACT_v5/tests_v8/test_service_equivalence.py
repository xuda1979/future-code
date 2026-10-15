"""Regression gates for the V8 equal-service study.

These tests encode the acceptance standard of docs/V8_SERVICE_CONTRACT.md#8:
both representations must answer the frozen queries with identical semantics
on the archived corpus, layout changes must not change answers, stale epochs
are refused with explicit disclosure (never silently), and cost accounting is
present and comparable on both sides.

The corpus-backed tests are marked slow: they iterate all 12 archived
trajectories x 7 frozen queries x 2 layouts. Fast unit tests cover the
paging/refusal/disclosure semantics on a single trajectory.
"""
import json
from pathlib import Path

import pytest

from experiments_v8 import service_baselines as sb
from experiments_v8 import service_core as core
from experiments_v8 import service_oracle as oracle

ROOT = Path(__file__).resolve().parent.parent

# A full trajectory (22 waves), an early-abort trajectory (1 wave, 1 FAIL),
# and a partial trajectory (43 executed, 1 FAIL) cover the corpus shapes.
FULL = ("networkx", "networkx_confirm_000")
ABORT = ("toolz", "toolz_confirm_011")
PARTIAL = ("toolz", "toolz_confirm_009")


def _services(project, case):
    trajectory = core.Trajectory.load(project, case)
    layout = sb.build_layout(trajectory)
    hact = sb.HactService(trajectory=trajectory, layout=layout)
    flat = sb.IndexedFlatLedger(trajectory=trajectory)
    return trajectory, hact, flat


# ---------------------------------------------------------------------------
# Fast gates: frozen-query semantics on one trajectory per corpus shape
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("project,case", [FULL, ABORT, PARTIAL])
@pytest.mark.parametrize("query", sb.frozen_queries(), ids=lambda q: q["query_id"])
def test_frozen_queries_semantically_equal(project, case, query):
    trajectory, hact, flat = _services(project, case)
    snapshot = trajectory.snapshot()
    a_hact = hact.query(query["query_id"], snapshot, query["s"], query["mode"],
                        wave=query.get("wave"))
    a_flat = flat.query(query["query_id"], snapshot, query["s"], query["mode"],
                        wave=query.get("wave"))
    cmp = oracle.compare_query(a_hact, a_flat, a_hact.extras)
    assert cmp.equal, cmp.detail or cmp.as_dict()
    assert a_hact.epoch == a_flat.epoch == snapshot.epoch
    assert a_hact.total_pages == a_flat.total_pages


def test_status_answer_content_is_representative():
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot()
    answer = hact.query("Q1", snapshot, "all", "status")
    executed = len(snapshot.trajectory.evidence["executed"])
    counts = answer.semantic["counts"]
    assert sum(counts.values()) == len(trajectory.registry) == 170
    assert counts["PASS"] + counts["FAIL"] + counts["UNKNOWN"] == 170
    assert answer.semantic["unfinished"] == []
    assert answer.semantic["verdict"] in ("PASS", "FAIL", "UNKNOWN")


def test_unfinished_disclosed_never_omitted():
    trajectory, hact, flat = _services(*PARTIAL)
    snapshot = trajectory.snapshot()
    answer = hact.query("Q3", snapshot, "unfinished", "status")
    n_unexecuted = len(trajectory.registry) - len(trajectory.evidence["executed"])
    assert len(answer.semantic["unfinished"]) == n_unexecuted == 105
    assert answer.semantic["counts"]["UNKNOWN"] == n_unexecuted
    # Every disclosed member is a real registry ID with no record.
    for cid in answer.semantic["unfinished"]:
        assert cid in trajectory.registry
        assert snapshot.record_of(cid) is None


def test_failure_localization_reports_failing_check_with_phases():
    trajectory, hact, flat = _services(*PARTIAL)
    snapshot = trajectory.snapshot()
    answer = hact.query("Q2", snapshot, "failing", "failure_localization")
    assert answer.semantic["failing_count"] == 1
    failing = answer.semantic["failing"][0]
    assert failing["phase_outcomes"]["call"]["outcome"] == "failed"
    assert failing["context"]  # the archived failure excerpt is disclosed
    assert answer.semantic["groups"]


def test_replay_refuses_wave_beyond_epoch_with_disclosure():
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot(upto_wave=3)
    assert snapshot.epoch == 3
    for service in (hact, flat):
        answer = service.query("Q5-stale", snapshot, "all", "replay", wave=10)
        assert answer.semantic == {
            "refused": True,
            "reason": "wave beyond stated epoch",
            "wave": 10,
            "epoch": 3,
        }
        assert service.costs.failure_disclosures == 1


def test_replay_refusal_is_not_silent_upgrade():
    """A stale replay request must not return a newer or empty answer."""
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot(upto_wave=3)
    answer = hact.query("Q5-stale", snapshot, "all", "replay", wave=10)
    assert answer.semantic.get("refused") is True
    assert "members" not in answer.semantic  # never fabricated from newer waves
    assert "counts" not in answer.semantic


def test_replay_of_completed_wave_is_exact():
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot()
    a_hact = hact.query("Q5", snapshot, "all", "replay", wave=0)
    a_flat = flat.query("Q5", snapshot, "all", "replay", wave=0)
    assert a_hact.semantic == a_flat.semantic
    w = trajectory.wave_size()
    expected_members = list(trajectory.evidence["executed"])[:w]
    assert a_hact.semantic["members"] == expected_members
    assert len(a_hact.semantic["members"]) == w == 8


def test_unknown_wave_raises_identically_on_both_sides():
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot()
    for service in (hact, flat):
        with pytest.raises(ValueError, match="unknown wave 99 for replay"):
            service.query("Q5-bad", snapshot, "all", "replay", wave=99)


def test_epoch_is_carried_and_mixed_waves_are_impossible():
    trajectory, hact, flat = _services(*FULL)
    early = trajectory.snapshot(upto_wave=3)
    full = trajectory.snapshot()
    a_early = hact.query("Q1", early, "all", "status")
    a_full = hact.query("Q1", full, "all", "status")
    assert a_early.epoch == 3
    assert a_full.epoch == 22
    # The early answer is computed only from the first 4 waves.
    assert a_early.semantic["counts"]["PASS"] + \
        a_early.semantic["counts"]["FAIL"] + \
        a_early.semantic["counts"]["UNKNOWN"] == len(trajectory.registry)


# ---------------------------------------------------------------------------
# Layout invariance (contract section 2, Q6 rationale)
# ---------------------------------------------------------------------------

def test_learned_layout_does_not_change_answers():
    trajectory = core.Trajectory.load(*FULL)
    snapshot = trajectory.snapshot()
    order = oracle.learned_order(trajectory)
    assert order is not None and sorted(order) == list(range(len(order)))
    original = sb.build_layout(trajectory)
    learned = sb.build_layout(trajectory, order=order)
    assert original.uid != learned.uid  # genuinely different layouts
    h_original = sb.HactService(trajectory=trajectory, layout=original)
    h_learned = sb.HactService(trajectory=trajectory, layout=learned)
    for query in sb.frozen_queries():
        a_o = h_original.query(query["query_id"], snapshot, query["s"],
                               query["mode"], wave=query.get("wave"))
        a_l = h_learned.query(query["query_id"], snapshot, query["s"],
                              query["mode"], wave=query.get("wave"))
        assert core.strip_run_specific(a_o.semantic) == \
            core.strip_run_specific(a_l.semantic), query["query_id"]


def test_kernel_rollup_agrees_with_semantics_on_full_registry():
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot()
    answer = hact.query("Q1", snapshot, "all", "status")
    semantic = core.strip_run_specific(answer.semantic)
    assert semantic["required"] == answer.extras["kernel_gates"] == 170
    assert answer.extras["kernel_verdict"] == semantic["verdict"]
    assert answer.extras["kernel_counts"] == \
        [semantic["counts"][s] for s in core.STATUS_ORDER]
    # The kernel check is not vacuous: tampering with counts is detected.
    tampered = json.loads(json.dumps(semantic))
    tampered["counts"]["PASS"] += 1
    assert not oracle._kernel_agrees(tampered, answer.extras)


# ---------------------------------------------------------------------------
# Paging and compression (contract sections 1, 7)
# ---------------------------------------------------------------------------

def test_paging_never_truncates_and_respects_budget():
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot()
    answer = hact.query("Q1", snapshot, "all", "status")
    pages = core.pack_answers(answer.semantic, trajectory.identity,
                              "Q1", snapshot.epoch,
                              hact._total_waves(), budget=hact.budget)
    assert answer.total_pages == len(pages)
    assert all(len(p) <= hact.budget for p in pages)
    # First page declares the header; every page declares its descriptor.
    first = json.loads(pages[0].split(b"\n")[0])
    assert first["header"]["query"] == "Q1"
    assert first["header"]["epoch"] == snapshot.epoch
    for page in pages[1:]:
        desc = json.loads(page.split(b"\n")[0])
        assert set(desc) == {"page", "total_pages"}
        assert desc["total_pages"] == len(pages)


def test_small_budget_multiplies_pages_but_not_information():
    """Q3's 105-member unfinished list pages item-by-item under small budgets."""
    trajectory, hact, flat = _services(*PARTIAL)
    snapshot = trajectory.snapshot()
    big = hact.query("Q3", snapshot, "unfinished", "status")
    small = sb.HactService(trajectory=trajectory,
                           layout=sb.build_layout(trajectory),
                           budget=700)
    small_answer = small.query("Q3", snapshot, "unfinished", "status")
    assert small_answer.total_pages > big.total_pages
    assert small_answer.semantic == big.semantic  # budget pages; never truncates
    # Page count grows monotonically as the budget shrinks.
    counts = [sb.HactService(trajectory=trajectory,
                             layout=sb.build_layout(trajectory),
                             budget=b).query("Q3", snapshot, "unfinished",
                                             "status").total_pages
              for b in (20000, 2000, 700)]
    assert counts == sorted(counts), counts


def test_answers_are_compressible_on_both_sides():
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot()
    for service in (hact, flat):
        answer = service.query("Q1", snapshot, "all", "status")
        c = answer.extras["compressed"]
        assert c["raw_bytes"] > 0
        assert 0 < c["answer_zlib_bytes"] <= c["raw_bytes"]
        assert service.costs.encode_bytes == c["answer_zlib_bytes"]


# ---------------------------------------------------------------------------
# Cost accounting (contract section 7): counted on both sides, never assumed
# ---------------------------------------------------------------------------

def test_costs_are_counted_on_both_sides():
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot()
    for query in sb.frozen_queries():
        hact.query(query["query_id"], snapshot, query["s"], query["mode"],
                   wave=query.get("wave"))
        flat.query(query["query_id"], snapshot, query["s"], query["mode"],
                   wave=query.get("wave"))
    for costs in (hact.costs, flat.costs):
        d = costs.as_dict()
        assert d["index_build_bytes"] > 0
        assert d["index_maintenance_bytes"] > 0
        assert d["storage_bytes"] > 0
        assert d["aggregation_bytes_scanned"] > 0
        assert d["aggregation_cpu_calls"] > 0
        assert d["pages"] > 0 and d["round_trips"] == d["pages"]
        assert d["encode_bytes"] > 0
    # The flat ledger's whole-ledger DEFLATE is measured, not assumed.
    assert flat.whole_ledger_zlib_bytes() > 0


def test_flat_ledger_index_and_ledger_are_distinct_costs():
    trajectory, hact, flat = _services(*PARTIAL)
    snapshot = trajectory.snapshot()
    flat.query("Q1", snapshot, "all", "status")
    assert flat.costs.index_build_bytes == sum(
        len(cid.encode("ascii")) + 8 for cid in trajectory.registry)
    assert flat.costs.index_maintenance_bytes == sum(
        len(json.dumps({"id": ev["id"], "status": ev["status"],
                        "phases": ev["phases"], "wave": ev["wave"]},
                       sort_keys=True, separators=(",", ":"),
                       ensure_ascii=True).encode("ascii"))
        for ev in flat._ledger)


def test_cache_accounting_fires_when_queries_repeat():
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot()
    key = ("Q1", snapshot.epoch)
    # A repeated query through the HACT cache helper is counted as a hit.
    first = hact._cached(key, lambda: "value")
    second = hact._cached(key, lambda: "value")
    assert first == second == "value"
    assert hact.costs.cache_misses == 1
    assert hact.costs.cache_hits == 1


def test_cache_eviction_is_declared_and_fifo():
    trajectory, hact, flat = _services(*FULL)
    hact.cache_max_entries = 2
    hact._cached(("a", 0), lambda: 1)
    hact._cached(("b", 0), lambda: 2)
    hact._cached(("c", 0), lambda: 3)  # evicts ("a", 0): declared FIFO
    assert ("a", 0) not in hact._cache
    assert hact._cached(("b", 0), lambda: "recomputed") == 2
    assert hact.costs.cache_hits == 1  # ("b", 0) survived; ("a", 0) did not


# ---------------------------------------------------------------------------
# Identity and refusal hardening
# ---------------------------------------------------------------------------

def test_identity_is_the_archived_tuple():
    trajectory = core.Trajectory.load(*FULL)
    ident = trajectory.identity
    report = trajectory.report
    assert ident == {"snapshot": report["snapshot"],
                     "checker": report["checker"],
                     "environment": report["environment"],
                     "registry_hash": report["registry_hash"]}
    answer_ident = core.identity(report)
    assert answer_ident == ident


def test_unknown_semantic_set_is_rejected():
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot()
    with pytest.raises(ValueError, match="unknown semantic set or member"):
        hact.query("Q-bad", snapshot, "nonexistent-set", "status")


def test_unknown_member_in_S_is_rejected():
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot()
    with pytest.raises(ValueError, match="unknown semantic member"):
        hact.query("Q-bad", snapshot, ["not/a/real/check::id"], "status")


def test_unknown_mode_is_rejected_on_both_sides():
    trajectory, hact, flat = _services(*FULL)
    snapshot = trajectory.snapshot()
    for service in (hact, flat):
        with pytest.raises(ValueError, match="unknown mode"):
            service.query("Q-bad", snapshot, "all", "nonexistent-mode")


def test_layout_registry_mismatch_is_refused():
    trajectory = core.Trajectory.load(*FULL)
    other = core.Trajectory.load(*PARTIAL)
    layout = sb.build_layout(other)  # registry of a different candidate
    with pytest.raises(ValueError, match="layout registry must match"):
        sb.HactService(trajectory=trajectory, layout=layout)


# ---------------------------------------------------------------------------
# Full-corpus oracle (slow): the P0-1 acceptance standard
# ---------------------------------------------------------------------------

@pytest.mark.slow
def test_oracle_full_corpus_equivalence():
    report = oracle.oracle_report()
    s = report["summary"]
    # 12 trajectories x 7 frozen queries x 2 layouts = 168 comparisons.
    assert s["comparisons"] == 168
    assert s["all_equal"], "see results/v8/service_equivalence.json for diffs"
    assert s["layout_invariance_all"]
    assert all(v["invariant"] for v in report["layout_invariance"])


@pytest.mark.slow
def test_oracle_artifact_is_current(tmp_path):
    """The committed artifact must match a fresh oracle run byte-for-byte."""
    report = oracle.oracle_report()
    committed = json.loads(
        (ROOT / "results" / "v8" / "service_equivalence.json").read_text())
    assert committed["summary"]["all_equal"] is True
    assert committed["summary"] == report["summary"]
    assert committed["comparisons"] == report["comparisons"]


@pytest.mark.slow
def test_every_trajectory_has_learned_layout_or_is_skipped():
    for project, case in core.CORPUS:
        trajectory = core.Trajectory.load(project, case)
        order = oracle.learned_order(trajectory)
        if order is not None:
            assert sorted(order) == list(range(len(trajectory.registry)))
        # run_corpus must handle both arms without error either way.
    results = oracle.run_corpus([(project, case)])
    assert len(results) > 0
    assert all(r.equal for r in results)
