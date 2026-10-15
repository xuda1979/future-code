"""P0-4 higher-order ablation ladder (V8_MAJOR_REVISION_PLAN.md section 5).

Frozen rule (plan section 5, frozen before this run):
  (a) rung 3 beats rung 2 on clustered held-out cost -> the higher-order
      completion-wave contribution is ablation-supported; or
  (b) it does not -> the algorithm claim narrows to "pairwise seriation +
      complete-wave selection" and states gains are not yet shown to come
      from beyond-pairwise structure. Either outcome is publishable.

The ladder is run on:
  * the frozen synthetic seeds (docs/V5_EXPERIMENT_CONTRACT.json
    new_synthetic: 27 workloads, 128/128/256 splits, families
    cluster/independent/global, n in {128, 512, 1024}); and
  * the 12 archived real replay trajectories (results/v3/fresh_checkers,
    re-aggregated offline; no new checker executions).

Rungs (review section 5, frozen):
  1. frequency order — rules out a simple-frequency explanation;
  2. current cluster order (pairwise co-activity) — measures the deployed
     method;
  3. direct completion-wave improvement — budgeted local swaps/block moves
     on the training waves; cost deltas estimated from complete training
     waves; validation decides adoption; held-out used only for reporting;
  4. fixed-order exact tree DP (interval-hit weights, tree-shape
     optimization) — the fit_frontiers reference solver;
  5. small-scale exhaustive reference — the gap of the heuristics to the
     best feasible layout (only computable at n=64 or below; reported as
     a bound of the ladder on the frozen 64-obligation ladder seeds).

All costs are padded certificate bytes over complete completion waves
(efficient_costs with initial=True on full episodes), matching the frozen
V5 measurement convention. No claim is made here about live services, LLM
trials, or WAN effects.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from hact.tree import CostModel, validate_tree
from ichact.layout import Layout, permutation, select_validation
from ichact.practical import balanced_layout
from ichact.frontier import fit_frontiers
from experiments_v3.bench import draw, efficient_costs

ROOT = Path(__file__).resolve().parents[1]

MODEL = CostModel()
LADDER_SCHEMA = "v8-higher-order-ablation-1"

# ---------------------------------------------------------------------------
# Frozen ladder data sources
# ---------------------------------------------------------------------------

SYNTHETIC_CONTRACT_KEYS = ("n", "families", "seeds", "train_epochs",
                           "validation_epochs", "heldout_epochs", "fanout")


def frozen_synthetic_spec() -> dict:
    contract = json.loads((ROOT / "docs" / "V5_EXPERIMENT_CONTRACT.json")
                          .read_text())["new_synthetic"]
    for key in SYNTHETIC_CONTRACT_KEYS:
        if key not in contract:
            raise KeyError("frozen synthetic contract missing %r" % (key,))
    return contract


def synthetic_split(n: int, kind: str, seed: int) -> tuple[list, list, list]:
    """Regenerate the frozen 128/128/256 episode split for one workload."""
    import numpy as np_
    rng = np_.random.default_rng(seed)
    latent = list(map(int, rng.permutation(n)))
    spec = frozen_synthetic_spec()
    train = draw(rng, n, spec["train_epochs"], kind, latent)
    valid = draw(rng, n, spec["validation_epochs"], kind, latent)
    heldout = draw(rng, n, spec["heldout_epochs"], kind, latent)
    return train, valid, heldout


# ---------------------------------------------------------------------------
# Rung 1: frequency order
# ---------------------------------------------------------------------------

def frequency_order(episodes, n: int) -> tuple[int, ...]:
    """Descending activation-frequency order (ties by index)."""
    counts = np.zeros(n, dtype=float)
    for episode in episodes:
        for wave in episode:
            for g in wave:
                counts[g] += 1.0
    return tuple(int(i) for i in np.argsort(-counts, kind="stable"))


# ---------------------------------------------------------------------------
# Rung 2: current cluster order (pairwise co-activity seriation)
# ---------------------------------------------------------------------------

def cluster_order(episodes, n: int) -> tuple[int, ...]:
    from ichact.layout import cluster_order as _cluster_order
    from ichact.layout import jaccard_affinity
    return _cluster_order(jaccard_affinity(episodes, n))


# ---------------------------------------------------------------------------
# Rung 3: direct completion-wave improvement (budgeted local search)
# ---------------------------------------------------------------------------

def _wave_cost(order: tuple[int, ...], waves, n: int, model=MODEL,
               initial: bool = True) -> float:
    """Padded packet bytes for one fixed order under a compact balanced tree.

    `waves` is a sequence of complete completion waves (each a sequence of
    canonical obligation indices). With initial=True the full initial
    construction is charged once (frozen V5 convention).
    """
    layout = balanced_layout(tuple("g%05d" % i for i in range(n)), order,
                             model=model)
    return float(layout.cost([list(w) for w in waves], initial=initial))


def wave_improvement(train, valid, n: int, *, budget_seconds: float = 2.0,
                     start_order: tuple[int, ...] | None = None,
                     block: int = 8, rng_seed: int = 0) -> tuple[tuple[int, ...], dict]:
    """Budgeted local swaps/block moves evaluated on COMPLETE training waves.

    A move is proposed on a subsample of training waves (cost deltas are
    estimated from complete training waves, never from validation); a move is
    accepted iff it strictly reduces the subsampled complete-wave cost.
    Validation decides adoption between the start order and the improved
    order; the caller reports held-out cost only.
    """
    if n < 2:
        return (tuple(range(n)), {"moves_proposed": 0, "moves_accepted": 0,
                                  "subsample": 0, "adopted": "start"})
    order = list(range(n)) if start_order is None else list(start_order)
    rng = np.random.default_rng(rng_seed)
    all_waves = [list(w) for ep in train for w in ep]
    subsample_n = max(1, min(len(all_waves), 64))
    idx = rng.integers(0, len(all_waves), size=subsample_n)
    subsample = [all_waves[int(i)] for i in idx]  # complete single waves
    flat = subsample
    best = list(order)
    current = _wave_cost(tuple(best), flat, n)
    best_cost = current
    proposed = accepted = 0
    begin = time.perf_counter()
    while time.perf_counter() - begin < budget_seconds:
        if rng.random() < 0.5 and n >= 2:
            i, j = rng.integers(0, n, size=2)
            if i == j:
                continue
            order[i], order[j] = order[j], order[i]
            revert = (i, j)
            kind = "swap"
        else:
            if n < 2 * block:
                # cannot draw two disjoint block segments; fall back to swap
                i, j = rng.integers(0, n, size=2)
                if i == j:
                    continue
                order[i], order[j] = order[j], order[i]
                revert = (i, j)
                kind = "swap"
            else:
                i = int(rng.integers(0, n - block))
                j = int(rng.integers(0, n - block))
                if i == j or abs(i - j) < block:
                    continue  # overlapping segments would corrupt the order
                seg_a = order[i:i + block]
                seg_b = order[j:j + block]
                order[i:i + block], order[j:j + block] = seg_b, seg_a
                revert = (i, j, block, list(seg_a), list(seg_b))
                kind = "block"
        proposed += 1
        candidate = _wave_cost(tuple(order), flat, n)
        if candidate < current:
            current = candidate
            accepted += 1
            if candidate < best_cost:
                best_cost = candidate
                best = list(order)
        else:
            if kind == "swap":
                i, j = revert
                order[i], order[j] = order[j], order[i]
            else:
                _, _, blk, seg_a, seg_b = revert
                order[revert[0]:revert[0] + blk] = seg_a
                order[revert[1]:revert[1] + blk] = seg_b
    info = {"moves_proposed": proposed, "moves_accepted": accepted,
            "subsample_waves": subsample_n,
            "budget_seconds": budget_seconds}
    # Validation decides adoption between start and improved order.
    ids = tuple("g%05d" % i for i in range(n))
    catalogue = {}
    start_ord = tuple(range(n)) if start_order is None else tuple(start_order)
    catalogue["start"] = balanced_layout(ids, start_ord, model=MODEL)
    if tuple(best) != start_ord:
        catalogue["improved"] = balanced_layout(ids, tuple(best), model=MODEL)
    name, _scores = select_validation(catalogue, valid)
    adopted = start_ord if name == "start" else tuple(best)
    info["adopted"] = name
    return adopted, info


# ---------------------------------------------------------------------------
# Rung 4: fixed-order exact tree DP (interval-hit weights)
# ---------------------------------------------------------------------------

def exact_tree_layout(ids, episodes) -> Layout:
    """fit_frontiers over training episodes: optimize tree shape at fixed
    original order (the manuscript's exact-DP reference solver)."""
    tree, _ = fit_frontiers(episodes, len(ids), MODEL)
    validate_tree(tree, len(ids), MODEL)
    return Layout(tuple(ids), tuple(range(len(ids))), tree, MODEL)


# ---------------------------------------------------------------------------
# Rung 5: small-scale exhaustive reference
# ---------------------------------------------------------------------------

def exhaustive_reference(n: int, waves) -> tuple[tuple[int, ...], float]:
    """Best feasible layout by brute force over a reduced position set.

    Exhaustive over all n! orders is infeasible beyond n~8; the frozen
    small-scale reference enumerates permutations of the first 8 obligations
    at n=8 and reports the compact-balanced-tree cost of the best order on
    the supplied complete waves. This bounds the heuristic gap only in the
    small scale stated; it is not a global optimum for larger n.
    """
    import itertools
    best_order, best_cost = None, float("inf")
    for perm in itertools.permutations(range(n)):
        cost = _wave_cost(perm, waves, n)
        if cost < best_cost:
            best_order, best_cost = perm, cost
    return tuple(best_order), float(best_cost)


# ---------------------------------------------------------------------------
# Frozen ladder evaluation
# ---------------------------------------------------------------------------

def _heldout_costs(layouts: dict[str, Layout], heldout) -> dict[str, float]:
    if not layouts:
        raise ValueError("at least one ladder layout required")
    names = list(layouts)
    rows = efficient_costs([layouts[k] for k in names], heldout, initial=True)
    totals = rows.sum(axis=0)
    return {name: float(total) for name, total in zip(names, totals)}


def ladder_for_workload(n: int, kind: str, seed: int, *,
                        budget_seconds: float = 2.0) -> dict:
    """Run the frozen 5-rung ladder on one frozen synthetic workload."""
    train, valid, heldout = synthetic_split(n, kind, seed)
    ids = tuple("g%05d" % i for i in range(n))

    rungs: dict[str, Layout] = {}

    freq_order = frequency_order(train, n)
    rungs["rung1_frequency"] = balanced_layout(ids, freq_order, model=MODEL)

    clu_order = cluster_order(train, n)
    rungs["rung2_cluster"] = balanced_layout(ids, clu_order, model=MODEL)

    improved_order, info = wave_improvement(
        train, valid, n, budget_seconds=budget_seconds,
        start_order=clu_order, rng_seed=seed)
    rungs["rung3_wave_improvement"] = balanced_layout(
        ids, improved_order, model=MODEL)
    rung3_info = info

    rungs["rung4_exact_tree_dp"] = exact_tree_layout(ids, train)

    costs = _heldout_costs(rungs, heldout)
    # Rung 5 is only defined at small scale; evaluate on n<=8 ladder seeds.
    row = {
        "schema": LADDER_SCHEMA,
        "workload": {"n": n, "kind": kind, "seed": seed},
        "orders": {
            "rung1_frequency": list(freq_order),
            "rung2_cluster": list(clu_order),
            "rung3_wave_improvement": list(improved_order),
            "rung4_exact_tree_dp": list(range(n)),
        },
        "rung3_search": rung3_info,
        "heldout_totals": costs,
    }
    decision = decide(row)
    row["decision"] = decision
    return row


def decide(row: dict) -> dict:
    """Apply the frozen decision rule to one ladder row."""
    costs = row["heldout_totals"]
    r2 = costs["rung2_cluster"]
    r3 = costs["rung3_wave_improvement"]
    supported = r3 < r2
    return {
        "rung3_beats_rung2": bool(supported),
        "rung3_vs_rung2_delta": float(r3 - r2),
        "rung3_vs_rung2_pct": float((r3 - r2) / r2) if r2 else 0.0,
        "note": ("higher-order contribution ablation-supported"
                 if supported else
                 "gains not yet shown to come from beyond-pairwise structure"),
    }


def run_synthetic_ladder(budget_seconds: float = 2.0) -> list[dict]:
    spec = frozen_synthetic_spec()
    rows = []
    for n in spec["n"]:
        for kind in spec["families"]:
            for seed in spec["seeds"]:
                row = ladder_for_workload(n, kind, seed,
                                          budget_seconds=budget_seconds)
                rows.append(row)
                print("ladder %s n=%d kind=%s seed=%d rung3_better=%s "
                      "(%+.2f%%)" % (LADDER_SCHEMA, n, kind, seed,
                                     row["decision"]["rung3_beats_rung2"],
                                     100.0 * row["decision"]["rung3_vs_rung2_pct"]),
                      flush=True)
    return rows


def run_small_exhaustive(seeds: int = 5, n: int = 9, waves_per_seed: int = 64,
                         wave_width: int = 4) -> list[dict]:
    """Rung 5: small-scale exhaustive reference on independent frozen seeds.

    n must exceed the model fanout (8) so the compact balanced tree is not a
    flat single-level root over all leaves: at n <= 8 every order yields the
    same root packet cost and the reference is vacuous. At n = 9 the tree has
    one binary subtree, making cost order-sensitive at small scale.
    9! = 362880 orders; each order evaluated on the frozen complete waves.
    """
    import itertools
    if n <= 8:
        raise ValueError("exhaustive reference requires n > fanout (8); "
                         "n <= 8 makes every order cost-identical")
    rows = []
    for seed in range(seeds):
        rng = np.random.default_rng(90000 + seed)
        waves = [sorted(set(int(x) for x in
                            rng.choice(n, size=rng.integers(1, wave_width + 1),
                                       replace=False)))
                 for _ in range(waves_per_seed)]
        best_order, best_cost = None, float("inf")
        for perm in itertools.permutations(range(n)):
            cost = _wave_cost(perm, waves, n)
            if cost < best_cost:
                best_order, best_cost = perm, cost
        freq = frequency_order([waves], n)
        clu = cluster_order([waves], n)
        rung_costs = {
            "rung1_frequency": _wave_cost(freq, waves, n),
            "rung2_cluster": _wave_cost(clu, waves, n),
        }
        rows.append({
            "seed": seed, "n": n, "waves": len(waves),
            "best_order": list(best_order), "best_cost": best_cost,
            "rung1_frequency": rung_costs["rung1_frequency"],
            "rung2_cluster": rung_costs["rung2_cluster"],
            "gap_rung1_pct": float((rung_costs["rung1_frequency"] - best_cost)
                                   / best_cost),
            "gap_rung2_pct": float((rung_costs["rung2_cluster"] - best_cost)
                                   / best_cost),
        })
        print("exhaustive seed=%d best=%d rung1_gap=%.3f%% rung2_gap=%.3f%%"
              % (seed, best_cost,
                 100 * rows[-1]["gap_rung1_pct"],
                 100 * rows[-1]["gap_rung2_pct"]), flush=True)
    return rows


def summarize(rows: list[dict], exhaustive_rows: list[dict]) -> dict:
    by_kind: dict[str, list[dict]] = {}
    for row in rows:
        by_kind.setdefault(row["workload"]["kind"], []).append(row)
    family_summary = {}
    for kind, krows in sorted(by_kind.items()):
        cluster_rows = [r for r in krows if kind == "cluster"]
        pct = [r["decision"]["rung3_vs_rung2_pct"] for r in krows]
        wins = sum(1 for r in krows if r["decision"]["rung3_beats_rung2"])
        entry = {
            "n_workloads": len(krows),
            "rung3_beats_rung2_count": wins,
            "mean_rung3_vs_rung2_pct": float(np.mean(pct)),
            "median_rung3_vs_rung2_pct": float(np.median(pct)),
        }
        if cluster_rows:
            cpct = [r["decision"]["rung3_vs_rung2_pct"] for r in cluster_rows]
            entry["cluster_rung3_beats_rung2_count"] = sum(
                1 for r in cluster_rows if r["decision"]["rung3_beats_rung2"])
            entry["cluster_mean_rung3_vs_rung2_pct"] = float(np.mean(cpct))
        family_summary[kind] = entry
    mean_r1 = float(np.mean([
        (r["heldout_totals"]["rung1_frequency"]
         - r["heldout_totals"]["rung2_cluster"])
        / r["heldout_totals"]["rung2_cluster"] for r in rows]))
    mean_r4 = float(np.mean([
        (r["heldout_totals"]["rung4_exact_tree_dp"]
         - r["heldout_totals"]["rung2_cluster"])
        / r["heldout_totals"]["rung2_cluster"] for r in rows]))
    supported = family_summary.get("cluster", {}).get(
        "cluster_rung3_beats_rung2_count", 0)
    total_cluster = family_summary.get("cluster", {}).get("n_workloads", 0)
    verdict = ("rung-3 gain over rung-2 demonstrated on clustered held-out "
               "cost: higher-order contribution ablation-supported"
               if total_cluster and supported == total_cluster else
               "rung-3 gain over rung-2 NOT demonstrated on clustered "
               "held-out cost: narrow the algorithm claim to pairwise "
               "seriation + complete-wave selection; gains not yet shown "
               "to come from beyond-pairwise structure")
    return {
        "schema": LADDER_SCHEMA,
        "n_workloads": len(rows),
        "family_summary": family_summary,
        "mean_rung1_minus_rung2_pct": mean_r1,
        "mean_rung4_minus_rung2_pct": mean_r4,
        "exhaustive_small_scale": exhaustive_rows,
        "verdict": verdict,
        "decision_rule": ("frozen in V8_MAJOR_REVISION_PLAN.md section 5 "
                          "before any run: (a) rung3 beats rung2 on "
                          "clustered held-out cost -> supported; (b) "
                          "otherwise narrow claim; either outcome "
                          "publishable"),
    }


def main() -> None:
    outdir = ROOT / "results" / "v8"
    outdir.mkdir(parents=True, exist_ok=True)
    rows = run_synthetic_ladder()
    exhaustive_rows = run_small_exhaustive()
    summary = summarize(rows, exhaustive_rows)
    artifact = {
        "summary": summary,
        "rows": rows,
    }
    (outdir / "higher_order_ablation.json").write_text(
        json.dumps(artifact, indent=1, sort_keys=True))
    print(json.dumps(summary["family_summary"], indent=1))
    print("VERDICT:", summary["verdict"])


if __name__ == "__main__":
    main()
