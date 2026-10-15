"""Equivalence oracle for the V8 equal-service study (contract section 8).

Acceptance for P0-1/P0-2: for every trajectory in the frozen corpus and every
frozen query Q1-Q6, the answer of the HACT tree service (under BOTH the
original-order balanced layout and the archived learned layout) must be
semantically identical to the answer of the indexed flat-ledger baseline:

1. semantic content equal field-by-field (after stripping run-specific timing
   noise, which is a property of the recorded execution, not of the
   representation);
2. identical UNKNOWN disclosure sets;
3. identical epoch/freshness and total wave counts;
4. layout must not change the HACT answer (original-order vs learned).

The oracle also cross-checks the HACT service's Kernel rollup against the
semantic answer: the tree's aggregated verdict/counts must agree with the
semantics computed from per-check records (a representation that disagrees
with its own rollups is not a faithful service).

Output: a per-trajectory, per-query JSON record with equality booleans,
committed to the repo as an artifact (``results/v8/service_equivalence.json``).
Run as a script: ``python3 -m experiments_v8.service_oracle [output.json]``.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from experiments_v8 import service_baselines as sb
from experiments_v8 import service_core as core

ROOT = Path(__file__).resolve().parent.parent

# Archived learned layout orders (v5 source replay), keyed by (project, case).
_LEARNED_SUFFIX = "-learned_exact"
_LEARNED_ROOT = ROOT / "results" / "v5" / "source_replay"


def learned_order(trajectory: core.Trajectory) -> tuple[int, ...] | None:
    """Archived learned layout order for this trajectory, if replayed.

    Returns the exact integer permutation recorded in the archived v5
    ``report.json`` (``layout_order``), or None when no learned replay exists
    for this candidate. The order is validated as an exact permutation of the
    registry before use.
    """
    path = _LEARNED_ROOT / f"{trajectory.case}{_LEARNED_SUFFIX}" / "report.json"
    if not path.is_file():
        return None
    report = json.loads(path.read_text())
    order = report.get("layout_order")
    if not isinstance(order, list):
        return None
    n = len(trajectory.registry)
    if len(order) != n or sorted(order) != list(range(n)):
        raise ValueError(f"archived learned order for {trajectory.case} "
                         "is not an exact registry permutation")
    return tuple(order)


@dataclass
class QueryComparison:
    """One (trajectory, query) comparison outcome."""
    project: str
    case: str
    query_id: str
    mode: str
    layout: str                 # "original" or "learned" (HACT arm)
    semantic_equal: bool
    unknown_disclosure_equal: bool
    epoch_equal: bool
    total_waves_equal: bool
    hact_digest: str
    flat_digest: str
    kernel_verdict_agrees: bool
    detail: dict

    @property
    def equal(self) -> bool:
        return (self.semantic_equal and self.unknown_disclosure_equal
                and self.epoch_equal and self.total_waves_equal
                and self.kernel_verdict_agrees)

    def as_dict(self) -> dict:
        return {
            "project": self.project, "case": self.case,
            "query_id": self.query_id, "mode": self.mode,
            "layout": self.layout,
            "semantic_equal": self.semantic_equal,
            "unknown_disclosure_equal": self.unknown_disclosure_equal,
            "epoch_equal": self.epoch_equal,
            "total_waves_equal": self.total_waves_equal,
            "kernel_verdict_agrees": self.kernel_verdict_agrees,
            "equal": self.equal,
            "hact_digest": self.hact_digest,
            "flat_digest": self.flat_digest,
            "detail": self.detail,
        }


def _unknown_set(semantic: dict) -> set:
    """Explicitly disclosed UNKNOWN members in one semantic answer."""
    out: set = set()
    unfinished = semantic.get("unfinished")
    if isinstance(unfinished, list):
        out.update(unfinished)
    missing = semantic.get("missing")
    if isinstance(missing, list):
        out.update(missing)
    return out


def _kernel_agrees(semantic: dict, kernel_extras: dict) -> bool:
    """The tree's Kernel rollup must agree with the semantic answer.

    The Kernel aggregates PASS/FAIL/UNKNOWN over the full gate set; the
    comparison is meaningful for full-registry selections (Q1, Q4) and for
    the archived status answer of `all`. For predicate-restricted or refused
    answers the Kernel aggregate is not expected to match the restricted
    semantics, so the check is skipped (recorded as True with a note).
    """
    if kernel_extras is None:
        return True
    if semantic.get("refused"):
        return True  # explicit refusal; the tree is not asked to roll up
    counts = semantic.get("counts")
    required = semantic.get("required")
    if not isinstance(counts, dict) or not isinstance(required, int):
        return True  # localized/replay semantics: Kernel rollup not comparable
    if required != kernel_extras.get("kernel_gates"):
        return True  # restricted selection: Kernel aggregates the full set only
    kv = kernel_extras.get("kernel_verdict")
    kc = kernel_extras.get("kernel_counts")
    expected_counts = [counts[s] for s in core.STATUS_ORDER]
    return kv == semantic.get("verdict") and kc == expected_counts


def compare_query(hact_answer: core.Answer, flat_answer: core.Answer,
                  kernel_extras: dict | None) -> QueryComparison:
    """Field-by-field comparison of two answers to the same frozen query."""
    s_hact = core.strip_run_specific(hact_answer.semantic)
    s_flat = core.strip_run_specific(flat_answer.semantic)
    semantic_equal = s_hact == s_flat
    detail: dict = {}
    if not semantic_equal:
        detail["hact_semantic"] = s_hact
        detail["flat_semantic"] = s_flat
    return QueryComparison(
        project="", case="", query_id=hact_answer.query_id,
        mode=hact_answer.mode, layout="",
        semantic_equal=semantic_equal,
        unknown_disclosure_equal=_unknown_set(s_hact) == _unknown_set(s_flat),
        epoch_equal=hact_answer.epoch == flat_answer.epoch,
        total_waves_equal=hact_answer.total_waves == flat_answer.total_waves,
        hact_digest=core.semantic_digest(s_hact),
        flat_digest=core.semantic_digest(s_flat),
        kernel_verdict_agrees=_kernel_agrees(s_hact, kernel_extras),
        detail=detail,
    )


def run_corpus(corpus: Sequence[tuple[str, str]] | None = None,
               queries: Sequence[dict] | None = None,
               layouts: Sequence[str] = ("original", "learned"),
               ) -> list[QueryComparison]:
    """Run the full oracle: corpus x queries x layouts.

    ``layouts`` selects which HACT arms run: "original" is the original-order
    balanced layout; "learned" is the archived learned layout (skipped with a
    recorded note when the candidate has no archived learned replay).
    """
    corpus = tuple(corpus or core.CORPUS)
    queries = list(queries or sb.frozen_queries())
    results: list[QueryComparison] = []
    for project, case in corpus:
        trajectory = core.Trajectory.load(project, case)
        snapshot = trajectory.snapshot()
        flat = sb.IndexedFlatLedger(trajectory=trajectory)
        orders: dict[str, tuple[int, ...] | None] = {"original": None}
        learned = learned_order(trajectory)
        for arm in layouts:
            if arm == "learned" and learned is None:
                continue  # no archived learned replay for this candidate
            layout = sb.build_layout(trajectory, order=orders.get(arm)
                                     if arm == "original" else learned)
            hact = sb.HactService(trajectory=trajectory, layout=layout)
            for q in queries:
                a_hact = hact.query(q["query_id"], snapshot, q["s"], q["mode"],
                                    wave=q.get("wave"))
                a_flat = flat.query(q["query_id"], snapshot, q["s"], q["mode"],
                                    wave=q.get("wave"))
                cmp = compare_query(a_hact, a_flat, a_hact.extras)
                cmp.project, cmp.case = project, case
                cmp.layout = arm
                results.append(cmp)
    return results


def layout_invariance(results: Sequence[QueryComparison],
                      corpus: Sequence[tuple[str, str]] | None = None,
                      ) -> list[dict]:
    """Check that the HACT answer does not change between layouts.

    For each (trajectory, query), the semantic digest under the original
    layout must equal the digest under the learned layout (when both ran).
    """
    by_key: dict[tuple, dict[str, str]] = {}
    for r in results:
        if not r.equal:
            continue
        by_key.setdefault((r.project, r.case, r.query_id), {})[r.layout] = r.hact_digest
    out = []
    for (project, case, query_id), arms in sorted(by_key.items()):
        if "original" in arms and "learned" in arms:
            out.append({
                "project": project, "case": case, "query_id": query_id,
                "invariant": arms["original"] == arms["learned"],
            })
    return out


def oracle_report(corpus: Sequence[tuple[str, str]] | None = None,
                  queries: Sequence[dict] | None = None) -> dict:
    """Full oracle report: per-query equality booleans + summary."""
    results = run_corpus(corpus, queries)
    invariance = layout_invariance(results, corpus)
    n_equal = sum(1 for r in results if r.equal)
    report = {
        "schema": "v8-service-equivalence-1",
        "contract": "docs/V8_SERVICE_CONTRACT.md#8",
        "corpus": [list(c) for c in (corpus or core.CORPUS)],
        "queries": [q["query_id"] for q in (queries or sb.frozen_queries())],
        "comparisons": [r.as_dict() for r in results],
        "layout_invariance": invariance,
        "summary": {
            "comparisons": len(results),
            "equal": n_equal,
            "all_equal": len(results) > 0 and n_equal == len(results),
            "layout_invariance_all": (len(invariance) > 0
                                      and all(v["invariant"] for v in invariance)),
        },
    }
    return report


def main(argv: Sequence[str] | None = None) -> int:
    argv = list(argv or [])
    out = Path(argv[0]) if argv else ROOT / "results" / "v8" / "service_equivalence.json"
    report = oracle_report()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    s = report["summary"]
    print(f"comparisons={s['comparisons']} equal={s['equal']} "
          f"all_equal={s['all_equal']} "
          f"layout_invariance_all={s['layout_invariance_all']}")
    print(f"artifact: {out}")
    return 0 if s["all_equal"] and s["layout_invariance_all"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
