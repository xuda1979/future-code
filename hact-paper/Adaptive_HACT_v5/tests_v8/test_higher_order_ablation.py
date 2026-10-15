"""Regression tests for the P0-4 higher-order ablation ladder.

The frozen decision rule (V8_MAJOR_REVISION_PLAN.md section 5) is applied
mechanically; these tests pin:
  * the frozen synthetic split is regenerated exactly (contract keys, sizes);
  * rung 1 and rung 2 produce exact registry permutations;
  * rung 3's local search never corrupts the permutation (disjoint block
    moves / swaps only), always returns an adoptable order, and validation
    alone decides between start and improved;
  * the decision rule maps cost deltas to the frozen verdicts;
  * the full synthetic ladder summary carries the frozen schema and a
    verdict consistent with the clustered-family rows.
"""

import json
from pathlib import Path

import numpy as np
import pytest

from experiments_v8 import higher_order_ablation as hoa

ROOT = Path(__file__).resolve().parent.parent
ARTIFACT = ROOT / "results" / "v8" / "higher_order_ablation.json"


# ---------------------------------------------------------------------------
# Frozen split regeneration
# ---------------------------------------------------------------------------

def test_frozen_synthetic_spec_matches_contract():
    spec = hoa.frozen_synthetic_spec()
    assert spec["n"] == [128, 512, 1024]
    assert spec["families"] == ["cluster", "independent", "global"]
    assert spec["seeds"] == [55011, 55012, 55013]
    assert spec["train_epochs"] == 128
    assert spec["validation_epochs"] == 128
    assert spec["heldout_epochs"] == 256
    assert spec["fanout"] == 8


def test_synthetic_split_sizes_and_reproducibility():
    train_a, valid_a, held_a = hoa.synthetic_split(128, "cluster", 55011)
    train_b, valid_b, held_b = hoa.synthetic_split(128, "cluster", 55011)
    assert train_a == train_b and valid_a == valid_b and held_a == held_b
    assert len(train_a) == 128 and len(valid_a) == 128 and len(held_a) == 256
    # cluster episodes are single 8-wide waves (frozen draw semantics)
    assert all(len(ep) == 1 for ep in train_a)
    assert all(len(ep[0]) <= 9 for ep in train_a)


# ---------------------------------------------------------------------------
# Rungs 1 and 2: order validity
# ---------------------------------------------------------------------------

def test_frequency_and_cluster_orders_are_permutations():
    train, _, _ = hoa.synthetic_split(128, "cluster", 55011)
    for order in (hoa.frequency_order(train, 128), hoa.cluster_order(train, 128)):
        assert sorted(order) == list(range(128))


def test_frequency_order_sorts_by_activation_count():
    # hand-built episodes: obligations 3 and 7 are most active
    episodes = [[[3, 7]], [[3, 7]], [[3]], [[7]], [[0]]]
    order = hoa.frequency_order(episodes, 8)
    assert sorted(order) == list(range(8))
    # most frequent first
    assert order[0] in (3, 7) and order[1] in (3, 7)


# ---------------------------------------------------------------------------
# Rung 3: permutation safety + validation-only adoption
# ---------------------------------------------------------------------------

def test_wave_improvement_returns_valid_permutation():
    train, valid, _ = hoa.synthetic_split(128, "cluster", 55011)
    start = hoa.cluster_order(train, 128)
    improved, info = hoa.wave_improvement(
        train, valid, 128, budget_seconds=0.2, start_order=start,
        rng_seed=55011)
    assert sorted(improved) == list(range(128))
    assert info["adopted"] in ("start", "improved")


def test_wave_improvement_never_adopts_worse_validation_cost():
    train, valid, _ = hoa.synthetic_split(128, "cluster", 55011)
    start = hoa.cluster_order(train, 128)
    improved, info = hoa.wave_improvement(
        train, valid, 128, budget_seconds=0.3, start_order=start,
        rng_seed=55012)
    # whatever is adopted must not be worse on validation than the start
    ids = tuple("g%05d" % i for i in range(128))
    from ichact.practical import balanced_layout
    start_layout = balanced_layout(ids, start, model=hoa.MODEL)
    adopted_layout = balanced_layout(ids, improved, model=hoa.MODEL)
    start_val = float(np.mean([start_layout.cost(ep) for ep in valid]))
    adopted_val = float(np.mean([adopted_layout.cost(ep) for ep in valid]))
    assert adopted_val <= start_val


def test_wave_improvement_trivial_registry():
    order, info = hoa.wave_improvement([[[0]]], [[[0]]], 1, budget_seconds=0.05)
    assert order == (0,)
    assert info["adopted"] == "start"


# ---------------------------------------------------------------------------
# Decision rule
# ---------------------------------------------------------------------------

def test_decide_supported_and_unsupported_branches():
    row_supported = {"heldout_totals": {
        "rung2_cluster": 100.0, "rung3_wave_improvement": 99.0}}
    decision = hoa.decide(row_supported)
    assert decision["rung3_beats_rung2"] is True
    assert "ablation-supported" in decision["note"]

    row_unsupported = {"heldout_totals": {
        "rung2_cluster": 100.0, "rung3_wave_improvement": 100.5}}
    decision = hoa.decide(row_unsupported)
    assert decision["rung3_beats_rung2"] is False
    assert "narrow" in decision["note"] or "not yet shown" in decision["note"]


# ---------------------------------------------------------------------------
# Small-scale exhaustive reference (rung 5)
# ---------------------------------------------------------------------------

def test_small_exhaustive_rejects_vacuous_n():
    with pytest.raises(ValueError):
        hoa.run_small_exhaustive(seeds=1, n=8, waves_per_seed=8)


def test_small_exhaustive_is_optimal_at_tiny_scale():
    rows = hoa.run_small_exhaustive(seeds=1, n=9, waves_per_seed=8,
                                    wave_width=3)
    assert len(rows) == 1
    row = rows[0]
    # best_cost must not exceed either heuristic rung on the same waves
    assert row["best_cost"] <= row["rung1_frequency"]
    assert row["best_cost"] <= row["rung2_cluster"]
    assert row["gap_rung1_pct"] >= -1e-12
    assert row["gap_rung2_pct"] >= -1e-12


# ---------------------------------------------------------------------------
# Ladder row + summary structure
# ---------------------------------------------------------------------------

def test_ladder_row_structure():
    row = hoa.ladder_for_workload(128, "cluster", 55011, budget_seconds=0.2)
    assert row["schema"] == hoa.LADDER_SCHEMA
    for rung in ("rung1_frequency", "rung2_cluster",
                 "rung3_wave_improvement", "rung4_exact_tree_dp"):
        assert rung in row["heldout_totals"]
        assert row["heldout_totals"][rung] > 0
    assert set(row["orders"]) == {"rung1_frequency", "rung2_cluster",
                                  "rung3_wave_improvement",
                                  "rung4_exact_tree_dp"}
    assert row["decision"]["rung3_beats_rung2"] in (True, False)


def test_summarize_verdict_follows_cluster_family():
    rows = [hoa.ladder_for_workload(128, "cluster", 55011, budget_seconds=0.2)]
    exhaustive = hoa.run_small_exhaustive(seeds=1, n=9, waves_per_seed=8)
    summary = hoa.summarize(rows, exhaustive)
    assert summary["schema"] == hoa.LADDER_SCHEMA
    assert "cluster" in summary["family_summary"]
    cluster = summary["family_summary"]["cluster"]
    if cluster["cluster_rung3_beats_rung2_count"] == cluster["n_workloads"]:
        assert "ablation-supported" in summary["verdict"]
    else:
        assert "narrow" in summary["verdict"]


@pytest.mark.skipif(not ARTIFACT.exists(), reason="artifact not yet generated")
def test_artifact_schema_and_verdict_consistency():
    artifact = json.loads(ARTIFACT.read_text())
    assert artifact["summary"]["schema"] == hoa.LADDER_SCHEMA
    rows = artifact["rows"]
    assert len(rows) == 27  # 3 n x 3 families x 3 seeds
    cluster_rows = [r for r in rows if r["workload"]["kind"] == "cluster"]
    supported = sum(1 for r in cluster_rows
                    if r["decision"]["rung3_beats_rung2"])
    if supported == len(cluster_rows):
        assert "ablation-supported" in artifact["summary"]["verdict"]
    else:
        assert "narrow" in artifact["summary"]["verdict"]
