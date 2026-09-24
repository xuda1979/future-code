/**
 * CLI: run the frozen context-retirement cohort, write results, and
 * print the closure report. Deterministic; no network; no model calls.
 *
 *   bun src/harness/retirement/cli.ts --out .future-code/retirement
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { applyClosures, runCohort } from "./run.ts";

const outDir = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]!
  : ".future-code/retirement";

const cohort = runCohort();
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/cohort.json`, JSON.stringify(cohort, null, 2));
writeFileSync(`${outDir}/closures.json`, JSON.stringify(applyClosures(cohort.runs), null, 2));

// Per-arm and per-cell summaries for the manuscript generator.
const byArm = new Map<string, { ctx: number; ret: number; ops: number; ok: number; n: number; stale: number; lost: number; ev: number; mk: number }>();
for (const r of cohort.runs) {
  const a = byArm.get(r.arm) ?? { ctx: 0, ret: 0, ops: 0, ok: 0, n: 0, stale: 0, lost: 0, ev: 0, mk: 0 };
  a.ctx += r.contextBytes; a.ret += r.retrievalBytes; a.ops += r.retrievalOps;
  a.stale += r.stalenessDefects; a.lost += r.obligationLoss; a.ev += r.evidenceBytes; a.mk += r.makespanRounds;
  if (r.accepted) a.ok++; a.n++;
  byArm.set(r.arm, a);
}
const summary = [...byArm.entries()].map(([arm, a]) => ({
  arm, runs: a.n, accepted: a.ok,
  ctxPerRun: Math.round(a.ctx / a.n), retPerRun: Math.round(a.ret / a.n),
  opsPerRun: Math.round(a.ops / a.n), evidencePerRun: Math.round(a.ev / a.n),
  makespanPerRun: Math.round(a.mk / a.n),
  staleTotal: a.stale, lostTotal: a.lost,
}));
writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ runs: cohort.runs.length, closures: applyClosures(cohort.runs), summary }, null, 2));
