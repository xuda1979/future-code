/**
 * Generate the v2 TeX tables and macros from the frozen v2 cohort.
 * Reads .future-code/retirement2/*.json; writes paper/generated/*2.tex.
 * Deterministic; no model calls.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { applyClosures2, summarize2, type CohortResult2, type RunResult2, type EvidenceAblation } from "./run2.ts";

const base = ".future-code/retirement2";
const cohort: CohortResult2 = JSON.parse(readFileSync(`${base}/cohort2.json`, "utf8"));
const closures = applyClosures2(cohort.runs, cohort.evidence, cohort.longRuns);
const summary = summarize2(cohort.runs);

const fmt = (x: number): string => Math.round(x).toLocaleString("en-US").replace(/,/g, "{,}");
const pct = (x: number, d = 1): string => `${x >= 0 ? "" : ""}${x.toFixed(d)}\\%`;

function costO(runs: RunResult2[], policy: string, family?: string): number | null {
  const a = runs.filter(r => r.policy === policy && r.scheduler === "fixed" && (!family || r.family === family));
  const acc = a.filter(r => r.accepted);
  return acc.length ? acc.reduce((s, r) => s + r.costO, 0) / acc.length : null;
}
function costB(runs: RunResult2[], policy: string, family?: string): number | null {
  const a = runs.filter(r => r.policy === policy && r.scheduler === "fixed" && (!family || r.family === family));
  const acc = a.filter(r => r.accepted);
  return acc.length ? acc.reduce((s, r) => s + r.contextBytes + r.retrievalBytes, 0) / acc.length : null;
}
function opsMean(runs: RunResult2[], policy: string, family?: string): number | null {
  const a = runs.filter(r => r.policy === policy && r.scheduler === "fixed" && (!family || r.family === family));
  const acc = a.filter(r => r.accepted);
  return acc.length ? acc.reduce((s, r) => s + r.retrievalOps, 0) / acc.length : null;
}

// ─── Main table: one row per policy at S=fixed (the retention study) ──────
const polOrder = ["full-replay","masking","summary-reset","bounded-hier","verified-board","frontier","frontier-adaptive"];
const rows = polOrder.map(pol => {
  const a = cohort.runs.filter(r => r.policy === pol && r.scheduler === "fixed");
  const acc = a.filter(r => r.accepted);
  const s = summary.find(e => e.arm === `${pol}|fixed`)!;
  const b = costB(cohort.runs, pol);
  const o = costO(cohort.runs, pol);
  const ops = opsMean(cohort.runs, pol);
  return `${pol.replace(/-/g, "")}Row}{${pol} & ${acc.length}/${a.length} & ${fmt(b ?? 0)} & ${fmt(o ?? 0)} & ${fmt(ops ?? 0)} & ${fmt(s.auditTotal.defectiveService)} & ${fmt(s.staleTotal)} & ${fmt(s.lostTotal)} \\\\}`;
});

const tableMain = `% Auto-generated from the frozen v2 cohort (do not edit).
% Columns: policy, accepted, regime-B bytes/run, regime-O cost/run, ops/run,
% A3 audit defects, staleness defects, obligation losses.
${rows.map(r => `\\newcommand{\\Retwo${r}`).join("\n")}
`;

// ─── Stratum table: regime-O and bytes, per family ────────────────────────
const fams = ["clustered", "independent", "global"];
const stratumRows = fams.map(fam => {
  const mB = costB(cohort.runs, "masking", fam)!;
  const fB = costB(cohort.runs, "frontier", fam)!;
  const mO = costO(cohort.runs, "masking", fam)!;
  const fO = costO(cohort.runs, "frontier", fam)!;
  const mOps = opsMean(cohort.runs, "masking", fam)!;
  const fOps = opsMean(cohort.runs, "frontier", fam)!;
  return `\\newcommand{\\RetwoStratum${fam[0]!.toUpperCase()}${fam.slice(1)}Row}{${fam} & ${fmt(mB)} & ${fmt(fB)} & ${(100 * (1 - fO / mO)).toFixed(1)}\\% & ${fmt(mOps)} & ${fmt(fOps)} \\\\}`;
});
const tableStratum = `% Auto-generated from the frozen v2 cohort (do not edit).
${stratumRows.join("\n")}
`;

// ─── Long-horizon table ───────────────────────────────────────────────────
const lhRows: string[] = [];
for (const fam of fams) {
  const lr = cohort.longRuns.filter(r => r.family === fam && r.scheduler === "fixed");
  for (const pol of ["masking", "frontier", "frontier-adaptive"]) {
    const a = lr.filter(r => r.policy === pol);
    const acc = a.filter(r => r.accepted);
    const mean = (f: (r: RunResult2) => number) => acc.length ? acc.reduce((s, r) => s + f(r), 0) / acc.length : 0;
    lhRows.push(`\\newcommand{\\RetwoLong${fam[0]!.toUpperCase()}${fam.slice(1)}${pol.replace(/-/g, "")}Row}{${fam} & ${pol} & ${acc.length}/${a.length} & ${fmt(mean(r => r.retrievalOps))} & ${fmt(mean(r => r.costO))} & ${fmt(mean(r => r.contextBytes + r.retrievalBytes))} \\\\}`);
  }
}
const tableLong = `% Auto-generated from the frozen v2 cohort (do not edit).
${lhRows.join("\n")}
`;

// ─── Evidence-layout table (E ablation, per family pooled over sizes/seeds) ─
const evRows = fams.map(fam => {
  const e = cohort.evidence.filter(x => x.family === fam);
  const flat = e.reduce((s, x) => s + x.flatBytes, 0) / e.length;
  const hact = e.reduce((s, x) => s + x.hactBytes, 0) / e.length;
  return `\\newcommand{\\RetwoEv${fam[0]!.toUpperCase()}${fam.slice(1)}Row}{${fam} & ${fmt(flat)} & ${fmt(hact)} & ${(100 * (hact / flat - 1)).toFixed(1)}\\% \\\\}`;
});
const tableEvidence = `% Auto-generated from the frozen v2 cohort (do not edit).
${evRows.join("\n")}
`;

// ─── Macros ───────────────────────────────────────────────────────────────
const fO = costO(cohort.runs, "frontier")!;
const mO = costO(cohort.runs, "masking")!;
const fB = costB(cohort.runs, "frontier")!;
const mB = costB(cohort.runs, "masking")!;
const fOps = opsMean(cohort.runs, "frontier")!;
const mOps = opsMean(cohort.runs, "masking")!;

// Makespan pooled.
const mkFixed = cohort.runs.filter(r => r.scheduler === "fixed").reduce((s, r) => s + r.makespanRounds, 0)
  / cohort.runs.filter(r => r.scheduler === "fixed").length;
const mkAdapt = cohort.runs.filter(r => r.scheduler === "adaptive").reduce((s, r) => s + r.makespanRounds, 0)
  / cohort.runs.filter(r => r.scheduler === "adaptive").length;

// Long-horizon pooled ops cut (masking vs frontier).
const lhMask = cohort.longRuns.filter(r => r.policy === "masking" && r.accepted);
const lhFront = cohort.longRuns.filter(r => r.policy === "frontier" && r.accepted);
const lhMaskOps = lhMask.reduce((s, r) => s + r.retrievalOps, 0) / lhMask.length;
const lhFrontOps = lhFront.reduce((s, r) => s + r.retrievalOps, 0) / lhFront.length;
const lhMaskCost = lhMask.reduce((s, r) => s + r.costO, 0) / lhMask.length;
const lhFrontCost = lhFront.reduce((s, r) => s + r.costO, 0) / lhFront.length;

// Sensitivity: OPSBYTE ∈ {1024, 16384} recomputed from raw components.
function costOAt(runs: RunResult2[], policy: string, opbyte: number): number {
  const acc = runs.filter(r => r.policy === policy && r.scheduler === "fixed" && r.accepted);
  return acc.reduce((s, r) => s + r.contextBytes + r.retrievalBytes + opbyte * r.retrievalOps, 0) / acc.length;
}
const sens1024 = 100 * (1 - costOAt(cohort.runs, "frontier", 1024) / costOAt(cohort.runs, "masking", 1024));
const sens4096 = 100 * (1 - fO / mO);
const sens16384 = 100 * (1 - costOAt(cohort.runs, "frontier", 16384) / costOAt(cohort.runs, "masking", 16384));

// Summary-reset failure counts.
const srRuns = cohort.runs.filter(r => r.policy === "summary-reset" && r.scheduler === "fixed");
const srAcc = srRuns.filter(r => r.accepted).length;

const macros = `% Auto-generated from the frozen v2 cohort (do not edit).
\\newcommand{\\RetwoNullClosure}{${closures.nullClosure.triggered ? "\\textbf{triggered}" : "\\textbf{not triggered}"}}
\\newcommand{\\RetwoAttributionClosure}{${closures.attributionClosure.triggered ? "\\textbf{triggered}" : "\\textbf{not triggered}"}}
\\newcommand{\\RetwoHactClosure}{${closures.hactClosure.denseStratumPass ? "\\textbf{pass}" : "\\textbf{fail}"}}
\\newcommand{\\RetwoAdaptivePromotable}{${closures.adaptiveClosure.promotable ? "\\textbf{promotable}" : "\\textbf{not promotable}"}}
\\newcommand{\\RetwoAuditClosure}{${closures.auditClosure.failedArms.length ? "\\textbf{failed}" : "\\textbf{clean}"}}
\\newcommand{\\RetwoNullReduction}{${closures.nullClosure.reductionPct.toFixed(1)}\\%}
\\newcommand{\\RetwoNullThreshold}{20\\%}
\\newcommand{\\RetwoBytesDelta}{${(100 * (fB / mB - 1)).toFixed(1)}\\%}
\\newcommand{\\RetwoOpsReduction}{${(100 * (1 - fOps / mOps)).toFixed(1)}\\%}
\\newcommand{\\RetwoCostOReduction}{${(100 * (1 - fO / mO)).toFixed(1)}\\%}
\\newcommand{\\RetwoMakespanReduction}{${(100 * (1 - mkAdapt / mkFixed)).toFixed(1)}\\%}
\\newcommand{\\RetwoRuns}{${cohort.runs.length}}
\\newcommand{\\RetwoCells}{${cohort.runs.length / 14}}
\\newcommand{\\RetwoLongRuns}{${cohort.longRuns.length}}
\\newcommand{\\RetwoLongOpsReduction}{${(100 * (1 - lhFrontOps / lhMaskOps)).toFixed(1)}\\%}
\\newcommand{\\RetwoLongCostOReduction}{${(100 * (1 - lhFrontCost / lhMaskCost)).toFixed(1)}\\%}
\\newcommand{\\RetwoSensK}{${sens1024.toFixed(1)}\\%}
\\newcommand{\\RetwoSensM}{${sens4096.toFixed(1)}\\%}
\\newcommand{\\RetwoSensXxl}{${sens16384.toFixed(1)}\\%}
\\newcommand{\\RetwoSummaryResetAccepted}{${srAcc}/${srRuns.length}}
\\newcommand{\\RetwoSEffectOnBytes}{${closures.attributionClosure.sEffectOnBytesPct.toFixed(3)}\\%}
\\newcommand{\\RetwoDensityRegret}{${closures.hactClosure.densityRuleRegretPct.toFixed(1)}\\%}
\\newcommand{\\RetwoAdaptiveReduction}{${closures.adaptiveClosure.reductionPct.toFixed(1)}\\%}
\\newcommand{\\RetwoWorstFamily}{${closures.nullClosure.worstFamily === "none" ? "none" : closures.nullClosure.worstFamily}}
\\newcommand{\\RetwoFrontierAccepted}{${cohort.runs.filter(r => r.policy === "frontier" && r.scheduler === "fixed" && r.accepted).length}/${cohort.runs.filter(r => r.policy === "frontier" && r.scheduler === "fixed").length}}
`;

const outDir = "paper/generated";
writeFileSync(`${outDir}/retirement2_table.tex`, tableMain);
writeFileSync(`${outDir}/retirement2_stratum.tex`, tableStratum);
writeFileSync(`${outDir}/retirement2_long.tex`, tableLong);
writeFileSync(`${outDir}/retirement2_evidence.tex`, tableEvidence);
writeFileSync(`${outDir}/retirement2_macros.tex`, macros);
console.log("wrote 5 files to paper/generated/");
console.log(macros);
