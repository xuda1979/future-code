"""Generate current empirical prose/tables from persisted v11 evidence.

No experiment is launched here and no scoring helper is imported. This
projection preserves primary/secondary endpoints and every non-PASS case.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECTS = ("click", "jinja", "packaging", "pluggy", "attrs", "exceptiongroup")
NAMES = dict(click="Click", jinja="Jinja", packaging="Packaging",
             pluggy="Pluggy", attrs="attrs", exceptiongroup="ExceptionGroup")


def read(path):
    return json.loads((ROOT / path).read_text())


def summarize():
    compiler = read("results/v11/public_compiler/SUMMARY.json")
    service = read("results/v11/service_study.json")
    transfer = read("results/v11/regression_costs.json")
    public = []
    for project in PROJECTS:
        ev = read(f"results/v11/public_checks_normalized/{project}/run_3/pytest_evidence.json")
        counts = {status: sum(r["status"] == status for r in ev["records"].values())
                  for status in ("PASS", "FAIL", "UNKNOWN")}
        c = next(row for row in compiler["projects"] if row["project"] == project)
        timings = {}
        cases = [r for r in service["cases"] if r["project"] == project]
        for arm in ("indexed", "counter", "hact_original", "hact_selected"):
            medians = []
            for case in cases:
                if case["status"] != "PASS":
                    continue
                trials = [next(x for x in rep["executions"] if x["arm"] == arm)
                          for rep in case["repetitions"]]
                if any(x["status"] != "PASS" for x in trials):
                    continue
                medians.append(statistics.median(x["service_operation_seconds"] for x in trials))
            if medians:
                timings[arm] = statistics.mean(medians)
        public.append({"project": project, "n": len(ev["registry"]),
                       "counts_per_run": counts, "compiler_status": c["status"],
                       "primary_saving_percent": 100*c["primary_saving_fraction"] if c["status"] == "PASS" else None,
                       "secondary_saving_percent": 100*c["sensitivity_saving_fraction"] if c["status"] == "PASS" else None,
                       "compile_seconds": c.get("compile_seconds"),
                       "mean_case_median_service_seconds": timings,
                       "service_selected_to_counter_ratio": timings["hact_selected"]/timings["counter"] if timings else None})
    successful = [c for c in service["cases"] if c["status"] == "PASS"]
    comparisons = 0
    wire_all = {arm: 0 for arm in ("indexed", "counter", "hact_original", "hact_selected")}
    for case in successful:
        for rep in case["repetitions"]:
            signatures = []
            for arm in rep["executions"]:
                if arm["status"] != "PASS":
                    raise ValueError("case marked PASS contains unknown timing")
                signatures.append([(q["epoch"], q["query"], q["phase"], q["semantic_sha256"],
                                    q["wire_bytes"], q["raw_bytes"], q["pages"])
                                   for q in arm["queries"]])
                comparisons += len(arm["queries"])
                wire_all[arm["arm"]] += sum(q["wire_bytes"] for q in arm["queries"])
            if any(sig != signatures[0] for sig in signatures[1:]):
                raise ValueError("answer/codec conformance mismatch")
    if len(set(wire_all.values())) != 1:
        raise ValueError("common codec totals disagree")
    return {"schema": "hact-v11-report-projection-1", "public_projects": public,
            "full_suite_runs": 30,
            "full_suite_check_executions": 5*sum(row["n"] for row in public),
            "service_admitted_projects": len({c["project"] for c in successful}),
            "service_oracle_answer_checks": comparisons, "service_wire_bytes_per_arm": wire_all,
            "transfer_attempted": transfer["attempted"], "transfer_compared": transfer["compared"],
            "transfer_primary": transfer["primary"],
            "evidence_sha256": {p: hashlib.sha256((ROOT/p).read_bytes()).hexdigest()
                               for p in ("results/v11/public_compiler/SUMMARY.json",
                                         "results/v11/service_study.json",
                                         "results/v11/regression_costs.json")}}


def tex(summary):
    cohort = "\n".join(
        f"{NAMES[r['project']]} & {r['n']:,} & {r['counts_per_run']['PASS']:,} & "
        f"{r['counts_per_run']['FAIL']:,} & {r['counts_per_run']['UNKNOWN']:,} " + r"\\"
        for r in summary["public_projects"])
    gain = "\n".join(
        f"{NAMES[r['project']]} & "
        + (f"{r['primary_saving_percent']:.3f} & {r['secondary_saving_percent']:.3f} "
           if r["compiler_status"] == "PASS" else r"\multicolumn{2}{c}{UNKNOWN} ")
        + r"\\" for r in summary["public_projects"])
    timing = "\n".join(
        f"{NAMES[r['project']]} & {1000*r['mean_case_median_service_seconds']['indexed']:.1f} & "
        f"{1000*r['mean_case_median_service_seconds']['counter']:.1f} & "
        f"{1000*r['mean_case_median_service_seconds']['hact_selected']:.1f} " + r"\\"
        for r in summary["public_projects"] if r["mean_case_median_service_seconds"])
    return r"""\subsection{New public-software executions}
Thirty fresh process runs on six upstream projects record 151,380 check
executions. Table~\ref{tab:v11-cohort} reports one held-out run per project;
the second has the same counts. These counts are execution observations,
not independent projects. attrs' 33 failures concern this environment
(including mypy compatibility) and are retained without calling them
upstream bugs. Skips, xfails and xpasses remain unknown.

\begin{table}[t]\centering\footnotesize
\caption{New complete suites. Counts per held-out run; five runs per project.
P/F/U are PASS/FAIL/UNKNOWN.}\label{tab:v11-cohort}
\begin{tabular}{@{}lrrrr@{}}\toprule
Project & Checks & P & F & U\\\midrule
""" + cohort + r"""
\bottomrule\end{tabular}
\end{table}

Raw collection order varied in Packaging. Before any layout-cost analysis,
a dated correction created separate canonical-registry copies, retaining
the raw records and every scheduled/completed ID unchanged. Jinja's missing
Trio test dependency was repaired before its five retained runs; the original
failed attempt is preserved. Source files remain hash-verified. The original
environment identifier binds Python/platform, not all dependencies.
A post-hoc inventory records the repair and duplicate package metadata;
it cannot retroactively establish a complete contemporaneous environment
identity. Each representation comparison still uses the same persisted
input trace.

\subsection{Held-out topology costs}
Table~\ref{tab:v11-gains} compares frozen refined selections to historical
compact selection. The primary cap32 method improves two of five admitted
project cases and ties three. The cap64 results were designated secondary
before collection; they do not replace the primary endpoint. Both methods
are fitted on runs 0--1, selected on run 2 and scored on runs 3--4.
All selected layouts were hash-frozen before those held-out costs were opened.
\begin{table}[t]\centering\footnotesize
\caption{Held-out padded-byte reduction (\%) relative to the historical
compact catalogue. Construction is included. UNKNOWN is not a tie.}
\label{tab:v11-gains}
\begin{tabular}{@{}lrr@{}}\toprule
Project & Cap32 primary & Cap64 secondary\\\midrule
""" + gain + r"""
\bottomrule\end{tabular}
\end{table}

The positive secondary reductions range from 16.00\% to 18.69\%; attrs
retains its incumbent. The gain is a measured topology-refinement effect
at the stated order, not a causal demonstration that higher-order information
alone explains it. Figure~\ref{fig:v11-boundaries} separates this representation
endpoint from service time.

Packaging has 26,948 declared checks. One dense float64 affinity matrix
alone would require about 5.81\,GB (5.41\,GiB); dictionary/heap clustering
needs more. The compiler therefore records optimization UNKNOWN under its
2\,GiB campaign budget, retains every ID and supplies an explicitly labeled
compact fallback only for conformance/scaling records. It is excluded from
the five-project compiler comparison rather than being counted as a tie.

\subsection{Transfer to historical-source regressions}
An additional frozen plan selects eleven real upstream fix commits by
syntax and history, transplants their parent production modules into
isolated release snapshots, and runs unchanged release tests with
stop-on-first-failure. Nine cases execute; eight preserve the release
registry. Two startup incompatibilities and one changed semantic ID set
are VOID for paired analysis. One matching Packaging case remains UNKNOWN
because fitting was not admitted. The seven measured transfers yield
two primary wins, three ties and two losses. In particular, Click's
primary layout costs 2.09\% and 2.58\% more than the historical compact layout
on its two partial trajectories. The retained all-pass Jinja case is
unrevealing, rather than excluded.

These are exploratory source transplants under a newer fixed test contract,
not executions of each native historical parent suite or a certified
natural-bug benchmark. They share project tests and supply no extra
independent project replication. No source-transfer outcome changes the
frozen layout. The losses demonstrate that training monotonicity and a
successful repeated-snapshot holdout do not ensure benefit after a source
or stopping-pattern change.

\subsection{Whole-trajectory service accounting}
The new comparison admits five project cases at the fixed 2,048-check
service budget; both complete Packaging inputs remain UNKNOWN without
subsampling. It executes four arms, three randomized-order repeats and
cold/warm queries at initial, intermediate and final snapshots.
All """ + f"{summary['service_oracle_answer_checks']:,}" + r""" service/oracle answer checks agree,
including exact epoch and missing-check disclosure. Each arm delivers the
same complete answer bytes under the common deterministic codec.

\begin{table}[t]\centering\footnotesize
\caption{Local service operation time (ms), mean of two per-case medians over
three whole-trajectory timing repeats. Builds, all ingests, queries and
codec work are included. Layout fitting is reported separately.
No network or agent inference occurs.}\label{tab:v11-time}
\begin{tabular}{@{}lrrr@{}}\toprule
Project & Indexed & Counters & HACT32\\\midrule
""" + timing + r"""
\bottomrule\end{tabular}
\end{table}

The selected HACT service is slower than the maintained-counter ledger in
every admitted project case. Its ratio of mean case-median operation times
ranges from 1.44 to 2.42 on this host. Additional layout fitting and manifest
admission cannot turn those observed service losses into a positive
end-to-end speedup. The table times precompiled service execution and does
not hide fitting inside common checker time. Compiler receipts retain
separate one-time fit/selection measurements; their concurrent collection
load makes them descriptive rather than controlled speedup estimates.
The outcome supports a maintained ledger as the initial service baseline
for these requests, while preserving the distinct within-format packet
savings above.

\begin{figure*}[t]\centering
\includegraphics[width=.96\textwidth]{figures/v11_boundaries.pdf}
\caption{Different endpoints lead to different adoption decisions.
Left: primary and prespecified secondary held-out padded-byte savings.
Right: measured precompiled service time of primary HACT divided by the
maintained-counter ledger; values above one are slower. Packaging is
UNKNOWN under resource admission and is not plotted as zero.}
\label{fig:v11-boundaries}
\end{figure*}
"""


def plots(summary):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    rows = [r for r in summary["public_projects"] if r["compiler_status"] == "PASS"]
    names = [NAMES[r["project"]] for r in rows]
    x = np.arange(len(rows)); width = .34
    with plt.rc_context({"font.size": 9, "axes.spines.top": False,
                         "axes.spines.right": False, "pdf.fonttype": 42}):
        fig, axes = plt.subplots(1, 2, figsize=(9.1, 3.0))
        a = axes[0]
        a.bar(x-width/2, [r["primary_saving_percent"] for r in rows], width,
              color="#275b8a", label="cap32 (primary)")
        a.bar(x+width/2, [r["secondary_saving_percent"] for r in rows], width,
              color="#58a6a6", label="cap64 (secondary)")
        a.set_ylabel("Padded-byte reduction (%)")
        a.set_ylim(0, 22); a.set_xticks(x, names, rotation=22, ha="right")
        a.set_title("(a) Held-out representation cost", loc="left", fontsize=10)
        a.legend(frameon=False, fontsize=8)
        b = axes[1]
        ratios = [r["service_selected_to_counter_ratio"] for r in rows]
        b.bar(x, ratios, color="#747d8c", width=.58)
        b.axhline(1, color="#a34a34", linewidth=1, linestyle="--")
        for i, val in enumerate(ratios):
            b.text(i, val+.05, f"{val:.2f}", ha="center", fontsize=8)
        b.set_ylabel("HACT32 / counter-ledger time")
        b.set_xticks(x, names, rotation=22, ha="right"); b.set_ylim(0, 3.0)
        b.set_title("(b) Whole service operations", loc="left", fontsize=10)
        fig.tight_layout(w_pad=2.2)
        out = ROOT/"paper/figures/v11_boundaries"
        fig.savefig(out.with_suffix(".pdf"), metadata={"CreationDate": None, "ModDate": None})
        fig.savefig(out.with_suffix(".png"), dpi=180)
        plt.close(fig)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    report = summarize()
    targets = {
        ROOT/"results/v11/report_summary.json": json.dumps(report, indent=2, sort_keys=True)+"\n",
        ROOT/"paper/v11_journal_results.tex": tex(report),
    }
    if args.check:
        for path, expected in targets.items():
            if path.read_text() != expected:
                raise ValueError(f"stale or corrupted report projection: {path}")
        print("V11 report projection and answer/codec signatures PASS")
    else:
        for path, data in targets.items():
            path.write_text(data)
        plots(report)
        print(json.dumps({k: report[k] for k in ("full_suite_runs",
             "full_suite_check_executions", "service_oracle_answer_checks", "transfer_primary")}))


if __name__ == "__main__":
    main()
