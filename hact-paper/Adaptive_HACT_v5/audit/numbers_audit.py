#!/usr/bin/env python3
"""P0-6 numbers audit: regenerate every manuscript number from frozen
artifacts (V8_MAJOR_REVISION_PLAN.md section 11 item 4).

Second code path, mirroring audit/check_v3-v5: NO imports of hact/, ichact/,
or any producer module. Every manuscript number is recomputed from the frozen
JSON artifacts with independent code and compared to the printed value; any
mismatch fails the audit.

Audited claims (manuscript v7.0 as of commit a829bf7):
  1. paper/generated_v5/practical.tex  <- results/v5/practical.json
     (9 rows; selected-family held-out reduction mean %, three-seed range,
      median fit seconds, changed count -- all recomputed independently)
  2. paper/generated_v5/replay.tex     <- results/v5/source_replay.json
     (3 rows: padded/compact/batch-zlib savings vs fixed8; vs-exact penalty =
      (balanced - exact) / exact on batch_zlib, per project)
     plus prose totals 416,046 / 299,081 / 278,831 (evaluation_v5.tex)
  3. paper/generated/ordering_rows.tex <- results/v3/ordering_summary.json
     (4 rows: seed-mean reduction vs original / fixed8 with percentile
      bootstrap CIs, 10,000 resamples, seed 94001, seed-level units)
  4. paper/v7_comparison.tex tab:v7strong <- results/v7/strong_baselines.json
     (HACT / frequency / random-median / random-oracle columns, three-seed
      means; HACT column additionally cross-checked against practical.tex)
  5. results/v8/service_equivalence.json summary <- its own frozen
     comparison rows (168 comparisons, layout invariance over 84 checks)
  6. results/v8/real_query_cost_study.json decision_table <- its own frozen
     per-query rows (bytes = storage + complete-answer + index build +
     maintenance; time = arrival total_seconds; per family)
  7. results/v8/higher_order_ablation.json verdict <- frozen rule of
     V8_MAJOR_REVISION_PLAN.md section 5 applied to its rows: rung3 beats
     rung2 on clustered held-out cost per workload, recomputed from totals.

The formerly UNREGENERABLE gap is closed: the v7 strong-baseline artifact is
now committed at results/v7/strong_baselines.json (deterministic analysis of
frozen v5 observations; random layouts seeded via sha256 of n/kind/seed/2037),
so all tab:v7strong columns are audited.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "audit" / "numbers_audit.json"

SCHEMA = "v8-numbers-audit-2"


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def parse_tex_rows(text: str):
    """Rows of a LaTeX tabular body: split cells on &."""
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("%") or line.startswith("\\"):
            continue
        if "&" not in line:
            continue
        cells = [c.strip().replace("\\%", "%") for c in line.split("&")]
        # strip trailing row terminator and any \bottomrule glued to it
        cells[-1] = re.split(r"\\\\+\\?", cells[-1])[0].strip()
        rows.append(cells)
    return rows


def close(a: float, b: float, tol: float = 0.005) -> bool:
    return abs(a - b) <= tol


# ---------------------------------------------------------------------------
# 1. practical.tex <- results/v5/practical.json
# ---------------------------------------------------------------------------

def audit_practical_tex() -> list[dict]:
    data = _load(ROOT / "results" / "v5" / "practical.json")
    tex_rows = parse_tex_rows(
        (ROOT / "paper" / "generated_v5" / "practical.tex").read_text())
    entries = []
    if len(tex_rows) != 9:
        raise AssertionError("practical.tex must have 9 rows, got %d"
                             % len(tex_rows))
    fmt_n = {"128": 128, "512": 512, "1,024": 1024, "1024": 1024}
    for cells in tex_rows:
        if len(cells) != 6:
            raise AssertionError(
                "practical.tex row must have 6 cells "
                "(n & family & mean & lo--hi & fit & changed), got %d: %r"
                % (len(cells), cells))
        n = fmt_n[cells[0]]
        kind = cells[1].lower()
        group = [r for r in data if (r["n"], r["kind"]) == (n, kind)]
        if len(group) != 3:
            raise AssertionError("expected 3 seeds for %s/%s, got %d"
                                 % (n, kind, len(group)))
        # selected-family semantics: the validation stage may retain the
        # incumbent; the reported reduction uses whichever family was selected
        pcts = sorted(100.0 * (1.0 - r["heldout_totals"][r["selected"]]
                               / r["heldout_totals"]["incumbent"])
                      for r in group)
        mean_pct = sum(pcts) / 3.0
        fits = sorted(r["fit_seconds"] for r in group)
        fit_med = fits[1]
        changed = sum(1 for r in group if r["selected"] != "incumbent")
        lo, hi = pcts[0], pcts[-1]
        printed_lo, printed_hi = (float(x) for x in cells[3].split("--"))
        ok = (close(float(cells[2]), mean_pct)
              and close(printed_lo, lo) and close(printed_hi, hi)
              and close(float(cells[4]), fit_med, tol=0.0005)
              and cells[5] == "%d/3" % changed)
        entries.append({
            "claim": "paper/generated_v5/practical.tex row %s/%s"
                     % (cells[0], cells[1]),
            "source": "results/v5/practical.json",
            "recomputed": {"mean_pct": round(mean_pct, 2),
                           "range": [round(lo, 2), round(hi, 2)],
                           "fit_median_s": round(fit_med, 4),
                           "changed_of_3": changed},
            "printed": {"mean_pct": cells[2],
                        "range": cells[3],
                        "fit_median_s": cells[4],
                        "changed": cells[5]},
            "status": "OK" if ok else "MISMATCH",
        })
    # prose: evaluation_v5.tex line quoting cluster means and ranges
    prose = (ROOT / "paper" / "evaluation_v5.tex").read_text()
    for n, mean_s, lo_s, hi_s in ((128, "23.43", "22.40", "24.45"),
                                  (512, "10.75", "10.06", "11.13"),
                                  (1024, "5.56", "5.16", "5.80")):
        group = [r for r in data if (r["n"], r["kind"]) == (n, "cluster")]
        pcts = sorted(100.0 * (1.0 - r["heldout_totals"][r["selected"]]
                               / r["heldout_totals"]["incumbent"])
                      for r in group)
        ok = (("%s\\%%" % mean_s) in prose and ("%s--%s\\%%" % (lo_s, hi_s))
              in prose
              and close(float(mean_s), sum(pcts) / 3.0)
              and close(float(lo_s), pcts[0]) and close(float(hi_s), pcts[-1]))
        entries.append({
            "claim": "paper/evaluation_v5.tex cluster-%d prose mean/range" % n,
            "source": "results/v5/practical.json",
            "recomputed": {"mean_pct": round(sum(pcts) / 3.0, 2),
                           "range": [round(pcts[0], 2), round(pcts[-1], 2)]},
            "printed": {"mean_pct": mean_s, "range": "%s--%s" % (lo_s, hi_s)},
            "status": "OK" if ok else "MISMATCH",
        })
    return entries


# ---------------------------------------------------------------------------
# 2. replay.tex <- results/v5/source_replay.json
# ---------------------------------------------------------------------------

def audit_replay_tex() -> list[dict]:
    data = _load(ROOT / "results" / "v5" / "source_replay.json")
    tex_rows = parse_tex_rows(
        (ROOT / "paper" / "generated_v5" / "replay.tex").read_text())
    entries = []
    if len(tex_rows) != 3:
        raise AssertionError("replay.tex must have 3 rows, got %d"
                             % len(tex_rows))
    for cells in tex_rows:
        if len(cells) != 5:
            raise AssertionError(
                "replay.tex row must have 5 cells, got %d: %r"
                % (len(cells), cells))
        project = cells[0].lower()

        def tot(method, wire):
            return sum(r["wire_bytes"][wire] for r in data
                       if r["project"] == project and r["method"] == method)

        padded = 100.0 * (1 - tot("learned_balanced", "padded")
                          / tot("fixed8", "padded"))
        canonical = 100.0 * (1 - tot("learned_balanced", "compact")
                             / tot("fixed8", "compact"))
        epoch = 100.0 * (1 - tot("learned_balanced", "batch_zlib")
                         / tot("fixed8", "batch_zlib"))
        # printed penalty: balanced's excess over exact after whole-epoch
        # compression, as a fraction of exact
        penalty = 100.0 * (tot("learned_balanced", "batch_zlib")
                           - tot("learned_exact", "batch_zlib")) \
            / tot("learned_exact", "batch_zlib")
        ok = (close(float(cells[1]), padded)
              and close(float(cells[2]), canonical)
              and close(float(cells[3]), epoch)
              and close(float(cells[4]), penalty, tol=0.005))
        entries.append({
            "claim": "paper/generated_v5/replay.tex row %s" % project,
            "source": "results/v5/source_replay.json",
            "recomputed": {"padded_pct": round(padded, 2),
                           "canonical_pct": round(canonical, 2),
                           "epoch_pct": round(epoch, 2),
                           "vs_exact_penalty_pct": round(penalty, 2)},
            "printed": cells[1:5],
            "status": "OK" if ok else "MISMATCH",
        })
    # prose totals in evaluation_v5.tex: 416,046 / 299,081 / 278,831
    prose = (ROOT / "paper" / "evaluation_v5.tex").read_text()
    f = sum(r["wire_bytes"]["batch_zlib"] for r in data
            if r["method"] == "fixed8")
    lb = sum(r["wire_bytes"]["batch_zlib"] for r in data
             if r["method"] == "learned_balanced")
    le = sum(r["wire_bytes"]["batch_zlib"] for r in data
             if r["method"] == "learned_exact")
    ok = ("416,046" in prose and "299,081" in prose and "278,831" in prose
          and f == 416046 and lb == 299081 and le == 278831)
    entries.append({
        "claim": "paper/evaluation_v5.tex aggregate batch-zlib totals",
        "source": "results/v5/source_replay.json",
        "recomputed": {"fixed8": f, "learned_balanced": lb,
                       "learned_exact": le},
        "printed": "416,046 / 299,081 / 278,831",
        "status": "OK" if ok else "MISMATCH",
    })
    return entries


# ---------------------------------------------------------------------------
# 3. ordering_rows.tex <- results/v3/ordering_summary.json
# ---------------------------------------------------------------------------

def audit_v3_rows() -> list[dict]:
    entries = []
    gen = ROOT / "paper" / "generated"
    ordering = _load(ROOT / "results" / "v3" / "ordering_summary.json")
    tex_rows = parse_tex_rows((gen / "ordering_rows.tex").read_text())
    kinds = ("cluster", "independent", "singleton", "global")
    if len(tex_rows) != 4:
        raise AssertionError("ordering_rows.tex must have 4 rows, got %d"
                             % len(tex_rows))
    for cells, kind in zip(tex_rows, kinds):
        if len(cells) != 3:
            raise AssertionError(
                "ordering_rows.tex row must have 3 cells, got %d: %r"
                % (len(cells), cells))
        group = [r for r in ordering if r["kind"] == kind]
        if len(group) != 20:
            raise AssertionError("expected 20 seeds for kind %s, got %d"
                                 % (kind, len(group)))
        for idx, base in enumerate(("original", "fixed8"), start=1):
            vals = np.array([100.0 * (1 - r["total_bytes"]["selected"]
                                      / r["total_bytes"][base])
                             for r in group], dtype=float)
            # frozen bootstrap: 10,000 resamples of seed-level means,
            # percentile interval, seed 94001 (evaluation.tex contract)
            rng = np.random.default_rng(94001)
            samples = vals[rng.integers(len(vals),
                                        size=(10000, len(vals)))].mean(axis=1)
            mean = float(vals.mean())
            low = float(np.quantile(samples, 0.025))
            high = float(np.quantile(samples, 0.975))
            printed = cells[idx]
            m = re.fullmatch(r"(-?\d+\.\d+) \[(-?\d+\.\d+), (-?\d+\.\d+)\]",
                             printed)
            if m is None:
                raise AssertionError("cannot parse ordering cell %r"
                                     % printed)
            ok = (close(float(m.group(1)), mean)
                  and close(float(m.group(2)), low)
                  and close(float(m.group(3)), high))
            entries.append({
                "claim": "paper/generated/ordering_rows.tex row %s vs %s"
                         % (kind, base),
                "source": "results/v3/ordering_summary.json",
                "recomputed": {"mean": round(mean, 2),
                               "ci": [round(low, 2), round(high, 2)]},
                "printed": printed,
                "status": "OK" if ok else "MISMATCH",
            })
    return entries


# ---------------------------------------------------------------------------
# 4. v7_comparison.tex tab:v7strong <- results/v7/strong_baselines.json
#    (HACT column cross-checked against practical.tex)
# ---------------------------------------------------------------------------

def audit_v7_strong() -> list[dict]:
    entries = []
    tex = (ROOT / "paper" / "v7_comparison.tex").read_text()
    practical_rows = parse_tex_rows(
        (ROOT / "paper" / "generated_v5" / "practical.tex").read_text())
    strong_rows = parse_tex_rows(tex)
    artifact = _load(ROOT / "results" / "v7" / "strong_baselines.json")
    syn = artifact["synthetic"]
    hact_by_key = {}
    for cells in practical_rows:
        fmt_n = {"128": "128", "512": "512", "1,024": "1024", "1024": "1024"}
        hact_by_key[(fmt_n[cells[0]], cells[1].lower())] = float(cells[2])
    # v7_comparison prints "clustered" where practical.tex prints "cluster"
    fam_alias = {"clustered": "cluster"}
    matched = 0
    for cells in strong_rows:
        if len(cells) >= 6 and cells[0] in ("128", "512", "1024", "1,024"):
            n = int(cells[0].replace(",", ""))
            fam = fam_alias.get(cells[1].lower(), cells[1].lower())
            key = (str(n), fam)
            if key not in hact_by_key:
                continue
            matched += 1
            group = [r for r in syn if (r["n"], r["family"]) == (n, fam)]
            if len(group) != 3:
                raise AssertionError(
                    "strong_baselines.json: expected 3 seeds for "
                    "%s/%s, got %d" % (n, fam, len(group)))
            cols = {
                "hact_pct": (float(cells[2]),
                             sum(r["reduction_percent"]["selected"]
                                 for r in group) / 3.0),
                "frequency_pct": (float(cells[3]),
                                  sum(r["reduction_percent"]["frequency"]
                                      for r in group) / 3.0),
                "random_median_pct": (float(cells[4]),
                                      sum(r["reduction_percent"]
                                          ["random_median"]
                                          for r in group) / 3.0),
                "random_oracle_pct": (float(cells[5]),
                                      sum(r["reduction_percent"]
                                          ["random_best_oracle"]
                                          for r in group) / 3.0),
            }
            ok = all(close(p, c) for p, c in cols.values()) \
                and close(float(cells[2]), hact_by_key[key])
            entries.append({
                "claim": "paper/v7_comparison.tex tab:v7strong %s/%s"
                         % (cells[0], cells[1]),
                "source": "results/v7/strong_baselines.json",
                "recomputed": {k: round(v[1], 2) for k, v in cols.items()},
                "printed": {"hact_pct": cells[2],
                            "frequency_pct": cells[3],
                            "random_median_pct": cells[4],
                            "random_oracle_pct": cells[5]},
                "status": "OK" if ok else "MISMATCH",
            })
    if matched != 9:
        entries.append({
            "claim": "paper/v7_comparison.tex tab:v7strong row coverage",
            "source": "paper/generated_v5/practical.tex",
            "recomputed": 9,
            "printed": matched,
            "status": "MISMATCH",
        })
    return entries


# ---------------------------------------------------------------------------
# 5. results/v8/service_equivalence.json summary <- its comparison rows
# ---------------------------------------------------------------------------

def audit_service_equivalence() -> list[dict]:
    eq = _load(ROOT / "results" / "v8" / "service_equivalence.json")
    rows = eq["comparisons"]
    li = eq["layout_invariance"]
    n_cmp = len(rows)
    n_eq = sum(1 for r in rows if r["equal"])
    li_all = (len(li) > 0 and all(x["invariant"] for x in li))
    s = eq["summary"]
    consistent = (s["comparisons"] == n_cmp and s["equal"] == n_eq
                  and bool(s["layout_invariance_all"]) == li_all
                  and n_eq == n_cmp and li_all)
    return [{
        "claim": "results/v8/service_equivalence.json summary vs rows",
        "source": "results/v8/service_equivalence.json (frozen corpus)",
        "recomputed": {"equal": n_eq, "comparisons": n_cmp,
                       "layout_invariance_checks": len(li),
                       "layout_invariance_all": li_all},
        "printed": s,
        "status": "OK" if consistent else "MISMATCH",
    }]


# ---------------------------------------------------------------------------
# 6. results/v8/real_query_cost_study.json decision_table <- its rows
# ---------------------------------------------------------------------------

def audit_real_query_cost() -> list[dict]:
    cost = _load(ROOT / "results" / "v8" / "real_query_cost_study.json")
    rows = cost["rows"]
    table = cost["decision_table"]
    entries = []
    by_fam = {}
    for r in rows:
        by_fam.setdefault(r["query_id"], []).append(r)
    for row in table:
        fam = row["query_family"]
        rs = by_fam.get(fam, [])
        if len(rs) != row["n_queries"]:
            entries.append({
                "claim": "results/v8/real_query_cost_study.json "
                         "decision_table %s n_queries" % fam,
                "source": "results/v8/real_query_cost_study.json rows",
                "recomputed": len(rs),
                "printed": row["n_queries"],
                "status": "MISMATCH",
            })
            continue
        hact_bytes = sum(r["hact"]["storage_bytes"]
                         + r["hact"]["complete_answer_bytes"]
                         + r["hact"]["index_build_bytes"]
                         + r["hact"]["index_maintenance_bytes"]
                         for r in rs)
        flat_bytes = sum(r["flat"]["storage_bytes"]
                         + r["flat"]["complete_answer_bytes"]
                         + r["flat"]["index_build_bytes"]
                         + r["flat"]["index_maintenance_bytes"]
                         for r in rs)
        hact_t = sum(r["hact_arrival"]["total_seconds"] for r in rs)
        flat_t = sum(r["flat_arrival"]["total_seconds"] for r in rs)
        bytes_better = hact_bytes < flat_bytes
        time_better = hact_t < flat_t
        equal_all = all(r["equal_semantics"] for r in rs)
        beneficial = bytes_better and time_better and equal_all
        ok = (hact_bytes == row["hact_bytes_with_maintenance"]
              and flat_bytes == row["flat_bytes_with_maintenance"]
              and abs(hact_t - row["hact_arrival_seconds_total"]) < 1e-9
              and abs(flat_t - row["flat_arrival_seconds_total"]) < 1e-9
              and bytes_better == row["bytes_better"]
              and time_better == row["time_better"]
              and equal_all == row["equal_semantics_all"]
              and beneficial == row["hact_beneficial"])
        entries.append({
            "claim": "results/v8/real_query_cost_study.json "
                     "decision_table family %s" % fam,
            "source": "results/v8/real_query_cost_study.json rows",
            "recomputed": {"n_queries": len(rs),
                           "hact_bytes": hact_bytes,
                           "flat_bytes": flat_bytes,
                           "bytes_better": bytes_better,
                           "time_better": time_better,
                           "hact_beneficial": beneficial},
            "printed": {"n_queries": row["n_queries"],
                        "hact_bytes": row["hact_bytes_with_maintenance"],
                        "flat_bytes": row["flat_bytes_with_maintenance"],
                        "bytes_better": row["bytes_better"],
                        "time_better": row["time_better"],
                        "hact_beneficial": row["hact_beneficial"]},
            "status": "OK" if ok else "MISMATCH",
        })
    # frozen decision rule wording must be present verbatim
    rule = ("HACT beneficial per family iff complete-answer bytes AND arrival "
            "time improve vs indexed flat ledger, maintenance included, at "
            "equal semantics")
    entries.append({
        "claim": "results/v8/real_query_cost_study.json decision rule "
                 "wording (frozen)",
        "source": "docs/V8_SERVICE_CONTRACT.md section 9 (frozen rule)",
        "recomputed": rule,
        "printed": cost["decision_rule"],
        "status": "OK" if cost["decision_rule"] == rule else "MISMATCH",
    })
    return entries


# ---------------------------------------------------------------------------
# 7. results/v8/higher_order_ablation.json verdict <- frozen rule
# ---------------------------------------------------------------------------

def audit_higher_order() -> list[dict]:
    hoa = _load(ROOT / "results" / "v8" / "higher_order_ablation.json")
    rows = hoa["rows"]
    entries = []
    # per-row flags must follow from the frozen held-out totals
    for r in rows:
        t = r["heldout_totals"]
        beats = t["rung3_wave_improvement"] < t["rung2_cluster"]
        delta = t["rung3_wave_improvement"] - t["rung2_cluster"]
        pct = delta / t["rung2_cluster"]
        d = r["decision"]
        ok = (beats == d["rung3_beats_rung2"]
              and abs(delta - d["rung3_vs_rung2_delta"]) < 1e-6
              and abs(pct - d["rung3_vs_rung2_pct"]) < 1e-12)
        entries.append({
            "claim": "results/v8/higher_order_ablation.json row %s/%s/%s "
                     "decision flags" % (r["workload"]["n"],
                                         r["workload"]["kind"],
                                         r["workload"]["seed"]),
            "source": "results/v8/higher_order_ablation.json heldout_totals",
            "recomputed": {"rung3_beats_rung2": beats,
                           "delta": delta, "pct": pct},
            "printed": d,
            "status": "OK" if ok else "MISMATCH",
        })
    # summary aggregates from rows
    s = hoa["summary"]
    m12 = sum((r["heldout_totals"]["rung1_frequency"]
               - r["heldout_totals"]["rung2_cluster"])
              / r["heldout_totals"]["rung2_cluster"] for r in rows) / len(rows)
    m42 = sum((r["heldout_totals"]["rung4_exact_tree_dp"]
               - r["heldout_totals"]["rung2_cluster"])
              / r["heldout_totals"]["rung2_cluster"] for r in rows) / len(rows)
    ok = (s["n_workloads"] == len(rows)
          and abs(m12 - s["mean_rung1_minus_rung2_pct"]) < 1e-12
          and abs(m42 - s["mean_rung4_minus_rung2_pct"]) < 1e-12)
    entries.append({
        "claim": "results/v8/higher_order_ablation.json summary aggregates",
        "source": "results/v8/higher_order_ablation.json rows",
        "recomputed": {"n_workloads": len(rows),
                       "mean_rung1_minus_rung2": m12,
                       "mean_rung4_minus_rung2": m42},
        "printed": {"n_workloads": s["n_workloads"],
                    "mean_rung1_minus_rung2_pct":
                        s["mean_rung1_minus_rung2_pct"],
                    "mean_rung4_minus_rung2_pct":
                        s["mean_rung4_minus_rung2_pct"]},
        "status": "OK" if ok else "MISMATCH",
    })
    # frozen verdict rule (V8_MAJOR_REVISION_PLAN.md section 5)
    cluster_rows = [r for r in rows if r["workload"]["kind"] == "cluster"]
    supported = sum(1 for r in cluster_rows if r["decision"]["rung3_beats_rung2"])
    verdict = hoa["summary"]["verdict"]
    consistent = ((supported == len(cluster_rows)
                   and "ablation-supported" in verdict)
                  or (supported != len(cluster_rows) and "narrow" in verdict))
    entries.append({
        "claim": "results/v8/higher_order_ablation.json verdict consistency",
        "source": "V8_MAJOR_REVISION_PLAN.md section 5 (frozen rule)",
        "recomputed": {"cluster_workloads": len(cluster_rows),
                       "rung3_beats_rung2": supported},
        "printed": verdict[:80],
        "status": "OK" if consistent else "MISMATCH",
    })
    return entries


# ---------------------------------------------------------------------------

def main() -> int:
    entries = []
    entries += audit_practical_tex()
    entries += audit_replay_tex()
    entries += audit_v3_rows()
    entries += audit_v7_strong()
    entries += audit_service_equivalence()
    entries += audit_real_query_cost()
    entries += audit_higher_order()

    n_ok = sum(1 for e in entries if e["status"] == "OK")
    n_mismatch = sum(1 for e in entries if e["status"] == "MISMATCH")
    n_missing = sum(1 for e in entries if e["status"] == "UNREGENERABLE")
    result = {
        "schema": SCHEMA,
        "status": "PASS" if n_mismatch == 0 else "FAIL",
        "counts": {"audited": len(entries), "ok": n_ok,
                   "mismatch": n_mismatch, "ungenerable": n_missing},
        "scope": "second-code-path regeneration of manuscript numbers from "
                 "frozen repo artifacts; not external certification",
        "entries": entries,
    }
    OUT.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": result["status"], "counts": result["counts"]},
                     indent=2))
    for e in entries:
        if e["status"] != "OK":
            print("[%s] %s" % (e["status"], e["claim"]))
            print("   source: %s" % e["source"])
    return 0 if n_mismatch == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
