"""Retrospective descriptive checks of immutable v11 observations.

This launches no experiments and imports no HACT scoring or service helper.
Ratios use rational arithmetic on the recorded decimal elapsed times. They
describe matched timing blocks on one host, not independent replications or
confidence intervals. Full v11 raw-record correctness remains the remit of
audit.check_v11_compiler; this projection adds timing and pattern sensitivity.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from decimal import Decimal
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARMS = ("indexed", "counter", "hact_original", "hact_selected")
QUERIES = ("Q1", "Q2", "Q3", "Q4", "Q5", "Q6a", "Q6b")
SOURCES = ("results/v11/service_study.json",
           "results/v11/public_compiler/SERVICE_CASES.json",
           "results/v11/public_compiler/SUMMARY.json")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, label, *, zero=False):
    require(type(value) in (int, float, Decimal), f"{label}: numeric value required")
    require(math.isfinite(value), f"{label}: finite value required")
    result = Fraction(str(value))
    require(result >= 0 if zero else result > 0, f"{label}: invalid sign")
    return result


def median(values):
    values = sorted(values)
    require(bool(values), "empty median")
    middle = len(values) // 2
    return values[middle] if len(values) % 2 else (values[middle - 1] + values[middle]) / 2


def ratio(value):
    return {"value": float(value), "exact_decimal_ratio": str(value)}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def completion_signature(evidence, width=8):
    """Hash the objective's wave multiset separately from chronology."""
    require(type(width) is int and width > 0, "positive integer wave width required")
    registry, executed = evidence["registry"], evidence["executed"]
    require(bool(registry) and len(set(registry)) == len(registry), "invalid registry")
    require(len(executed) == len(registry) and len(set(executed)) == len(executed)
            and set(executed) == set(registry), "complete unique execution required")
    require(set(evidence["records"]) == set(executed), "record/completion mismatch")
    waves = [sorted(executed[i:i + width]) for i in range(0, len(executed), width)]
    return {"checks": len(registry), "waves": len(waves),
            "completion_order_sha256": digest(executed),
            "ordered_wave_sets_sha256": digest(waves),
            "objective_wave_multiset_sha256": digest(sorted(waves))}


def query_signature(execution, n):
    total_waves = (n + 7) // 8
    epochs = sorted({0, max(1, total_waves // 2), total_waves})
    expected = [(e, q, phase) for e in epochs for q in QUERIES for phase in ("cold", "warm")]
    queries = execution["queries"]
    require([(q["epoch"], q["query"], q["phase"]) for q in queries] == expected,
            "missing, reordered or duplicate query slot")
    result, elapsed = [], Fraction(0)
    for q in queries:
        elapsed += number(q["seconds"], "query seconds", zero=True)
        require(isinstance(q["semantic_sha256"], str) and len(q["semantic_sha256"]) == 64
                and all(c in "0123456789abcdef" for c in q["semantic_sha256"]), "invalid answer digest")
        for field in ("raw_bytes", "wire_bytes", "pages"):
            require(type(q[field]) is int and q[field] >= (1 if field == "pages" else 0),
                    f"invalid {field}")
        result.append(tuple(q[k] for k in ("epoch", "query", "phase", "semantic_sha256",
                                          "raw_bytes", "wire_bytes", "pages")))
    reported = number(execution["query_seconds"], "query sum", zero=True)
    require(abs(elapsed - reported) <= Fraction(1, 10**9), "query-time sum differs")
    total = number(execution["service_operation_seconds"], "operation seconds")
    require(total >= elapsed - Fraction(1, 10**9), "operation sum smaller than queries")
    return result


def analyze_service(study, expected_cases):
    require(study.get("repeats") == 3, "unexpected repeat contract")
    expected = {row["case"]: row for row in expected_cases}
    require(len(expected) == len(expected_cases), "duplicate case in manifest")
    rows = study["cases"]
    require(len(rows) == len(expected) and {x["case"] for x in rows} == set(expected),
            "case cohort differs from frozen manifest")
    cases, excluded, project_parts = [], [], defaultdict(list)
    every_ratio, max_spread = [], Fraction(0)
    max_aggregation_difference = Fraction(0)
    for case in rows:
        identity = expected[case["case"]]
        for field in ("project", "evidence", "report", "layout"):
            require(case[field] == identity[field], "case identity differs")
        require(type(case["n"]) is int and case["n"] > 0, "invalid registry size")
        require(case["status"] in ("PASS", "UNKNOWN"), "unhandled case status")
        if case["status"] == "UNKNOWN":
            require(bool(case.get("reason")) and case["repetitions"] == [],
                    "unknown resource case must remain explicit and unmeasured")
            excluded.append({"project": case["project"], "case": case["case"],
                             "status": "UNKNOWN", "reason": case["reason"]})
            continue
        repeats = case["repetitions"]
        require([r["repetition"] for r in repeats] == list(range(3)), "repeat identities differ")
        seconds = {arm: [] for arm in ARMS}
        pairs, signature = [], None
        for block in repeats:
            executions = block["executions"]
            require(len(executions) == 4 and set(block["arm_order"]) == set(ARMS)
                    and [x["arm"] for x in executions] == block["arm_order"], "arm pairing differs")
            for ex in executions:
                require(ex["status"] == "PASS", "passing case contains nonpassing arm")
                require(ex.get("input_preparation_and_oracle_seconds_excluded") is True,
                        "timing boundary differs")
                current = query_signature(ex, case["n"])
                if signature is None:
                    signature = current
                require(current == signature, "answer or codec signature differs")
                seconds[ex["arm"]].append(number(ex["service_operation_seconds"], "operation seconds"))
            pairs.append(seconds["hact_selected"][-1] / seconds["counter"][-1])
        h, c = seconds["hact_selected"], seconds["counter"]
        hp, cp = median(h), median(c)
        paired_median, ratio_medians = median(pairs), hp / cp
        aggregation_difference = abs(ratio_medians / paired_median - 1)
        max_aggregation_difference = max(max_aggregation_difference, aggregation_difference)
        spread_h, spread_c = max(h) / min(h), max(c) / min(c)
        max_spread = max(max_spread, spread_h, spread_c)
        every_ratio.extend(pairs)
        project_parts[case["project"]].append((hp, cp))
        cases.append({"project": case["project"], "case": case["case"],
            "paired_ratios": [ratio(x) for x in pairs],
            "paired_ratio_min": ratio(min(pairs)), "paired_ratio_max": ratio(max(pairs)),
            "median_paired_ratio": ratio(paired_median), "ratio_of_arm_medians": ratio(ratio_medians),
            "aggregation_relative_difference": ratio(aggregation_difference),
            "hact_seconds": [float(x) for x in h], "counter_seconds": [float(x) for x in c],
            "hact_max_min": ratio(spread_h), "counter_max_min": ratio(spread_c),
            "all_paired_hact_slower": all(x > 1 for x in pairs)})
    require(bool(every_ratio), "no admitted timing pairs")
    require(study["status"] == ("UNKNOWN" if excluded else "PASS"), "cohort status hides unknowns")
    projects = [{"project": p, "cases": len(values),
                 "ratio_of_mean_case_medians": ratio(sum(h for h, _ in values) / sum(c for _, c in values))}
                for p, values in sorted(project_parts.items())]
    return {"admitted_cases": len(cases), "admitted_projects": len(project_parts),
            "matched_timing_blocks": len(every_ratio), "excluded": excluded,
            "paired_ratio_min": ratio(min(every_ratio)), "paired_ratio_max": ratio(max(every_ratio)),
            "all_paired_hact_slower": all(x > 1 for x in every_ratio),
            "maximum_within_case_arm_max_min": ratio(max_spread),
            "maximum_aggregation_relative_difference": ratio(max_aggregation_difference),
            "cases": cases, "project_summaries": projects}


def build_report(root=ROOT):
    contents = {name: (root / name).read_bytes() for name in SOURCES}
    service, case_manifest, compiler = [json.loads(contents[p], parse_float=Decimal) for p in SOURCES]
    require(service["input_manifest_sha256"] == hashlib.sha256(contents[SOURCES[1]]).hexdigest(),
            "service case manifest hash differs")
    result = analyze_service(service, case_manifest)
    require({p["project"] for p in compiler["projects"] if p["status"] == "PASS"}
            == {p["project"] for p in result["project_summaries"]},
            "compiler and service admitted-project cohorts differ")
    for case in service["cases"]:
        for field in ("evidence", "report", "layout"):
            require(hashlib.sha256((root / case[field]).read_bytes()).hexdigest()
                    == case["input_hashes"][field], "service input hash differs")
    completion = []
    for project in compiler["projects"]:
        traces = []
        for run in range(5):
            name = f"results/v11/public_checks_normalized/{project['project']}/run_{run}/pytest_evidence.json"
            raw = (root / name).read_bytes()
            traces.append({"run": run, "input": name, "input_sha256": hashlib.sha256(raw).hexdigest(),
                           **completion_signature(json.loads(raw))})
        completion.append({"project": project["project"], "compiler_status": project["status"],
            "unique_completion_orders": len({r["completion_order_sha256"] for r in traces}),
            "unique_ordered_wave_partitions": len({r["ordered_wave_sets_sha256"] for r in traces}),
            "unique_objective_wave_multisets": len({r["objective_wave_multiset_sha256"] for r in traces}),
            "runs": traces})
    return {"schema": "hact-v12-descriptive-robustness-1", "status": "PASS",
        "analysis_type": "retrospective descriptive projection of immutable v11 evidence; no new experiments",
        "inference_boundary": "paired timing blocks are correlated repeats on one host, not independent projects; no confidence interval or population test",
        "timing_boundary": "instrumented prototype operation sums include canonical serialization for logical-byte accounting",
        "arithmetic": "ratios use exact rational arithmetic on persisted decimal times; display values are rounded floating-point projections",
        "input_sha256": {name: hashlib.sha256(raw).hexdigest() for name, raw in contents.items()},
        "service": result, "completion_patterns": completion,
        "all_admitted_projects_have_one_objective_pattern": all(
            row["unique_objective_wave_multisets"] == 1 for row in completion if row["compiler_status"] == "PASS")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "results/v12/robustness.json")
    args = parser.parse_args()
    result = build_report()
    if args.check:
        require(json.loads(args.output.read_text()) == result, "stored robustness projection differs")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n")
    print(json.dumps({"status": "PASS", "matched_blocks": result["service"]["matched_timing_blocks"],
                      "all_hact_slower": result["service"]["all_paired_hact_slower"],
                      "all_admitted_same_objective_pattern": result["all_admitted_projects_have_one_objective_pattern"]}))


if __name__ == "__main__":
    main()
