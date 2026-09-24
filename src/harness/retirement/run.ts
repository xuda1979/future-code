/**
 * Cohort runner: executes the frozen protocol grid, evaluates the
 * evidence ablation on held-out halves, and applies the three frozen
 * closure rules. Deterministic; no network; no model calls.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { flatLedger, hactLedger, runPolicy, type PolicyName } from "./engine.ts";
import { buildPersistenceStream } from "./stream.ts";
import type { Episode, RunResult } from "./types.ts";

export const SIZES = [128, 512, 1024] as const;
export const FAMILIES = ["clustered", "independent", "global"] as const;
export const SEEDS = [55011, 55012, 55013, 55014, 55015, 55016, 55017] as const;
export const EPISODES = 40;
const TRAIN_SPLIT = 20; // first 20 episodes train the layout order (item 17).

export interface ArmDef { name: string; policy: PolicyName; adaptive: boolean }

export const ARMS: readonly ArmDef[] = [
  { name: "full-replay", policy: "full-replay", adaptive: false },
  { name: "masking", policy: "masking", adaptive: false },
  { name: "summary-reset", policy: "summary-reset", adaptive: false },
  { name: "bounded-hier", policy: "bounded-hier", adaptive: false },
  { name: "verified-board", policy: "verified-board", adaptive: false },
  { name: "frontier", policy: "frontier", adaptive: false },
  { name: "frontier+adapt", policy: "frontier", adaptive: true },
  { name: "adapt-only", policy: "masking", adaptive: true },
  { name: "frontier+flat", policy: "frontier", adaptive: false },
  { name: "frontier+hact", policy: "frontier", adaptive: false },
] as const;

export interface CohortResult {
  runs: RunResult[];
  generatedAt: string;
  protocol: string;
  nodeVersion: string;
  engine: string;
  runtime: string;
}

export function runCohort(): CohortResult {
  const runs: RunResult[] = [];
  for (const size of SIZES) {
    for (const family of FAMILIES) {
      for (const seed of SEEDS) {
        const episodes = buildPersistenceStream({ size, family, seed, episodes: EPISODES });
        const train = episodes.slice(0, TRAIN_SPLIT);
        const held = episodes.slice(TRAIN_SPLIT);
        const trainChanges = train.map(e => [...e.invalidated]);
        const heldChanges = held.map(e => [...e.invalidated]);
        const flat = flatLedger(size);
        const hact = hactLedger(trainChanges, size);
        for (const arm of ARMS) {
          const r = runPolicy({ name: arm.policy, adaptive: arm.adaptive }, episodes, seed);
          const evidenceBytes = arm.name === "frontier+flat"
            ? flat.runBytes(heldChanges)
            : arm.name === "frontier+hact"
              ? hact.runBytes(heldChanges)
              : 0;
          runs.push({
            arm: arm.name, seed, size, family,
            contextBytes: r.contextBytes,
            retrievalBytes: r.retrievalBytes,
            stalenessDefects: r.stalenessDefects,
            obligationLoss: r.obligationLoss,
            accepted: r.accepted,
            makespanEpisodes: r.makespanRounds,
            evidenceBytes,
            calls: r.calls,
            retrievalOps: r.retrievalOps,
            makespanRounds: r.makespanRounds,
          });
        }
      }
    }
  }
  return {
    runs,
    generatedAt: new Date().toISOString(),
    protocol: "docs/protocols/CONTEXT_RETIREMENT_PROTOCOL_v1.md (amendments v1.1–v1.4)",
    nodeVersion: process.version,
    engine: "src/harness/retirement/engine.ts (amended accounting)",
    runtime: `bun ${process.versions.bun ?? "n/a"} (node compat ${process.version})`,
  };
}

export interface ClosureReport {
  nullClosure: { triggered: boolean; detail: string };
  attributionClosure: { triggered: boolean; detail: string; dimensionNote: string };
  hactClosure: { triggered: boolean; detail: string };
}

export function costPerAccepted(runs: RunResult[], arm: string): number | null {
  const a = runs.filter(r => r.arm === arm);
  if (!a.length) return null;
  const accepted = a.filter(r => r.accepted).length;
  if (!accepted) return null;
  return a.reduce((s, r) => s + r.contextBytes + r.retrievalBytes, 0) / accepted;
}

export function applyClosures(runs: RunResult[]): ClosureReport {
  const frontier = costPerAccepted(runs, "frontier");
  const baselineArms = ["full-replay", "masking", "summary-reset", "bounded-hier", "verified-board"];
  const baselines = baselineArms.map(a => costPerAccepted(runs, a)).filter((x): x is number => x !== null);
  const bestBaseline = baselines.length ? Math.min(...baselines) : null;

  const nullTriggered = frontier === null || bestBaseline === null || frontier > bestBaseline * 0.8;
  const nullDetail = frontier === null || bestBaseline === null
    ? "undefined cost (an arm never accepted)"
    : `frontier ${Math.round(frontier)} vs best baseline ${Math.round(bestBaseline)} (threshold ≤ ${Math.round(bestBaseline * 0.8)})`;

  const fa = costPerAccepted(runs, "frontier+adapt");
  const ao = costPerAccepted(runs, "adapt-only");
  const attributionTriggered = fa === null || ao === null || Math.abs(fa - ao) <= ao * 0.1;
  const attributionDetail = fa === null || ao === null
    ? "undefined cost"
    : `frontier+adapt ${Math.round(fa)} vs adapt-only ${Math.round(ao)} (within 10%: ${Math.abs(fa - ao) <= ao * 0.1 ? "yes" : "no"})`;

  const flatRuns = runs.filter(r => r.arm === "frontier+flat" && r.accepted);
  const hactRuns = runs.filter(r => r.arm === "frontier+hact" && r.accepted);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const flatBytes = mean(flatRuns.map(r => r.evidenceBytes));
  const hactBytes = mean(hactRuns.map(r => r.evidenceBytes));
  const hactTriggered = flatBytes === null || hactBytes === null || hactBytes > flatBytes * 0.95;
  const hactDetail = flatBytes === null || hactBytes === null
    ? "undefined evidence bytes"
    : `hact ${Math.round(hactBytes)} vs flat ${Math.round(flatBytes)} B/run (threshold: hact ≤ ${Math.round(flatBytes * 0.95)})`;

  return {
    nullClosure: { triggered: nullTriggered, detail: nullDetail },
    attributionClosure: {
      triggered: attributionTriggered,
      detail: attributionDetail,
      dimensionNote: "scheduler dimension is byte-neutral by design (item 6): a byte-level trigger must be read with the dimension-separated interpretation (item 18) — scheduler effects on makespan, retirement effects on bytes/ops.",
    },
    hactClosure: { triggered: hactTriggered, detail: hactDetail },
  };
}

export function writeCohort(outDir: string): CohortResult {
  const cohort = runCohort();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/cohort.json`, JSON.stringify(cohort, null, 2));
  writeFileSync(`${outDir}/closures.json`, JSON.stringify(applyClosures(cohort.runs), null, 2));
  return cohort;
}
