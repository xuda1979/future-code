"""Frozen journal-extension replication and robustness study for Adaptive HACT.

The experiment contract is committed before the full run. Results retain
seed-level summaries and hashes; complete synthetic waves are deterministic
from the contract, generator, and repository revision and can be regenerated.
"""
from __future__ import annotations

from pathlib import Path
import hashlib
import json
import math
import os
import platform
import statistics
import time

import numpy as np

from ichact.practical import balanced_layout
from ichact.layout import cluster_order, jaccard_affinity
from experiments_v3.bench import draw, efficient_costs

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "docs/V6_JOURNAL_EXPERIMENT_CONTRACT.json"
OUT = ROOT / "results/v6"
GEN = ROOT / "paper/generated_v6"
FIG = ROOT / "paper/figures/v6_journal_extension.pdf"


def canonical_hash(value) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def marginal_order(training, n: int) -> tuple[int, ...]:
    counts = np.zeros(n, dtype=np.int64)
    for episode in training:
        for wave in episode:
            if wave:
                counts[list(set(wave))] += 1
    return tuple(sorted(range(n), key=lambda i: (-int(counts[i]), i)))


def choose(names, totals):
    best = names[0]
    for name in names[1:]:
        if totals[name] < totals[best]:
            best = name
    return best


def totals(layouts, episodes):
    names = list(layouts)
    values = efficient_costs(
        [layouts[name] for name in names], episodes, initial=True
    ).sum(axis=0)
    return {name: int(round(value)) for name, value in zip(names, values)}


def reduction(value: int, baseline: int) -> float:
    return 100.0 * (1.0 - value / baseline)


def bootstrap_mean(values, resamples: int, seed: int):
    x = np.asarray(values, dtype=float)
    rng = np.random.default_rng(seed)
    sampled = x[rng.integers(0, len(x), size=(resamples, len(x)))]
    means = sampled.mean(axis=1)
    lo, hi = np.quantile(means, [0.025, 0.975])
    return [float(lo), float(hi)]


def sign_test_one_sided(values, threshold=0.0):
    positives = sum(v > threshold for v in values)
    negatives = sum(v < threshold for v in values)
    n = positives + negatives
    if n == 0:
        return None
    tail = sum(math.comb(n, k) for k in range(positives, n + 1)) / (2**n)
    return float(tail)


def metric_summary(values, stats, seed: int):
    x = list(map(float, values))
    positive_threshold = stats["positive_threshold_percent"]
    regression_threshold = stats["regression_threshold_percent"]
    return {
        "mean": float(statistics.mean(x)),
        "median": float(statistics.median(x)),
        "ci95_mean": bootstrap_mean(x, stats["bootstrap_resamples"], seed),
        "range": [float(min(x)), float(max(x))],
        "regressions": sum(v < regression_threshold for v in x),
        "positive": sum(v > positive_threshold for v in x),
        "zero": sum(abs(v) <= positive_threshold for v in x),
        "sign_test_one_sided_p": sign_test_one_sided(x, 0.0),
        "n": len(x),
    }


def run_normal(contract):
    rows = []
    cfg = contract["normal"]
    for n in cfg["n"]:
        for kind in cfg["families"]:
            for seed in cfg["seeds"]:
                rng = np.random.default_rng(seed)
                latent = tuple(map(int, rng.permutation(n)))
                train = draw(rng, n, cfg["train_epochs"], kind, latent)
                valid = draw(rng, n, cfg["validation_epochs"], kind, latent)
                test = draw(rng, n, cfg["heldout_epochs"], kind, latent)
                ids = tuple(f"obligation-{i:04d}" for i in range(n))

                incumbent = balanced_layout(ids, fanout=cfg["fanout"])
                start = time.perf_counter()
                learned_order = cluster_order(jaccard_affinity(train, n))
                learned = balanced_layout(ids, learned_order, fanout=cfg["fanout"])
                fit_seconds = time.perf_counter() - start
                marginal = balanced_layout(
                    ids, marginal_order(train, n), fanout=cfg["fanout"]
                )
                oracle = balanced_layout(ids, latent, fanout=cfg["fanout"])

                rrng = np.random.default_rng(seed + cfg["random_seed_offset"])
                randoms = {
                    f"random_{j}": balanced_layout(
                        ids, tuple(map(int, rrng.permutation(n))), fanout=cfg["fanout"]
                    )
                    for j in range(cfg["random_order_baselines"])
                }
                layouts = {
                    "incumbent": incumbent,
                    "learned": learned,
                    "marginal": marginal,
                    "oracle": oracle,
                    **randoms,
                }
                validation_totals = totals(layouts, valid)
                heldout_totals = totals(layouts, test)
                practical = choose(["incumbent", "learned"], validation_totals)
                marginal_validated = choose(
                    ["incumbent", "marginal"], validation_totals
                )
                random_validated = choose(
                    ["incumbent", *randoms.keys()], validation_totals
                )
                base = heldout_totals["incumbent"]
                metrics = {
                    "practical_reduction": reduction(
                        heldout_totals[practical], base
                    ),
                    "unvalidated_reduction": reduction(
                        heldout_totals["learned"], base
                    ),
                    "marginal_reduction": reduction(
                        heldout_totals[marginal_validated], base
                    ),
                    "random_reduction": reduction(
                        heldout_totals[random_validated], base
                    ),
                    "oracle_reduction": reduction(heldout_totals["oracle"], base),
                }
                rows.append(
                    {
                        "n": n,
                        "kind": kind,
                        "seed": seed,
                        "selected": practical,
                        "marginal_selected": marginal_validated,
                        "random_selected": random_validated,
                        "fit_seconds": fit_seconds,
                        "orders": {
                            "learned": list(learned_order),
                            "marginal": list(marginal.order),
                            "oracle": list(latent),
                            **{name: list(layout.order) for name, layout in randoms.items()},
                        },
                        "validation_totals": validation_totals,
                        "heldout_totals": heldout_totals,
                        "metrics": metrics,
                        "data_sha256": {
                            "training": canonical_hash(train),
                            "validation": canonical_hash(valid),
                            "heldout": canonical_hash(test),
                        },
                    }
                )
                print(
                    "normal", n, kind, seed, practical,
                    round(metrics["practical_reduction"], 4), flush=True
                )
    return rows


def run_shift(contract):
    rows = []
    cfg = contract["shift"]
    for n in cfg["n"]:
        for seed in cfg["seeds"]:
            rng_a = np.random.default_rng(seed)
            latent_a = tuple(map(int, rng_a.permutation(n)))
            train_a = draw(rng_a, n, cfg["train_epochs_A"], cfg["family"], latent_a)
            valid_a = draw(rng_a, n, cfg["validation_epochs_A"], cfg["family"], latent_a)

            rng_b = np.random.default_rng(seed + cfg["second_regime_seed_offset"])
            latent_b = tuple(map(int, rng_b.permutation(n)))
            train_b = draw(rng_b, n, cfg["train_epochs_B"], cfg["family"], latent_b)
            valid_b = draw(rng_b, n, cfg["validation_epochs_B"], cfg["family"], latent_b)
            test_b = draw(rng_b, n, cfg["heldout_epochs_B"], cfg["family"], latent_b)

            ids = tuple(f"obligation-{i:04d}" for i in range(n))
            incumbent = balanced_layout(ids, fanout=cfg["fanout"])
            start = time.perf_counter()
            order_a = cluster_order(jaccard_affinity(train_a, n))
            learned_a = balanced_layout(ids, order_a, fanout=cfg["fanout"])
            fit_a = time.perf_counter() - start
            start = time.perf_counter()
            order_b = cluster_order(jaccard_affinity(train_b, n))
            learned_b = balanced_layout(ids, order_b, fanout=cfg["fanout"])
            fit_b = time.perf_counter() - start
            oracle_b = balanced_layout(ids, latent_b, fanout=cfg["fanout"])

            validation_a = totals(
                {"incumbent": incumbent, "learnedA": learned_a}, valid_a
            )
            validation_b = totals(
                {"incumbent": incumbent, "learnedB": learned_b}, valid_b
            )
            heldout_b = totals(
                {
                    "incumbent": incumbent,
                    "learnedA": learned_a,
                    "learnedB": learned_b,
                    "oracleB": oracle_b,
                },
                test_b,
            )
            stale = choose(["incumbent", "learnedA"], validation_a)
            retuned = choose(["incumbent", "learnedB"], validation_b)
            base = heldout_b["incumbent"]
            metrics = {
                "stale_reduction": reduction(heldout_b[stale], base),
                "retuned_reduction": reduction(heldout_b[retuned], base),
                "oracle_reduction": reduction(heldout_b["oracleB"], base),
            }
            metrics["retuning_gain"] = (
                metrics["retuned_reduction"] - metrics["stale_reduction"]
            )
            rows.append(
                {
                    "n": n,
                    "seed": seed,
                    "stale_selected": stale,
                    "retuned_selected": retuned,
                    "fit_seconds_A": fit_a,
                    "fit_seconds_B": fit_b,
                    "orders": {
                        "learnedA": list(order_a),
                        "learnedB": list(order_b),
                        "oracleB": list(latent_b),
                    },
                    "validation_A": validation_a,
                    "validation_B": validation_b,
                    "heldout_B": heldout_b,
                    "metrics": metrics,
                    "data_sha256": {
                        "trainA": canonical_hash(train_a),
                        "validA": canonical_hash(valid_a),
                        "trainB": canonical_hash(train_b),
                        "validB": canonical_hash(valid_b),
                        "testB": canonical_hash(test_b),
                    },
                }
            )
            print(
                "shift", n, seed,
                round(metrics["stale_reduction"], 4),
                round(metrics["retuned_reduction"], 4), flush=True
            )
    return rows


def summarize(contract, rows, shifts):
    stats = contract["statistics"]
    out = {
        "schema": "hact-v6-journal-summary-1",
        "experiment_id": contract["experiment_id"],
        "source_commit": os.environ.get("GITHUB_SHA"),
        "contract_sha256": canonical_hash(contract),
        "normal_workloads": len(rows),
        "shift_workloads": len(shifts),
        "normal": [],
        "shift": [],
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "numpy": np.__version__,
        },
    }
    method_keys = [
        "practical_reduction",
        "unvalidated_reduction",
        "marginal_reduction",
        "random_reduction",
        "oracle_reduction",
    ]
    family_index = {k: i for i, k in enumerate(contract["normal"]["families"])}
    for n in contract["normal"]["n"]:
        for kind in contract["normal"]["families"]:
            group = [r for r in rows if r["n"] == n and r["kind"] == kind]
            item = {"n": n, "kind": kind, "seeds": len(group), "methods": {}}
            for j, key in enumerate(method_keys):
                values = [r["metrics"][key] for r in group]
                item["methods"][key] = metric_summary(
                    values, stats,
                    stats["bootstrap_seed"] + n + 1000 * family_index[kind] + j,
                )
            item["fit_seconds_median"] = float(
                statistics.median(r["fit_seconds"] for r in group)
            )
            item["practical_changed"] = sum(
                r["selected"] != "incumbent" for r in group
            )
            item["guard_avoided_regressions"] = sum(
                r["metrics"]["unvalidated_reduction"]
                < stats["regression_threshold_percent"]
                and r["metrics"]["practical_reduction"]
                >= stats["regression_threshold_percent"]
                for r in group
            )
            if kind == "cluster":
                ratios = [
                    r["metrics"]["practical_reduction"]
                    / r["metrics"]["oracle_reduction"]
                    for r in group
                    if r["metrics"]["oracle_reduction"] > 1e-9
                ]
                item["oracle_capture_fraction_mean"] = (
                    float(statistics.mean(ratios)) if ratios else None
                )
            out["normal"].append(item)

    for n in contract["shift"]["n"]:
        group = [r for r in shifts if r["n"] == n]
        item = {"n": n, "seeds": len(group), "methods": {}}
        for j, key in enumerate(
            ["stale_reduction", "retuned_reduction", "oracle_reduction", "retuning_gain"]
        ):
            item["methods"][key] = metric_summary(
                [r["metrics"][key] for r in group],
                stats, stats["bootstrap_seed"] + 50000 + n + j,
            )
        item["stale_changed"] = sum(
            r["stale_selected"] != "incumbent" for r in group
        )
        item["retuned_changed"] = sum(
            r["retuned_selected"] != "incumbent" for r in group
        )
        item["retuned_better_seeds"] = sum(
            r["metrics"]["retuning_gain"] > 1e-9 for r in group
        )
        out["shift"].append(item)
    return out


def write_generated(summary):
    GEN.mkdir(parents=True, exist_ok=True)
    normal = {(x["n"], x["kind"]): x for x in summary["normal"]}

    def cell(method):
        lo, hi = method["ci95_mean"]
        return f'{method["mean"]:.2f} [{lo:.2f},{hi:.2f}]'

    with (GEN / "replication.tex").open("w") as handle:
        for n in (128, 512, 1024):
            item = normal[(n, "cluster")]
            handle.write(
                f'{n:,} & {cell(item["methods"]["practical_reduction"])}'
                f' & {cell(item["methods"]["marginal_reduction"])}'
                f' & {cell(item["methods"]["random_reduction"])}'
                f' & {cell(item["methods"]["oracle_reduction"])}'
                f' & {item["methods"]["practical_reduction"]["regressions"]}/20 \\\n'
            )
    with (GEN / "nulls.tex").open("w") as handle:
        for n in (128, 512, 1024):
            for kind in ("independent", "global"):
                item = normal[(n, kind)]
                method = item["methods"]["practical_reduction"]
                lo, hi = method["ci95_mean"]
                handle.write(
                    f'{n:,} & {kind} & {method["mean"]:.3f}'
                    f' & [{lo:.3f},{hi:.3f}]'
                    f' & {item["practical_changed"]}/20'
                    f' & {method["regressions"]}/20 \\\n'
                )
    with (GEN / "shift.tex").open("w") as handle:
        for item in summary["shift"]:
            handle.write(
                f'{item["n"]:,} & {cell(item["methods"]["stale_reduction"])}'
                f' & {cell(item["methods"]["retuned_reduction"])}'
                f' & {cell(item["methods"]["oracle_reduction"])}'
                f' & {item["methods"]["stale_reduction"]["regressions"]}/20'
                f' & {item["methods"]["retuned_reduction"]["regressions"]}/20 \\\n'
            )


def make_figure(summary):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    normal = {(x["n"], x["kind"]): x for x in summary["normal"]}
    ns = [128, 512, 1024]
    fig, axes = plt.subplots(1, 2, figsize=(9.2, 3.6))
    ax = axes[0]
    for key, label in [
        ("practical_reduction", "validated learned"),
        ("marginal_reduction", "marginal-only"),
        ("random_reduction", "validated random"),
        ("oracle_reduction", "latent oracle"),
    ]:
        means = [normal[(n, "cluster")]["methods"][key]["mean"] for n in ns]
        lo = [normal[(n, "cluster")]["methods"][key]["ci95_mean"][0] for n in ns]
        hi = [normal[(n, "cluster")]["methods"][key]["ci95_mean"][1] for n in ns]
        yerr = np.vstack(
            (np.asarray(means) - np.asarray(lo), np.asarray(hi) - np.asarray(means))
        )
        ax.errorbar(range(len(ns)), means, yerr=yerr, marker="o", capsize=3, label=label)
    ax.axhline(0, linewidth=0.8)
    ax.set_xticks(range(len(ns)), [str(n) for n in ns])
    ax.set_xlabel("registry size")
    ax.set_ylabel("held-out reduction vs fixed8 (%)")
    ax.set_title("Disjoint-seed replication: clustered waves")
    ax.legend(fontsize=8)

    ax = axes[1]
    shift = {x["n"]: x for x in summary["shift"]}
    for key, label in [
        ("stale_reduction", "stale layout"),
        ("retuned_reduction", "retuned"),
        ("oracle_reduction", "latent oracle"),
    ]:
        means = [shift[n]["methods"][key]["mean"] for n in ns]
        lo = [shift[n]["methods"][key]["ci95_mean"][0] for n in ns]
        hi = [shift[n]["methods"][key]["ci95_mean"][1] for n in ns]
        yerr = np.vstack(
            (np.asarray(means) - np.asarray(lo), np.asarray(hi) - np.asarray(means))
        )
        ax.errorbar(range(len(ns)), means, yerr=yerr, marker="o", capsize=3, label=label)
    ax.axhline(0, linewidth=0.8)
    ax.set_xticks(range(len(ns)), [str(n) for n in ns])
    ax.set_xlabel("registry size")
    ax.set_ylabel("held-out reduction vs fixed8 (%)")
    ax.set_title("Distribution shift and retuning")
    ax.legend(fontsize=8)
    fig.tight_layout()
    FIG.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(FIG, bbox_inches="tight")
    plt.close(fig)


def main():
    contract = json.loads(CONTRACT_PATH.read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    rows = run_normal(contract)
    shifts = run_shift(contract)
    summary = summarize(contract, rows, shifts)
    (OUT / "journal_extension.json").write_text(
        json.dumps(
            {
                "experiment_id": contract["experiment_id"],
                "source_commit": os.environ.get("GITHUB_SHA"),
                "contract_sha256": canonical_hash(contract),
                "normal": rows,
                "shift": shifts,
            },
            indent=2,
        )
    )
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2))
    write_generated(summary)
    make_figure(summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
