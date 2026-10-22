"""Meaningful corruption and aggregation checks for the descriptive projection."""
from copy import deepcopy
import pytest

from experiments_v12.robustness import analyze_service, completion_signature


def fixture():
    identity = {"case": "fixture_run_3", "project": "fixture", "evidence": "e.json",
                "report": "r.json", "layout": "l.json"}
    case = {**identity, "n": 16, "status": "PASS", "repetitions": []}
    # Deliberately separate median of paired ratios (2) from ratio of medians (4).
    for i, (hact, counter) in enumerate(((2, 1), (4, 2), (8, 1))):
        arms = ["counter", "hact_selected", "indexed", "hact_original"]
        block = {"repetition": i, "arm_order": arms, "executions": []}
        for arm in arms:
            rows = [{"epoch": e, "query": q, "phase": phase, "seconds": 0,
                     "semantic_sha256": "a" * 64, "raw_bytes": 20,
                     "wire_bytes": 15, "pages": 1}
                    for e in (0, 1, 2) for q in ("Q1", "Q2", "Q3", "Q4", "Q5", "Q6a", "Q6b")
                    for phase in ("cold", "warm")]
            block["executions"].append({"arm": arm, "status": "PASS", "queries": rows,
                "service_operation_seconds": hact if arm == "hact_selected" else counter,
                "query_seconds": 0, "input_preparation_and_oracle_seconds_excluded": True})
        case["repetitions"].append(block)
    return {"repeats": 3, "status": "PASS", "cases": [case]}, [identity]


def test_paired_median_and_ratio_of_medians_are_distinct_estimands():
    study, manifest = fixture()
    result = analyze_service(study, manifest)
    row = result["cases"][0]
    assert row["median_paired_ratio"]["exact_decimal_ratio"] == "2"
    assert row["ratio_of_arm_medians"]["exact_decimal_ratio"] == "4"
    assert [x["value"] for x in row["paired_ratios"]] == [2, 2, 8]
    assert result["all_paired_hact_slower"] is True


def test_unfavorable_repeat_is_preserved_not_averaged_away():
    study, manifest = fixture()
    study["cases"][0]["repetitions"][0]["executions"][1]["service_operation_seconds"] = .5
    result = analyze_service(study, manifest)
    assert result["all_paired_hact_slower"] is False
    assert result["paired_ratio_min"]["value"] == .5
    assert result["matched_timing_blocks"] == 3


@pytest.mark.parametrize("corruption", ["missing_arm", "duplicate_repeat", "cohort",
                                      "query_slot", "digest", "codec", "time_sum",
                                      "negative", "nan", "boundary", "arm_status"])
def test_corrupted_timing_contract_is_rejected(corruption):
    study, manifest = fixture()
    case = study["cases"][0]
    row = case["repetitions"][0]["executions"][0]
    if corruption == "missing_arm":
        case["repetitions"][0]["executions"].pop()
    elif corruption == "duplicate_repeat":
        case["repetitions"][1]["repetition"] = 0
    elif corruption == "cohort":
        study["cases"].append(deepcopy(case))
    elif corruption == "query_slot":
        row["queries"].pop()
    elif corruption == "digest":
        row["queries"][0]["semantic_sha256"] = "b" * 64
    elif corruption == "codec":
        row["queries"][0]["wire_bytes"] += 1
    elif corruption == "time_sum":
        row["query_seconds"] = 100
    elif corruption == "negative":
        row["service_operation_seconds"] = -1
    elif corruption == "nan":
        row["service_operation_seconds"] = float("nan")
    elif corruption == "boundary":
        row["input_preparation_and_oracle_seconds_excluded"] = False
    else:
        row["status"] = "UNKNOWN"
    with pytest.raises(ValueError):
        analyze_service(study, manifest)


def test_resource_unknown_stays_in_denominator_and_cannot_be_silently_hidden():
    study, manifest = fixture()
    missing = {"case": "large_run_3", "project": "large", "evidence": "e2.json",
               "report": "r2.json", "layout": "l2.json"}
    manifest.append(missing)
    study["cases"].append({**missing, "n": 10000, "status": "UNKNOWN",
                           "reason": "resource admission", "repetitions": []})
    study["status"] = "UNKNOWN"
    result = analyze_service(study, manifest)
    assert result["admitted_cases"] == 1 and len(result["excluded"]) == 1
    study["status"] = "PASS"
    with pytest.raises(ValueError, match="hides unknowns"):
        analyze_service(study, manifest)


def test_objective_pattern_ignores_only_within_wave_and_wave_order():
    def evidence(executed):
        return {"registry": list("abcd"), "executed": list(executed),
                "records": {k: {} for k in "abcd"}}
    a = completion_signature(evidence("abcd"), 2)
    b = completion_signature(evidence("badc"), 2)
    c = completion_signature(evidence("cdab"), 2)
    d = completion_signature(evidence("acbd"), 2)
    assert a["completion_order_sha256"] != b["completion_order_sha256"]
    assert a["ordered_wave_sets_sha256"] == b["ordered_wave_sets_sha256"]
    assert a["ordered_wave_sets_sha256"] != c["ordered_wave_sets_sha256"]
    assert a["objective_wave_multiset_sha256"] == c["objective_wave_multiset_sha256"]
    assert a["objective_wave_multiset_sha256"] != d["objective_wave_multiset_sha256"]


def test_completion_pattern_requires_every_declared_check_exactly_once():
    with pytest.raises(ValueError, match="complete unique"):
        completion_signature({"registry": list("abc"), "executed": list("aab"),
                              "records": {k: {} for k in "ab"}})
