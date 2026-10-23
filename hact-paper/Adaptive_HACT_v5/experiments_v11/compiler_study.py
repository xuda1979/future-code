"""Retrospective bounded-compiler ablation on the frozen v5 synthetic split.

This is a new algorithmic analysis of the same generated workloads, not new
projects, checker executions, production demand, or live-agent trials. The
primary refinement cap is 32; 64 is a separately labeled sensitivity. Both are
fixed before running. Tree-order effects and topology effects are separated;
no pairwise-only, same-topology-fit surrogate is claimed.

Run from the artifact root: python -m experiments_v11.compiler_study
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import time

import numpy as np

from experiments_v3.bench import efficient_costs
from experiments_v8.higher_order_ablation import (
    frequency_order, frozen_synthetic_spec, synthetic_split,
)
from ichact.fullwave import refine_fullwave
from ichact.layout import cluster_order, jaccard_affinity, select_validation
from ichact.practical import balanced_layout

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "results/v11"
CAPS = (32, 64)
CONTRACT = {
    "schema": "hact-v11-bounded-compiler-contract-1",
    "primary_cap": 32,
    "sensitivity_cap": 64,
    "data": "same frozen V5_EXPERIMENT_CONTRACT.json generated splits; retrospective",
    "primary_comparison": "validation-selected refined catalogue vs validation-selected historical compact catalogue",
    "additional_comparison": "refinement vs compact at the same original/pairwise order",
    "cost": "padded packet bytes, one complete initial build per episode",
    "selection": "training fits; validation selects with incumbent-first ties; heldout only scores",
    "scope": "representation cost; no service utility or higher-order causal claim",
    "tuning": "none; caps and comparisons fixed before execution",
}


def _hash(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":"),
                                    sort_keys=True).encode()).hexdigest()


def _totals(layouts, episodes):
    names = list(layouts)
    costs = efficient_costs([layouts[name] for name in names], episodes, initial=True)
    return {name: int(costs[:, j].sum()) for j, name in enumerate(names)}


def one_case(n, kind, seed):
    train, validation, heldout = synthetic_split(n, kind, seed)
    ids = tuple(f"g{i:05d}" for i in range(n))
    layouts = {"original_compact": balanced_layout(ids)}
    started = time.perf_counter()
    order = cluster_order(jaccard_affinity(train, n))
    pairwise_fit_seconds = time.perf_counter() - started
    layouts["pairwise_compact"] = balanced_layout(ids, order)
    layouts["frequency_compact"] = balanced_layout(ids, frequency_order(train, n))
    historical = {name: layouts[name] for name in ("original_compact", "pairwise_compact")}
    compact_name, compact_scores = select_validation(historical, validation)
    selected = {"historical_practical": compact_name}
    refinements = {}
    for cap in CAPS:
        candidates = dict(historical)
        refinements[str(cap)] = {}
        for parent in historical:
            name = f"{parent}_refined{cap}"
            layouts[name], info = refine_fullwave(layouts[parent], train,
                                                 max_subtree_leaves=cap)
            refinements[str(cap)][parent] = info
            candidates[name] = layouts[name]
        winner, scores = select_validation(candidates, validation)
        selected[f"fullwave{cap}"] = winner
        refinements[str(cap)]["validation_scores"] = scores
    totals = _totals(layouts, heldout)
    for name, winner in selected.items():
        totals[name] = totals[winner]
    before = totals["historical_practical"]
    return {
        "workload": {"n": n, "kind": kind, "seed": seed},
        "split_sha256": {"train": _hash(train), "validation": _hash(validation),
                         "heldout": _hash(heldout)},
        "split_sizes": {"train": len(train), "validation": len(validation), "heldout": len(heldout)},
        "selected": selected, "historical_validation_scores": compact_scores,
        "heldout_total_bytes": totals,
        "primary_saving_fraction": (before - totals["fullwave32"]) / before,
        "sensitivity_saving_fraction": (before - totals["fullwave64"]) / before,
        "pairwise_fit_seconds": pairwise_fit_seconds,
        "refinements": refinements,
        "layouts": {name: layout.to_dict() for name, layout in layouts.items()},
    }


def _aggregate(rows, comparison):
    fractions = [r[comparison] for r in rows]
    return {"workload_cells": len(rows),
            "wins": sum(x > 0 for x in fractions),
            "ties": sum(x == 0 for x in fractions),
            "losses": sum(x < 0 for x in fractions),
            "mean_saving_fraction": float(np.mean(fractions)),
            "min_saving_fraction": min(fractions),
            "max_saving_fraction": max(fractions),
            "inference": "descriptive cells; n/family reuse seeds, no independent-project inference"}


def run(*, ns=None, families=None, seeds=None):
    spec = frozen_synthetic_spec()
    ns = spec["n"] if ns is None else ns
    families = spec["families"] if families is None else families
    seeds = spec["seeds"] if seeds is None else seeds
    OUT.mkdir(parents=True, exist_ok=True)
    # Write the contract before collecting outcomes. This is a local frozen
    # analysis contract, not an externally registered prospective study.
    contract_path = OUT / "compiler_contract.json"
    contract_path.write_text(json.dumps(CONTRACT, indent=2) + "\n")
    rows = []
    for n in ns:
        for kind in families:
            for seed in seeds:
                row = one_case(n, kind, seed)
                rows.append(row)
                name = f"compiler_{kind}_{n}_{seed}.json"
                (OUT / name).write_text(json.dumps(row, indent=2, allow_nan=False) + "\n")
                print(f"compiler n={n} kind={kind} seed={seed} "
                      f"primary={100*row['primary_saving_fraction']:+.3f}% "
                      f"sensitivity={100*row['sensitivity_saving_fraction']:+.3f}%", flush=True)
    inputs = ["docs/V5_EXPERIMENT_CONTRACT.json", "experiments_v3/bench.py",
              "experiments_v8/higher_order_ablation.py", "ichact/fullwave.py",
              "ichact/layout.py", "ichact/practical.py", "hact/tree.py",
              "experiments_v11/compiler_study.py"]
    try:
        base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        base = None
    result = {"schema": "hact-v11-bounded-compiler-study-1", "contract": CONTRACT,
              "contract_sha256": _hash(CONTRACT), "base_commit": base,
              "environment": {"python": sys.version, "platform": platform.platform(),
                              "numpy": np.__version__, "timing": "one local host; descriptive fit timings"},
              "input_sha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                               for name in inputs},
              "primary": _aggregate(rows, "primary_saving_fraction"),
              "sensitivity": _aggregate(rows, "sensitivity_saving_fraction"),
              "by_family": {kind: {"primary": _aggregate([r for r in rows if r["workload"]["kind"] == kind],
                                                          "primary_saving_fraction"),
                                    "sensitivity": _aggregate([r for r in rows if r["workload"]["kind"] == kind],
                                                              "sensitivity_saving_fraction")}
                            for kind in families},
              "case_files": [f"compiler_{r['workload']['kind']}_{r['workload']['n']}_{r['workload']['seed']}.json"
                             for r in rows]}
    (OUT / "compiler_study.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n", nargs="+", type=int)
    parser.add_argument("--families", nargs="+", choices=("cluster", "independent", "global"))
    parser.add_argument("--seeds", nargs="+", type=int)
    args = parser.parse_args()
    run(ns=args.n, families=args.families, seeds=args.seeds)
