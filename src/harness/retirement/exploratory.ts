/**
 * Pre-specified exploratory analyses on the frozen v2 cohort
 * (docs/protocols/EXPLORATORY_ANALYSES_v2.md, E1-E6).
 *
 * These functions are POST-data analyses of the frozen cohort and of
 * the frozen engine; they are deterministic and recompute every number
 * the manuscript's exploratory subsection reports. They are
 * exploratory, not confirmatory: the confirmatory results are the five
 * frozen closure rules of the v2 protocol.
 */
import { execSync } from "node:child_process";
import { flatLedger2, hactLedger2, runPolicy2 } from "./engine2.ts";
import { buildPersistenceStream } from "./stream.ts";
import type { Episode } from "./types.ts";
import type { RunResult2, CohortResult2 } from "./run2.ts";

// ─── E1/E5: break-even rule ───────────────────────────────────────────────

export interface StratumMeans { Bf: number; Bm: number; of: number; om: number }

export function stratumMeans(runs: RunResult2[], family?: string): StratumMeans {
  const acc = (policy: string) => runs.filter(r =>
    r.policy === policy && r.scheduler === "fixed" && (!family || r.family === family) && r.accepted);
  const mean = (a: RunResult2[], f: (r: RunResult2) => number) => a.length
    ? a.reduce((s, r) => s + f(r), 0) / a.length : 0;
  const fa = acc("frontier"), ma = acc("masking");
  return {
    Bf: mean(fa, r => r.contextBytes + r.retrievalBytes),
    Bm: mean(ma, r => r.contextBytes + r.retrievalBytes),
    of: mean(fa, r => r.retrievalOps),
    om: mean(ma, r => r.retrievalOps),
  };
}

/** R(c) = (Bf + c*of)/(Bm + c*om). */
export function costRatio(m: StratumMeans, c: number): number {
  return (m.Bf + c * m.of) / (m.Bm + c * m.om);
}

/** Closed-form break-even price: frontier meets gate rho iff c >= c_rho (E5). */
export function breakEven(m: StratumMeans, rho: number): number | null {
  if (m.of >= m.om) return null;             // no crossing possible
  const num = rho * m.Bm - m.Bf;
  const den = m.of - rho * m.om;
  if (num <= 0) return 0;                    // gate already met at c=0
  if (den <= 0) return null;                 // gate unreachable
  return num / den;
}

/** Break-even price at which policy x becomes cheaper than policy y (E6a). */
export function pairwiseBreakEven(runs: RunResult2[], x: string, y: string, family?: string): number | null {
  const acc = (policy: string) => runs.filter(r =>
    r.policy === policy && r.scheduler === "fixed" && (!family || r.family === family) && r.accepted);
  const mean = (a: RunResult2[], f: (r: RunResult2) => number) => a.length
    ? a.reduce((s, r) => s + f(r), 0) / a.length : 0;
  const xa = acc(x), ya = acc(y);
  const Bx = mean(xa, r => r.contextBytes + r.retrievalBytes), ox = mean(xa, r => r.retrievalOps);
  const By = mean(ya, r => r.contextBytes + r.retrievalBytes), oy = mean(ya, r => r.retrievalOps);
  if (ox === oy) return Bx < By ? 0 : null;
  const cs = (By - Bx) / (ox - oy);
  return cs <= 0 ? 0 : cs;
}

// ─── E2/E6c: paired sign tests ────────────────────────────────────────────

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return r;
}

export function signTest(runs: RunResult2[], x: string, y: string, metric: (r: RunResult2) => number) {
  const byCell = new Map<string, { x?: RunResult2; y?: RunResult2 }>();
  for (const r of runs) {
    if (r.scheduler !== "fixed") continue;
    const key = `${r.size}|${r.family}|${r.seed}`;
    const cell = byCell.get(key) ?? {};
    if (r.policy === x) cell.x = r;
    if (r.policy === y) cell.y = r;
    byCell.set(key, cell);
  }
  let xWin = 0, ties = 0, n = 0;
  for (const cell of byCell.values()) {
    if (!cell.x || !cell.y) continue;
    n++;
    const vx = metric(cell.x), vy = metric(cell.y);
    if (vx < vy) xWin++;
    else if (vx === vy) ties++;
  }
  const N = n - ties;
  const k = Math.min(xWin, N - xWin);
  let p = 0;
  for (let i = 0; i <= k; i++) p += binom(N, i) * Math.pow(0.5, N);
  return { xWin, ties, n, p: N ? Math.min(1, 2 * p) : 1 };
}

// ─── E6b: bounded-hier window exposure ────────────────────────────────────

export interface ExposureResult {
  dueTotal: number; dueExposed: number;
  fpTotal: number; fpExposed: number;
}

export function boundedHierExposure(
  episodes: readonly Episode[], hierPages = 64, obligationWindow = 6,
): ExposureResult {
  const window: number[] = [];
  const pending: { gate: number; openedAt: number }[] = [];
  let dueTotal = 0, dueExposed = 0, fpTotal = 0, fpExposed = 0;
  for (const ep of episodes) {
    for (const f of ep.facts) {
      const g = Number(/gate-(\d+)/.exec(f.id)![1]);
      window.push(g);
      if (f.obligation && !pending.some(p => p.gate === g)) pending.push({ gate: g, openedAt: ep.index });
    }
    while (window.length > hierPages) window.shift();
    const inWin = new Set(window);
    const fresh = new Set(ep.facts.map(f => Number(/gate-(\d+)/.exec(f.id)![1])));
    const due = pending.filter(p => ep.index - p.openedAt >= obligationWindow);
    for (const p of due) {
      dueTotal++;
      if (!inWin.has(p.gate) && !fresh.has(p.gate)) dueExposed++;
    }
    for (const g of ep.footprint) {
      fpTotal++;
      if (!inWin.has(g) && !fresh.has(g)) fpExposed++;
    }
    for (const p of due) pending.splice(pending.indexOf(p), 1);
  }
  return { dueTotal, dueExposed, fpTotal, fpExposed };
}

// ─── E3: real-trace replay ────────────────────────────────────────────────

export interface TraceReplayResult {
  commits: number;
  registrySize: number;
  /** E3a */
  trainDensity: number;
  flatBytes: number;
  hactBytes: number;
  ruleRegret: 0 | 1;
  /** E3b */
  opsCut: number;
  opsCutRange: [number, number];
  regimeOCut: number;
  acceptance: string;
}

function traceFromGit(repo: string): { changes: number[][]; registrySize: number } {
  const raw = execSync(
    `git log --reverse --no-merges --name-only --pretty=format:%H ${repo}`,
    { cwd: repo, maxBuffer: 64 * 1024 * 1024 },
  ).toString();
  const commits: { hash: string; files: string[] }[] = [];
  let cur: { hash: string; files: string[] } | null = null;
  for (const line of raw.split("\n")) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      if (cur) commits.push(cur);
      cur = { hash: line, files: [] };
    } else if (line.trim()) cur?.files.push(line.trim());
  }
  if (cur) commits.push(cur);
  const registry = new Set<string>();
  for (const c of commits) for (const f of c.files) registry.add(f);
  const sorted = [...registry].sort();
  const index = new Map(sorted.map((f, i) => [f, i]));
  const changes = commits.map(c => [...new Set(c.files.filter(f => index.has(f)).map(f => index.get(f)!))]);
  return { changes, registrySize: sorted.length };
}

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** E3b: real invalidation sets with the frozen synthetic obligation overlay. */
function traceEpisodes(changes: number[][], registrySize: number, seed: number): Episode[] {
  const rng = mulberry32(seed ^ 0x5ace9);
  const payloadRng = mulberry32(seed ^ 0x9e3779b9);
  const payloads = new Map<number, number>();
  const spare: number[] = [];
  function normal(r: () => number): number {
    if (spare.length) return spare.pop()!;
    let u = 0, v = 0, s = 0;
    do { u = r() * 2 - 1; v = r() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare.push(v * m);
    return u * m;
  }
  const pending: { gate: number; openedAt: number }[] = [];
  const out: Episode[] = [];
  for (let e = 0; e < changes.length; e++) {
    const invalidated = changes[e]!;
    if (e > 0 && invalidated.length > 0 && pending.length < 2 && rng() < 0.35) {
      const g = invalidated[Math.floor(rng() * invalidated.length)]!;
      if (!pending.some(p => p.gate === g)) pending.push({ gate: g, openedAt: e });
    }
    const openedNow = pending.filter(p => p.openedAt === e).map(p => p.gate);
    for (const g of invalidated) if (!payloads.has(g))
      payloads.set(g, Math.max(32, Math.round(Math.exp(Math.log(128) + 0.8 * normal(payloadRng)))));
    const facts = invalidated.map(g => ({
      id: `gate-${g}`, verified: true,
      bytes: 32 + (payloads.get(g) ?? 128),
      dependsOn: [(g + 1) % registrySize],
      obligation: openedNow.includes(g),
    }));
    const requiredReads = new Set<number>(invalidated);
    for (const g of invalidated) requiredReads.add((g + 1) % registrySize);
    const anchor = invalidated.length ? invalidated[Math.floor(rng() * invalidated.length)]! : 0;
    const footprint: number[] = [];
    for (let d = 0; d < 12; d++) footprint.push((anchor + d) % registrySize);
    for (const g of footprint) requiredReads.add(g);
    const due = pending.filter(p => e - p.openedAt >= 6);
    for (const p of due) requiredReads.add(p.gate);
    out.push({
      index: e, invalidated, facts,
      requiredReads: [...requiredReads],
      needsObligation: due.length > 0, footprint,
    });
    for (const p of due) pending.splice(pending.indexOf(p), 1);
  }
  return out;
}

export function traceReplay(repo: string, seeds: number[]): TraceReplayResult {
  const { changes, registrySize } = traceFromGit(repo);
  const half = Math.floor(changes.length / 2);
  const train = changes.slice(0, half);
  const held = changes.slice(half);
  const flatBytes = flatLedger2(registrySize).runBytes(held);
  const hactBytes = hactLedger2(train, registrySize).runBytes(held);
  const trainDensity = train.reduce((s, ch) => s + ch.length, 0) / (train.length * registrySize);
  const picksTree = trainDensity >= 0.5;
  const oracleTree = hactBytes < flatBytes;
  const ruleRegret: 0 | 1 = picksTree === oracleTree ? 0 : 1;

  const opsCuts: number[] = [];
  const oCuts: number[] = [];
  let opsM = 0, opsF = 0, oM = 0, oF = 0;
  let acceptedAll = true;
  for (const seed of seeds) {
    const eps = traceEpisodes(changes, registrySize, seed);
    const m = runPolicy2({ name: "masking", adaptive: false }, eps, seed);
    const f = runPolicy2({ name: "frontier", adaptive: false }, eps, seed);
    if (!m.accepted || !f.accepted) acceptedAll = false;
    opsCuts.push(1 - f.retrievalOps / m.retrievalOps);
    oCuts.push(1 - f.costO / m.costO);
    opsM += m.retrievalOps; opsF += f.retrievalOps;
    oM += m.costO; oF += f.costO;
  }
  return {
    commits: changes.length,
    registrySize,
    trainDensity,
    flatBytes, hactBytes, ruleRegret,
    opsCut: 1 - opsF / opsM,
    opsCutRange: [Math.min(...opsCuts), Math.max(...opsCuts)],
    regimeOCut: 1 - oF / oM,
    acceptance: acceptedAll ? `${seeds.length}/${seeds.length} seeds, both arms` : "some runs rejected",
  };
}

// ─── E6d: bounded-hier at the long horizon ────────────────────────────────

export function boundedHierLongHorizon(families: readonly string[], seeds: readonly number[]) {
  const out: Record<string, { accepted: number; B: number; ops: number; costO: number }> = {};
  for (const family of families) {
    let B = 0, ops = 0, O = 0, acc = 0;
    for (const seed of seeds) {
      const eps = buildPersistenceStream({ size: 1024, family: family as "clustered", seed, episodes: 160 });
      const r = runPolicy2({ name: "bounded-hier", adaptive: false }, eps, seed);
      if (r.accepted) {
        acc++;
        B += r.contextBytes + r.retrievalBytes;
        ops += r.retrievalOps;
        O += r.costO;
      }
    }
    out[family] = { accepted: acc, B: acc ? B / acc : 0, ops: acc ? ops / acc : 0, costO: acc ? O / acc : 0 };
  }
  return out;
}

// Convenience: run all E-analyses on a loaded cohort.
export function runExploratory(cohort: CohortResult2, repo: string) {
  const runs = cohort.runs;
  const pooled = stratumMeans(runs);
  const e1 = {
    pooledRatioAt4096: costRatio(pooled, 4096),
    breakEven20: breakEven(pooled, 0.8),
    breakEven15: breakEven(pooled, 0.85),
    breakEven25: breakEven(pooled, 0.75),
  };
  const e2 = {
    signO: signTest(runs, "frontier", "masking", r => r.costO),
    signB: signTest(runs, "frontier", "masking", r => r.contextBytes + r.retrievalBytes),
  };
  const e6 = {
    signO_bh: signTest(runs, "frontier", "bounded-hier", r => r.costO),
    signB_bh: signTest(runs, "frontier", "bounded-hier", r => r.contextBytes + r.retrievalBytes),
    breakEven_bh: pairwiseBreakEven(runs, "frontier", "bounded-hier"),
    breakEven_bh_independent: pairwiseBreakEven(runs, "frontier", "bounded-hier", "independent"),
    breakEven_bh_global: pairwiseBreakEven(runs, "frontier", "bounded-hier", "global"),
  };
  return { e1, e2, e6 };
}
