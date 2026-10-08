#!/usr/bin/env python3
"""Independent generic R&D benchmark checker. 0=green, 1=expected red, 3=invalid."""
from __future__ import annotations

import importlib.util
import sys
import traceback
from pathlib import Path


def load(name: str):
    path = Path.cwd() / (name + ".py")
    spec = importlib.util.spec_from_file_location("benchmark_" + name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Missing target module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def metrics_fidelity():
    m = load("metrics")
    assert m.verified_rate([]) == 0.0
    assert m.verified_rate([{"verified": True}, {"verified": False}]) == 0.5
    assert m.verified_rate([{"verified": True}, {"verified": "false"},
                            {"verified": 1}, {"verified": False}]) == 0.25, "non-boolean success inflated rate"


def manifest_integrity():
    m = load("manifests")
    rows = [{"id": "run-a", "domain": "numerics"}, {"id": "run-b", "domain": "systems"}]
    valid = {"count": 2, "ids": ["run-a", "run-b"], "domains": {"numerics": 1, "systems": 1}}
    assert m.verify_manifest(rows, valid)["ok"] is True, "valid manifest incorrectly rejected"
    for wrong in [{**valid, "count": 99}, {**valid, "ids": ["run-a"]},
                  {**valid, "domains": {"numerics": 2}}]:
        assert m.verify_manifest(rows, wrong)["ok"] is False, "mismatched provenance accepted"
    assert m.verify_manifest([rows[0], rows[0]], valid)["ok"] is False, "duplicate IDs accepted"


def candidate_completeness():
    m = load("candidates")
    tasks = ["case-1", "case-2"]
    refs = {"case-1": "gold-1", "case-2": "gold-2"}
    proposals = {"case-1": "agent-1", "case-2": "agent-2"}
    assert m.select_candidates(tasks, proposals, refs) == proposals, "full candidate map changed"
    assert m.select_candidates(tasks, None, refs) == refs, "explicit reference-only mode changed"
    for partial in ({}, {"case-1": "agent-1"}):
        try:
            result = m.select_candidates(tasks, partial, refs)
        except (KeyError, ValueError):
            continue
        assert False, f"incomplete candidate map incorrectly accepted: {result!r}"


def job_idempotence():
    m = load("jobs")
    calls = []
    def submit(request):
        calls.append(request.copy())
        return f"remote-{len(calls)}"
    ledger = {}
    request = {"experiment": "trial-a", "config_hash": "frozen-v1"}
    first = m.ensure_job("project/trial-a", request, ledger, submit)
    again = m.ensure_job("project/trial-a", request.copy(), ledger, submit)
    assert first == again and len(calls) == 1, "resume submitted duplicate remote experiment"
    assert ledger["project/trial-a"]["job_id"] == first
    try:
        m.ensure_job("project/trial-a", {**request, "config_hash": "changed"}, ledger, submit)
    except ValueError:
        pass
    else:
        assert False, "identity collision with different input accepted"
    assert len(calls) == 1, "changed input was resubmitted"
    second = m.ensure_job("project/trial-b", request, ledger, submit)
    assert second != first and len(calls) == 2, "independent job blocked"


CASES = {
    "metrics-fidelity": metrics_fidelity,
    "manifest-integrity": manifest_integrity,
    "candidate-completeness": candidate_completeness,
    "job-idempotence": job_idempotence,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in CASES:
        print("usage: research_check.py " + "|".join(CASES), file=sys.stderr)
        return 3
    case = sys.argv[1]
    try:
        CASES[case]()
    except AssertionError as error:
        print(f"RED_CONTROL_{case}: {error}", file=sys.stderr)
        return 1
    except Exception:
        traceback.print_exc()
        return 3
    print(f"PASS_{case}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
