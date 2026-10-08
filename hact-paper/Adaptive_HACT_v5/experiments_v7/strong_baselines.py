"""Prospective strong-baseline audit over the *archived* HACT v5 observations.

No new checker, live LLM, WAN, tokenizer, or project run is claimed.
This is a new analysis of frozen records, with never-seen test waves used
only to score candidates, not to fit or select them.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import statistics
import zlib
from pathlib import Path

from hact.certificates import canonical, digest
from ichact.layout import Layout
from ichact.practical import balanced_layout

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results" / "v5"
METHODS = ("incumbent", "selected", "frequency", "random_median", "random_best_oracle")


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _seed(n: int, kind: str, seed: int, salt: int) -> int:
    material = f"{n}:{kind}:{seed}:{salt}".encode("ascii")
    return int.from_bytes(hashlib.sha256(material).digest()[:8], "big")


def _validate_split(row: dict):
    n = row["n"]
    for name in ("train", "validation", "heldout"):
        data = row[name]
        if not data:
            raise ValueError(f"{name}: empty")
        for ep in data:
            if not isinstance(ep, list):
                raise ValueError("episode must be a list")
            for wave in ep:
                if any(type(i) is not int or not 0 <= i < n for i in wave):
                    raise ValueError(f"{name}: invalid ID")
    if "incumbent" not in row["layouts"] or row["selected"] not in row["layouts"]:
        raise ValueError("missing comparison layout")


def _frequency_layout(row: dict):
    n = row["n"]
    freq = [0] * n
    for ep in row["train"]:
        for wave in ep:
            for i in set(wave):
                freq[i] += 1
    ordered = tuple(sorted(range(n), key=lambda i: (-freq[i], i)))
    return balanced_layout(tuple(row["layouts"]["incumbent"]["registry"]), ordered)


def _score(layout: Layout, episodes: list) -> int:
    # Match exactly the frozen initial+completion-wave cost in the v5 contract.
    return sum(layout.cost(ep) for ep in episodes)


def synthetic_strong_baselines(rows, random_layouts=8):
    """No selection on held-out. Random best is explicitly a hindsight oracle."""
    if random_layouts < 2:
        raise ValueError("two or more random controls required")
    results = []
    for row in rows:
        _validate_split(row)
        layouts = {key: Layout.from_dict(obj) for key, obj in row["layouts"].items()}
        incumbent = layouts["incumbent"]
        selected = layouts[row["selected"]]
        # Verify our scoring implementation matches the published raw result.
        for key, layout in layouts.items():
            observed = _score(layout, row["heldout"])
            if observed != row["heldout_totals"][key]:
                raise ValueError(f"frozen score mismatch: {row['n']}/{row['kind']}/{row['seed']}/{key}")
        frequency = _frequency_layout(row)
        rng = random.Random(_seed(row["n"], row["kind"], row["seed"], 2037))
        random_costs = []
        ids = incumbent.registry
        for _ in range(random_layouts):
            order = list(range(row["n"]))
            rng.shuffle(order)
            random_costs.append(_score(balanced_layout(ids, tuple(order)), row["heldout"]))
        costs = {
            "incumbent": _score(incumbent, row["heldout"]),
            "selected": _score(selected, row["heldout"]),
            "frequency": _score(frequency, row["heldout"]),
            "random_median": statistics.median(random_costs),
            "random_best_oracle": min(random_costs),
        }
        norm = costs["incumbent"]
        results.append({
            "n": row["n"], "family": row["kind"], "seed": row["seed"],
            "selected_name": row["selected"],
            "source": "archived_v5_synthetic_holdout",
            "random_controls": random_layouts,
            "cost_bytes": costs,
            "reduction_percent": {k: 100 * (1 - v / norm) for k, v in costs.items()},
        })
    return results


def _flat_serialization(evidence: dict, report: dict):
    """Standalone leaf-event service. DOES NOT contain internal-node certificates."""
    registry = evidence["registry"]
    executed = evidence["executed"]
    records = evidence["records"]
    if len(set(registry)) != len(registry) or len(set(executed)) != len(executed):
        raise ValueError("duplicate semantic obligation or completion")
    if (not set(executed).issubset(set(registry)) or
            not set(executed).issubset(set(records))):
        raise ValueError("incomplete or foreign archived checker records")
    if len(executed) != report["executed"] or len(registry) != report["required"]:
        raise ValueError("archived execution/count contract mismatch")
    binding = {k: report[k] for k in ("snapshot", "checker", "environment", "registry_hash")}
    stream = [canonical({"schema": "flat-evidence-1", "kind": "contract", "required": len(registry), "registry_ids": registry, **binding}) + b"\n"]
    for start in range(0, len(executed), 8):
        # Same actual completion batch boundaries as v5 HACT source replay.
        batch = [{"id": g, "status": records[g]["status"], "trace": digest(records[g])}
                 for g in executed[start:start + 8]]
        stream.append(canonical({"schema": "flat-evidence-1", "kind": "completion",
                                 "batch": start // 8, "records": batch}) + b"\n")
    stream.append(canonical({"schema": "flat-evidence-1", "kind": "final",
                             "counts": report["counts"], "verdict": report["verdict"],
                             "locally_authorized": report["locally_authorized"]}) + b"\n")
    return stream


def flat_ledger_controls(rows):
    """Measured Python serialization/DEFLATE bytes, not WAN transport timings."""
    keys = sorted({(r["project"], r["id"]) for r in rows})
    outcomes = []
    for project, case in keys:
        group = {r["method"]: r for r in rows if (r["project"], r["id"]) == (project, case)}
        if set(group) != {"fixed8", "learned_balanced", "learned_exact"}:
            raise ValueError("incomplete layout triple")
        base = group["fixed8"]
        ref = group["learned_balanced"]
        for method in group:
            if group[method]["root_sha256"] != ref["root_sha256"]:
                raise ValueError("root status differs across layouts")
        ep = ROOT / base["original_evidence"]
        if hashlib.sha256(ep.read_bytes()).hexdigest() != base["original_evidence_sha256"]:
            raise ValueError("archived evidence hash mismatch")
        evidence = _json(ep)
        report_path = ROOT / ref["source"] / "report.json"
        report = _json(report_path)
        stream = _flat_serialization(evidence, report)
        baseline = {
            "flat_canonical_bytes": sum(len(x) for x in stream),
            "flat_batch_zlib_bytes": len(zlib.compress(b"".join(stream), 6)),
            "flat_packet_zlib_bytes": sum(len(zlib.compress(x, 6)) for x in stream),
            "flat_events": len(stream),
        }
        # Explicitly compare archive bytes for DIFFERENT diagnostic capabilities.
        # HACT has internal aggregate certificate packets; flat has leaf records.
        outcomes.append({
            "project": project, "case": case, "source": "archived_source_checker_replay",
            "service_equivalence": False,
            "flat": baseline,
            "hact_fixed_batch_zlib_bytes": group["fixed8"]["wire_bytes"]["batch_zlib"],
            "hact_learned_batch_zlib_bytes": ref["wire_bytes"]["batch_zlib"],
            "hact_learned_diagnostic_pages": ref["diagnostic_pages"],
            "root_status_bytes": ref["root_prompt_bytes"],
            "root_status_identical": True,
        })
    return outcomes


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--random-layouts", type=int, default=8)
    args = p.parse_args()
    if args.output.exists():
        raise ValueError("refuse overwrite existing evidence; use a new output")
    synthetic = synthetic_strong_baselines(_json(RESULTS / "practical.json"), args.random_layouts)
    source = flat_ledger_controls(_json(RESULTS / "source_replay.json"))
    summary = []
    for n in (128, 512, 1024):
        for family in ("cluster", "independent", "global"):
            subset = [x for x in synthetic if x["n"] == n and x["family"] == family]
            if len(subset) != 3:
                raise ValueError("unexpected three-seed split")
            summary.append({"n": n, "family": family, "seeds": len(subset),
                "mean_reduction_percent": {method: statistics.mean(
                    x["reduction_percent"][method] for x in subset) for method in METHODS},
                "minmax_selected_percent": [min(x["reduction_percent"]["selected"] for x in subset),
                                              max(x["reduction_percent"]["selected"] for x in subset)]})
    output = {
        "schema": "hact-v7-strong-baselines-1",
        "provenance": "new deterministic analysis of frozen v5 observations",
        "new_checker_executions": 0, "live_llm_trials": 0,
        "physical_wan_trials": 0, "actual_tokenizer_measurements": None,
        "service_warning": "Flat final-state/event ledger cannot provide equivalent authenticated hierarchical diagnostic packets. Direct byte ratios are not a matched-service productivity or network comparison.",
        "synthetic": synthetic, "summary": summary, "source_flat_controls": source,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"synthetic_rows": len(synthetic), "source_cases": len(source),
                      "source": output["provenance"], "output": str(args.output)}, indent=2))


if __name__ == "__main__":
    main()
