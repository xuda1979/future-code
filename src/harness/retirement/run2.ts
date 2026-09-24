/**
 * v2 cohort runner (frozen protocol v2). Full factorial over retention
 * R (7) × scheduler S (2); evidence-layout ablation E (flat vs hact)
 * once per cell on the held-out half; three-phase accounting; two cost
 * regimes; long-horizon sub-cohort. Deterministic; no network; no
 * model calls.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { runPolicy2, flatLedger2, hactLedger2, type PolicyName2 } from "./engine2.ts";
import { buildPersistenceStream } from "./stream.ts";
import type { Episode } from "./types.ts";

export const SIZES2 = [128, 512, 1024, 4096] as const;
export const FAMILIES2 = ["clustered", "independent", "global"] as const;
export const SEEDS2 = [55011, 55012, 55013, 55014, 55015, 55016, 55017] as const;
export const EPISODES2 = 40;
export const LONG_EPISODES = 160;
const TRAIN_SPLIT = 20;

export interface RetentionArm { name: string; policy: PolicyName2 }

export const RETENTION_ARMS: readonly RetentionArm[] = [
  { name: "full-replay", policy: "full-replay" },
  { name: "masking", policy: "masking" },
  { name: "summary-reset", policy: "summary-reset" },
  { name: "bounded-hier", policy: "bounded-hier" },
  { name: "verified-board", policy: "verified-board" },
  { name: "frontier", policy: "frontier" },
  { name: "frontier-adaptive", policy: "frontier-adaptive" },
] as const;

export interface RunResult2 {
  arm: string;              // "R|S" e.g. "frontier|adaptive"
  policy: string;
  scheduler: "fixed" | "adaptive";
  seed: number; size: number; family: string;
  contextBytes: number; retrievalBytes: number; retrievalOps: number;
  stalenessDefects: number; obligationLoss: number;
  accepted: boolean; auditFailed: boolean;
  makespanRounds: number; calls: number;
  costO: number;
  construction: { contextBytes: number; retrievalBytes: number; retrievalOps: number };
  steady: { contextBytes: number; retrievalBytes: number; retrievalOps: number };
  auditTail: { contextBytes: number; retrievalBytes: number; retrievalOps: number };
  audit: {
    staleRetention: number; missingObligations: number;
    phantomObligations: number; defectiveService: number;
  };
  evidenceBytes: number;    // 0 unless the run carries the E factor
  evidenceLayout: "flat" | "hact" | "none";
}

export interface EvidenceAblation {
  size: number; family: string; seed: number;
  flatBytes: number; hactBytes: number;
  /** Measured update density on the training half. */
  trainDensity: number;
}

export interface CohortResult2 {
  runs: RunResult2[];
  evidence: EvidenceAblation[];
  longRuns: RunResult2[];
  generatedAt: string;
  protocol: string;
  nodeVersion: string;
  runtime: string;
}

function runOne(
  arm: RetentionArm, scheduler: "fixed" | "adaptive",
  episodes: Episode[], seed: number, size: number, family: string,
): RunResult2 {
  const r = runPolicy2(
    { name: arm.policy, adaptive: scheduler === "adaptive" },
    episodes, seed,
  );
  return {
    arm: `${arm.name}|${scheduler}`,
    policy: arm.name, scheduler,
    seed, size, family,
    contextBytes: r.contextBytes, retrievalBytes: r.retrievalBytes,
    retrievalOps: r.retrievalOps,
    stalenessDefects: r.stalenessDefects, obligationLoss: r.obligationLoss,
    accepted: r.accepted, auditFailed: r.auditFailed,
    makespanRounds: r.makespanRounds, calls: r.calls,
    costO: r.costO,
    construction: r.construction, steady: r.steady, auditTail: r.auditTail,
    audit: r.audit,
    evidenceBytes: 0, evidenceLayout: "none",
  };
}

export function runCohort2(): CohortResult2 {
  const runs: RunResult2[] = [];
  const evidence: EvidenceAblation[] = [];
  const longRuns: RunResult2[] = [];

  // ── Main factorial grid: 4 sizes × 3 families × 7 seeds × 7 R × 2 S.
  for (const size of SIZES2) {
    for (const family of FAMILIES2) {
      for (const seed of SEEDS2) {
        const episodes = buildPersistenceStream({ size, family, seed, episodes: EPISODES2 });
        for (const arm of RETENTION_ARMS) {
          for (const scheduler of ["fixed", "adaptive"] as const) {
            runs.push(runOne(arm, scheduler, episodes, seed, size, family));
          }
        }
        // Evidence ablation E, once per cell (held-out half).
        const train = episodes.slice(0, TRAIN_SPLIT).map(e => [...e.invalidated]);
        const held = episodes.slice(TRAIN_SPLIT).map(e => [...e.invalidated]);
        const flat = flatLedger2(size).runBytes(held);
        const hact = hactLedger2(train, size).runBytes(held);
        const density = trainDensity(train, size);
        evidence.push({ size, family, seed, flatBytes: flat, hactBytes: hact, trainDensity: density });
      }
    }
  }

  // ── Long-horizon sub-cohort: n=1024, 160 episodes, S=fixed.
  for (const family of FAMILIES2) {
    for (const seed of SEEDS2) {
      const episodes = buildPersistenceStream({ size: 1024, family, seed, episodes: LONG_EPISODES });
      for (const armName of ["masking", "frontier", "frontier-adaptive"]) {
        const arm = RETENTION_ARMS.find(a => a.name === armName)!;
        longRuns.push(runOne(arm, "fixed", episodes, seed, 1024, family));
      }
    }
  }

  return {
    runs, evidence, longRuns,
    generatedAt: new Date().toISOString(),
    protocol: "docs/protocols/CONTEXT_RETIREMENT_PROTOCOL_v2.md (+ ENGINE_NOTES)",
    nodeVersion: process.version,
    runtime: `bun ${process.versions.bun ?? "n/a"}`,
  };
}

function trainDensity(train: number[][], size: number): number {
  if (!train.length) return 0;
  let cells = 0, hits = 0;
  for (const set of train) {
    cells += size; hits += set.length;
  }
  return hits / cells;
}

// ─── Aggregation helpers ──────────────────────────────────────────────────

export interface ArmSummary2 {
  arm: string; policy: string; scheduler: string;
  runs: number; accepted: number; auditFailed: number;
  ctxPerRun: number; retPerRun: number; opsPerRun: number;
  bytesPerRun: number; costOPerRun: number;
  steadyBytesPerRun: number; steadyOpsPerRun: number;
  makespanPerRun: number;
  staleTotal: number; lostTotal: number;
  auditTotal: { staleRetention: number; missingObligations: number; phantomObligations: number; defectiveService: number };
}

export function summarize2(runs: RunResult2[]): ArmSummary2[] {
  const byArm = new Map<string, {
    a: ArmSummary2; ctx: number; ret: number; ops: number; costO: number;
    steadyB: number; steadyO: number; mk: number;
  }>();
  for (const r of runs) {
    let e = byArm.get(r.arm);
    if (!e) {
      e = {
        a: {
          arm: r.arm, policy: r.policy, scheduler: r.scheduler,
          runs: 0, accepted: 0, auditFailed: 0,
          ctxPerRun: 0, retPerRun: 0, opsPerRun: 0,
          bytesPerRun: 0, costOPerRun: 0,
          steadyBytesPerRun: 0, steadyOpsPerRun: 0,
          makespanPerRun: 0, staleTotal: 0, lostTotal: 0,
          auditTotal: { staleRetention: 0, missingObligations: 0, phantomObligations: 0, defectiveService: 0 },
        },
        ctx: 0, ret: 0, ops: 0, costO: 0, steadyB: 0, steadyO: 0, mk: 0,
      };
      byArm.set(r.arm, e);
    }
    e.a.runs++; if (r.accepted) e.a.accepted++;
    if (r.auditFailed) e.a.auditFailed++;
    e.ctx += r.contextBytes; e.ret += r.retrievalBytes; e.ops += r.retrievalOps;
    e.costO += r.costO;
    e.steadyB += r.steady.contextBytes + r.steady.retrievalBytes;
    e.steadyO += r.steady.retrievalOps;
    e.mk += r.makespanRounds;
    e.a.staleTotal += r.stalenessDefects; e.a.lostTotal += r.obligationLoss;
    e.a.auditTotal.staleRetention += r.audit.staleRetention;
    e.a.auditTotal.missingObligations += r.audit.missingObligations;
    e.a.auditTotal.phantomObligations += r.audit.phantomObligations;
    e.a.auditTotal.defectiveService += r.audit.defectiveService;
  }
  return [...byArm.values()].map(e => {
    const n = e.a.runs;
    return {
      ...e.a,
      ctxPerRun: Math.round(e.ctx / n), retPerRun: Math.round(e.ret / n),
      opsPerRun: Math.round(e.ops / n),
      bytesPerRun: Math.round((e.ctx + e.ret) / n),
      costOPerRun: Math.round(e.costO / n),
      steadyBytesPerRun: Math.round(e.steadyB / n),
      steadyOpsPerRun: Math.round(e.steadyO / n),
      makespanPerRun: Math.round(e.mk / n),
    };
  }).sort((x, y) => x.arm.localeCompare(y.arm));
}

/** Family-stratum regime-O cost per accepted run for one policy. */
export function stratumCostO(runs: RunResult2[], policy: string, family?: string): Map<string, number> {
  const byFam = new Map<string, { cost: number; acc: number }>();
  for (const r of runs) {
    if (r.policy !== policy) continue;
    if (family && r.family !== family) continue;
    const e = byFam.get(r.family) ?? { cost: 0, acc: 0 };
    e.cost += r.costO;
    if (r.accepted) e.acc++;
    byFam.set(r.family, e);
  }
  const out = new Map<string, number>();
  for (const [fam, e] of byFam) out.set(fam, e.acc ? Math.round(e.cost / e.acc) : -1);
  return out;
}

// ─── Factor contrasts (from the full factorial; see protocol v2 item 1) ───

export interface FactorContrasts {
  /** S main effect on regime-B bytes, as a fraction of the grand mean. */
  sEffectOnBytesPct: number;
  /** R×S interaction on makespan rounds: max |Δ| across retention levels. */
  rsInteractionOnMakespan: number;
  /** Detail per retention policy. */
  perPolicy: { policy: string; fixedBytes: number; adaptiveBytes: number; fixedMakespan: number; adaptiveMakespan: number }[];
}

export function factorContrasts(runs: RunResult2[]): FactorContrasts {
  const per = new Map<string, { fb: number; ab: number; fm: number; am: number; nf: number; na: number }>();
  let grandBytes = 0, grandN = 0;
  for (const r of runs) {
    const bytes = r.contextBytes + r.retrievalBytes;
    grandBytes += bytes; grandN++;
    let e = per.get(r.policy);
    if (!e) { e = { fb: 0, ab: 0, fm: 0, am: 0, nf: 0, na: 0 }; per.set(r.policy, e); }
    if (r.scheduler === "fixed") { e.fb += bytes; e.fm += r.makespanRounds; e.nf++; }
    else { e.ab += bytes; e.am += r.makespanRounds; e.na++; }
  }
  const grand = grandBytes / grandN;
  const perPolicy = [...per.entries()].map(([policy, e]) => ({
    policy,
    fixedBytes: Math.round(e.fb / e.nf), adaptiveBytes: Math.round(e.ab / e.na),
    fixedMakespan: Math.round(e.fm / e.nf), adaptiveMakespan: Math.round(e.am / e.na),
  })).sort((a, b) => a.policy.localeCompare(b.policy));
  // S main effect: mean(adaptive) - mean(fixed) over all runs, as % of grand mean.
  const fixedMean = runs.filter(r => r.scheduler === "fixed").reduce((s, r) => s + r.contextBytes + r.retrievalBytes, 0)
    / Math.max(1, runs.filter(r => r.scheduler === "fixed").length);
  const adaptMean = runs.filter(r => r.scheduler === "adaptive").reduce((s, r) => s + r.contextBytes + r.retrievalBytes, 0)
    / Math.max(1, runs.filter(r => r.scheduler === "adaptive").length);
  const rsInteraction = Math.max(...perPolicy.map(p =>
    Math.abs(p.adaptiveMakespan - p.fixedMakespan)));
  return {
    sEffectOnBytesPct: grand > 0 ? ((adaptMean - fixedMean) / grand) * 100 : 0,
    rsInteractionOnMakespan: rsInteraction,
    perPolicy,
  };
}

// ─── Closure rules (frozen v2) ────────────────────────────────────────────

export interface ClosureReport2 {
  nullClosure: { triggered: boolean; detail: string; reductionPct: number; worstFamily: string; worstFamilyPct: number };
  attributionClosure: { triggered: boolean; detail: string; sEffectOnBytesPct: number };
  hactClosure: { denseStratumPass: boolean; detail: string; densityRuleRegretPct: number };
  adaptiveClosure: { promotable: boolean; detail: string; reductionPct: number; worstFamilyPct: number };
  auditClosure: { failedArms: string[]; detail: string };
}

function costOPerAccepted(runs: RunResult2[], policy: string, scheduler = "fixed"): number | null {
  const a = runs.filter(r => r.policy === policy && r.scheduler === scheduler && r.family !== undefined);
  const acc = a.filter(r => r.accepted);
  if (!acc.length) return null;
  return acc.reduce((s, r) => s + r.costO, 0) / acc.length;
}

export function applyClosures2(runs: RunResult2[], evidence: EvidenceAblation[], longRuns: RunResult2[]): ClosureReport2 {
  // ── Null closure (v2): frontier vs masking on regime-O cost per
  //    accepted run, pooled, plus the family-stratum regression clause.
  const fO = costOPerAccepted(runs, "frontier");
  const mO = costOPerAccepted(runs, "masking");
  const reductionPct = fO !== null && mO !== null ? (1 - fO / mO) * 100 : 0;
  let worstFamily = "none", worstFamilyPct = 0;
  for (const fam of FAMILIES2) {
    const f = costOPerAccepted(runs.filter(r => r.family === fam), "frontier");
    const m = costOPerAccepted(runs.filter(r => r.family === fam), "masking");
    if (f !== null && m !== null) {
      const pct = (f / m - 1) * 100; // >0 means frontier regresses
      if (pct > worstFamilyPct) { worstFamilyPct = pct; worstFamily = fam; }
    }
  }
  const nullTriggered = !(fO !== null && mO !== null && reductionPct >= 20 && worstFamilyPct <= 10);
  const nullDetail = fO === null || mO === null
    ? "undefined cost (an arm never accepted)"
    : `frontier ${Math.round(fO)} vs masking ${Math.round(mO)} regime-O per accepted (reduction ${reductionPct.toFixed(1)}%, needs ≥20%); worst family regression ${worstFamily} ${worstFamilyPct.toFixed(1)}% (needs ≤10%)`;

  // ── Attribution closure: S main effect on bytes must be ≤1% of grand mean.
  const contrasts = factorContrasts(runs);
  const attributionTriggered = Math.abs(contrasts.sEffectOnBytesPct) > 1;
  const attributionDetail = `scheduler main effect on regime-B bytes ${contrasts.sEffectOnBytesPct.toFixed(3)}% of grand mean (leak threshold 1%); R×S makespan interaction ${contrasts.rsInteractionOnMakespan} rounds`;

  // ── HACT closure: dense stratum (global family) held-out evidence bytes.
  const dense = evidence.filter(e => e.family === "global");
  const denseFlat = dense.reduce((s, e) => s + e.flatBytes, 0) / Math.max(1, dense.length);
  const denseHact = dense.reduce((s, e) => s + e.hactBytes, 0) / Math.max(1, dense.length);
  const densePass = denseHact <= denseFlat * 0.95;
  // Density decision rule regret: select tree iff trainDensity ≥ 0.5.
  let ruleFlat = 0, ruleBest = 0;
  for (const e of evidence) {
    const pickTree = e.trainDensity >= 0.5;
    const picked = pickTree ? e.hactBytes : e.flatBytes;
    const best = Math.min(e.flatBytes, e.hactBytes);
    ruleFlat += e.flatBytes; ruleBest += picked;
  }
  const oracleBest = evidence.reduce((s, e) => s + Math.min(e.flatBytes, e.hactBytes), 0);
  const densityRuleRegretPct = ruleFlat > 0 ? (1 - ruleBest / oracleBest) * 100 : 0;
  const hactDetail = `dense stratum: hact ${Math.round(denseHact)} vs flat ${Math.round(denseFlat)} held-out B/cell (gate ≤95%): ${densePass ? "pass" : "fail"}; density-rule regret vs per-cell oracle ${(100 - (ruleBest / oracleBest) * 100).toFixed(1)}%`;

  // ── Adaptive-coordination closure.
  const frontierRuns = runs.filter(r => r.policy === "frontier" && r.scheduler === "fixed");
  const adaptiveRuns = runs.filter(r => r.policy === "frontier-adaptive" && r.scheduler === "fixed");
  const fAcc = frontierRuns.filter(r => r.accepted).length;
  const aAcc = adaptiveRuns.filter(r => r.accepted).length;
  const aAuditFail = adaptiveRuns.filter(r => r.auditFailed).length;
  const fCost = costOPerAccepted(runs, "frontier-adaptive");
  const adaptReduction = fO !== null && fCost !== null ? (1 - fCost / fO) * 100 : 0;
  let worstAdapt = 0;
  for (const fam of FAMILIES2) {
    const f = costOPerAccepted(runs.filter(r => r.family === fam), "frontier");
    const a = costOPerAccepted(runs.filter(r => r.family === fam), "frontier-adaptive");
    if (f !== null && a !== null) {
      const pct = (a / f - 1) * 100;
      if (pct > worstAdapt) worstAdapt = pct;
    }
  }
  const adaptivePromotable = aAcc === fAcc && aAuditFail === 0
    && fO !== null && fCost !== null && adaptReduction >= 10 && worstAdapt <= 5;
  const adaptiveDetail = `acceptance ${aAcc}/${adaptiveRuns.length} vs frontier ${fAcc}/${frontierRuns.length}; audit-failing ${aAuditFail}; regime-O reduction vs frontier ${adaptReduction.toFixed(1)}% (needs ≥10%); worst family regression ${worstAdapt.toFixed(1)}% (needs ≤5%)`;

  // ── Audit closure: arms with A3 defects.
  const failedArms = [...new Set(runs.filter(r => r.auditFailed).map(r => r.policy))].sort();
  const auditDetail = failedArms.length
    ? `arms with A3 defective service: ${failedArms.join(", ")}`
    : "no A3 defective service in any arm's audit tail";

  void longRuns;
  return {
    nullClosure: { triggered: nullTriggered, detail: nullDetail, reductionPct, worstFamily, worstFamilyPct },
    attributionClosure: { triggered: attributionTriggered, detail: attributionDetail, sEffectOnBytesPct: contrasts.sEffectOnBytesPct },
    hactClosure: { denseStratumPass: densePass, detail: hactDetail, densityRuleRegretPct },
    adaptiveClosure: { promotable: adaptivePromotable, detail: adaptiveDetail, reductionPct: adaptReduction, worstFamilyPct: worstAdapt },
    auditClosure: { failedArms, detail: auditDetail },
  };
}

export function writeCohort2(outDir: string): CohortResult2 {
  const cohort = runCohort2();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/cohort2.json`, JSON.stringify(cohort, null, 2));
  writeFileSync(`${outDir}/closures2.json`, JSON.stringify(applyClosures2(cohort.runs, cohort.evidence, cohort.longRuns), null, 2));
  writeFileSync(`${outDir}/summary2.json`, JSON.stringify(summarize2(cohort.runs), null, 2));
  return cohort;
}
