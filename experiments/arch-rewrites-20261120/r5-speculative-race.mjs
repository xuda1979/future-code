#!/usr/bin/env node
// R5 A/B: speculative orthogonal-hypothesis racing (rnd_plan.md issue 5).
//
// Scenario (root-cause-unknown repair, the plan's long-tail case): a broken
// module is fixed by exactly one of K mutually exclusive hypotheses (H4
// below). Attempting hypothesis Hi costs hi ms of agent work, then a verifier
// decides PASS/FAIL (verify cost v). The plan's racing proposal starts all K
// hypotheses concurrently in isolated worktrees; the first PASS wins
// atomically, losers are terminated. The serial incumbent tries hypotheses in
// a heuristic order until one passes.
//
// Metrics: wall-clock to first PASS; total CPU-ms; wasted work after the
// winner finished. Racing trades CPU for wall-clock; serial trades nothing
// but pays the full latency tail when its heuristic order is wrong.
//
// The serial heuristic order is the experiment variable: winner-first
// (best case for serial) vs winner-last (worst case). Racing is
// order-independent — that invariance IS the proposal's value.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const HYPOTHESES = [
  { id: 'H1: off-by-one in loop bound', workMs: 900, fixes: false },
  { id: 'H2: unit mismatch in conversion', workMs: 850, fixes: false },
  { id: 'H3: race in cache warmup', workMs: 950, fixes: false },
  { id: 'H4: sign error in residual', workMs: 800, fixes: true }, // unique true fix
  { id: 'H5: stale constant table', workMs: 880, fixes: false },
];
const VERIFY_MS = 120;
const FIX_INDEX = 3;

function serial(order) {
  let clock = 0, cpu = 0, attempts = 0;
  for (const i of order) {
    const h = HYPOTHESES[i];
    attempts++;
    clock += h.workMs + VERIFY_MS;
    cpu += h.workMs + VERIFY_MS;
    if (h.fixes) break;
  }
  return { arm: `serial(order=${order.map(i => i + 1).join('>')})`, wallMs: clock, cpuMs: cpu, attempts };
}

function racing(width) {
  // All hypotheses start at t=0 across width parallel worktree lanes; the
  // first PASS (H4 at workMs+v) wins; every other lane is terminated AT the
  // winner's finish (its partial work is the racing overhead).
  const lanes = Math.min(width, HYPOTHESES.length);
  const winnerEnd = HYPOTHESES[FIX_INDEX].workMs + VERIFY_MS;
  let cpu = 0;
  for (const h of HYPOTHESES) cpu += Math.min(h.workMs + VERIFY_MS, winnerEnd);
  return { arm: `racing(width=${lanes})`, wallMs: winnerEnd, cpuMs: cpu, attempts: lanes };
}

const orders = {
  winnerFirst: [FIX_INDEX, ...[0, 1, 2, 4].filter(i => i !== FIX_INDEX)],
  winnerThird: [0, 1, FIX_INDEX, 2, 4],
  winnerLast: [0, 1, 2, 4, FIX_INDEX],
};
const serialArms = Object.fromEntries(Object.entries(orders).map(([k, o]) => [k, serial(o)]));
const race = racing(5);

// Invariants of the proposal:
assert.equal(race.wallMs, HYPOTHESES[FIX_INDEX].workMs + VERIFY_MS, 'race wall is the winner cost, order-invariant');
assert.ok(race.wallMs <= serialArms.winnerFirst.wallMs, 'racing never slower than serial best case');
assert.ok(serialArms.winnerFirst.cpuMs <= race.cpuMs, 'serial wastes no post-win work; racing pays overlap');

const report = {
  schema: 1, experiment: 'r5-speculative-race',
  question: 'Does parallel hypothesis racing compress time-to-first-PASS when the root cause is unknown (heuristic order unreliable)?',
  hypotheses: HYPOTHESES.map(h => ({ id: h.id, workMs: h.workMs, fixes: h.fixes })),
  verifyMs: VERIFY_MS, uniqueFix: HYPOTHESES[FIX_INDEX].id,
  rows: [
    ...Object.entries(serialArms).map(([k, s]) => ({ arm: k, strategy: s.arm, wallMs: s.wallMs, cpuMs: s.cpuMs, attempts: s.attempts })),
    { arm: 'racing', strategy: race.arm, wallMs: race.wallMs, cpuMs: race.cpuMs, attempts: race.attempts },
  ],
  summary: {
    serialBestWallMs: serialArms.winnerFirst.wallMs,
    serialWorstWallMs: serialArms.winnerLast.wallMs,
    racingWallMs: race.wallMs,
    speedupVsWorstX: +(serialArms.winnerLast.wallMs / race.wallMs).toFixed(2),
    speedupVsBestX: +(serialArms.winnerFirst.wallMs / race.wallMs).toFixed(2),
    cpuOverheadVsSerialWorstX: +(race.cpuMs / serialArms.winnerLast.cpuMs).toFixed(2),
  },
};
writeFileSync(new URL('./r5-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
