"""Falsification cases from the v8 paper review; exercise public query paths."""
from dataclasses import replace

import json
import pytest

from experiments_v8 import service_baselines as sb, service_core as core
from experiments_v8 import service_oracle as oracle


def services():
    trajectory = core.Trajectory.load("networkx", "networkx_confirm_000")
    return trajectory, (sb.HactService(trajectory, sb.build_layout(trajectory)),
                        sb.IndexedFlatLedger(trajectory))


def test_every_archived_answer_page_includes_framing_inside_cap():
    for project, case in core.CORPUS:
        t = core.Trajectory.load(project, case)
        service = sb.IndexedFlatLedger(t)
        snapshot = t.snapshot()
        for q in sb.frozen_queries():
            answer = service.query(q["query_id"], snapshot, q["s"], q["mode"],
                                   wave=q.get("wave"))
            pages = core.pack_answers(answer.semantic, t.identity, q["query_id"],
                                      snapshot.epoch, answer.total_waves)
            assert all(len(p) <= core.DEFAULT_BUDGET for p in pages)
            for number, page in enumerate(pages, 1):
                descriptor = json.loads(page.splitlines()[0])
                assert descriptor["page"] == number
                assert descriptor["total_pages"] == len(pages)


def test_indivisible_oversize_answer_is_rejected():
    t, _ = services()
    with pytest.raises(ValueError, match="exceeds.*budget"):
        core.pack_answers({"items": ["x" * 20000]}, t.identity, "Q", 1, 1)


def test_replay_at_completed_wave_count_is_not_a_completed_wave():
    t, arms = services()
    snapshot = t.snapshot(upto_wave=3)
    assert len(snapshot.executed) == 24
    for arm in arms:
        answer = arm.query("Q5", snapshot, "all", "replay", wave=3)
        assert answer.semantic["refused"] is True
        assert "members" not in answer.semantic


def test_nonidentity_layout_is_applied_to_kernel_positions():
    t, _ = services()
    order = oracle.learned_order(t)
    arm = sb.HactService(t, sb.build_layout(t, order=order))
    assert tuple(g.id for g in arm._kernel.gates) == tuple(t.registry[i] for i in order)


def test_query_implementations_do_not_call_the_reference_oracle(monkeypatch):
    t, arms = services()
    def forbidden(*args, **kwargs):
        raise AssertionError("production query called reference answer implementation")
    for name in ("answer_status", "answer_coverage_proof", "answer_replay",
                 "answer_failure_localization"):
        monkeypatch.setattr(core, name, forbidden)
    for arm in arms:
        for q in sb.frozen_queries():
            arm.query(q["query_id"], t.snapshot(), q["s"], q["mode"], wave=q.get("wave"))


def test_query_cache_is_used_and_epoch_changes_invalidate_it():
    t, arms = services()
    for arm in arms:
        early = t.snapshot(upto_wave=3)
        first = arm.query("Q1", early, "all", "status")
        calls = arm.costs.aggregation_cpu_calls
        again = arm.query("Q1", early, "all", "status")
        assert again.semantic == first.semantic
        assert arm.costs.cache_hits == 1 and arm.costs.cache_misses == 1
        assert arm.costs.aggregation_cpu_calls == calls
        full = arm.query("Q1", t.snapshot(), "all", "status")
        assert full.semantic["counts"]["UNKNOWN"] == 0
        assert arm.costs.cache_misses == 2


def test_querying_older_snapshot_rebuilds_consistent_state():
    t, arms = services()
    early = t.snapshot(upto_wave=3)
    expected = core.answer_status(early, t.registry)
    for arm in arms:
        arm.query("Q1", t.snapshot(), "all", "status")
        answer = arm.query("Q1", early, "all", "status")
        assert answer.semantic == expected
        if isinstance(arm, sb.HactService):
            assert oracle._kernel_agrees(answer.semantic, answer.extras)


def test_foreign_candidate_snapshot_is_rejected():
    t, arms = services()
    foreign = replace(t, report={**t.report, "snapshot": "another-candidate"})
    for arm in arms:
        with pytest.raises(ValueError, match="foreign.*snapshot"):
            arm.query("Q1", foreign.snapshot(), "all", "status")


def test_flat_query_depends_on_maintained_index():
    t, arms = services()
    flat = arms[1]
    flat.query("Q1", t.snapshot(), "all", "status")
    flat._index.clear()
    with pytest.raises(ValueError, match="index"):
        flat.query("different-query", t.snapshot(), "all", "status")


def test_coverage_discloses_actual_declared_and_executed_sets():
    t, arms = services()
    snap = t.snapshot(upto_wave=3)
    for arm in arms:
        answer = arm.query("Q4", snap, "all", "coverage_proof")
        assert answer.semantic["declared_ids"] == list(t.registry)
        assert set(answer.semantic["executed_ids"]) == set(snap.executed)


def test_empty_snapshot_after_full_snapshot_has_only_unknown_obligations():
    t, arms = services()
    for arm in arms:
        arm.query("Q1", t.snapshot(), "all", "status")
        answer = arm.query("Q1", t.snapshot(upto_wave=0), "all", "status")
        assert answer.semantic["counts"] == {"PASS": 0, "FAIL": 0, "UNKNOWN": len(t.registry)}


def test_independent_oracle_detects_a_shared_query_implementation_error(monkeypatch):
    original = sb._QueryService._answer
    def wrong(self, selected, mode, wave):
        answer = original(self, selected, mode, wave)
        if mode == "failure_localization":
            answer["groups"] = {"wrong": []}
        return answer
    monkeypatch.setattr(sb._QueryService, "_answer", wrong)
    rows = oracle.run_corpus([("toolz", "toolz_confirm_009")],
                             [{"query_id": "Q2", "s": "failing", "mode": "failure_localization"}])
    assert rows and all(r.semantic_equal and not r.reference_equal and not r.equal for r in rows)


def test_replay_wall_seconds_cannot_be_stripped_from_equivalence():
    t, arms = services()
    a = arms[0].query("Q5", t.snapshot(), "all", "replay", wave=0)
    b = arms[1].query("Q5", t.snapshot(), "all", "replay", wave=0)
    b.semantic["wall_seconds_total"] += 1
    assert not oracle.compare_query(a, b, a.extras).equal


def test_study_commands_refuse_to_overwrite_recorded_evidence(tmp_path):
    from experiments_v8 import real_query_study
    path = tmp_path / "recorded.json"
    path.write_text("original measurement")
    for main in (oracle.main, real_query_study.main):
        with pytest.raises(FileExistsError, match="refuse to overwrite"):
            main([str(path)])
        assert path.read_text() == "original measurement"
