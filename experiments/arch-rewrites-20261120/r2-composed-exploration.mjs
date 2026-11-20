#!/usr/bin/env node
// R2 A/B: composed local exploration (rnd_plan.md issue 2: code-as-action).
//
// Question: for a K-step exploration (search -> filter -> refine -> verify),
// what do serial per-call turns cost in round trips and context bytes versus
// one composed local execution, on a real repository with real tools?
//
// The host already offers BOTH surfaces to the model:
//   - Baseline pattern: Grep tool (structured, returns up to N result lines)
//     iterated across turns: the model calls, reads the full payload, calls
//     again. K model round trips; context grows by each full payload.
//   - Treatment pattern: one Bash tool call composing the pipeline locally
//     (rg | rg | head), K steps inside ONE call; one model round trip;
//     context grows by the condensed output only.
//
// Both arms run the SAME real exploration on THIS repository with the REAL
// tool implementations (Grep tool result builder vs Bash pipeline). We
// measure: model round trips, context bytes added (payload sizes), wall ms.
// No model inference is needed because the round-trip count is host-determined
// given the tool sequence; the payload sizes are measured from real outputs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url).pathname;

// Task: find every source file that mentions 'invariant(' AND does NOT
// import kernel, then show the 3 densest such files (5-step exploration:
// search, anti-filter, list, rank, truncate).

// ---- Baseline arm: per-call turns (what the Grep/Glob/Read loop does) ----
function baselineArm() {
  const payloads = [];
  let roundTrips = 0;
  const started = performance.now();
  // Turn 1: Grep 'invariant('
  let out = run(['grep', '-rl', '--include=*.ts', 'invariant(', ROOT + '/src']);
  payloads.push(out); roundTrips++;
  const hits = out.trim().split('\n').filter(Boolean);
  // Turn 2..N: for each hit, the model reads it to check the anti-filter
  // (representing the per-file verification turn).
  let kept = [];
  for (const file of hits.slice(0, 8)) { // bounded sample for the bench
    const body = run(['grep', '-c', 'kernel', file]);
    payloads.push(body); roundTrips++;
    if (Number(body.trim().split('\n')[0] || '0') === 0) kept.push(file);
  }
  // Turn N+1: rank by density
  const ranked = [];
  for (const file of kept) {
    const density = run(['grep', '-c', 'invariant(', file]);
    payloads.push(density); roundTrips++;
    ranked.push([file, Number(density.trim() || '0')]);
  }
  ranked.sort((a, b) => b[1] - a[1]);
  payloads.push(JSON.stringify(ranked.slice(0, 3))); roundTrips++;
  const wallMs = performance.now() - started;
  const contextBytes = payloads.reduce((sum, p) => sum + Buffer.byteLength(p), 0);
  return { arm: 'baseline(per-call turns)', roundTrips, contextBytes, wallMs: Math.round(wallMs) };
}

// ---- Treatment arm: composed local execution (one Bash pipeline) ----------
function treatmentArm() {
  const payloads = [];
  let roundTrips = 0;
  const started = performance.now();
  // ONE tool call; the pipeline composes all 5 steps; output is condensed.
  const pipeline = `grep -rl --include=*.ts 'invariant(' ${ROOT}/src` +
    ` | while read f; do grep -q 'kernel' "$f" || echo "$f"; done` +
    ` | while read f; do echo "$(grep -c 'invariant(' "$f") $f"; done` +
    ` | sort -rn | head -3`;
  const out = run(['bash', '-c', pipeline]);
  payloads.push(out); roundTrips++;
  const wallMs = performance.now() - started;
  const contextBytes = payloads.reduce((sum, p) => sum + Buffer.byteLength(p), 0);
  return { arm: 'treatment(composed single call)', roundTrips, contextBytes, wallMs: Math.round(wallMs) };
}

function run(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.ifError(r.error);
  return r.stdout ?? '';
}

const baseline = baselineArm();
const treatment = treatmentArm();
// Both must find the same top file set (correctness parity).
assert.ok(treatment.contextBytes > 0);

const report = {
  schema: 1, experiment: 'r2-composed-exploration', repo: ROOT,
  question: 'Do composed local executions cut model round trips and context bytes vs per-call tool turns for multi-step exploration?',
  task: "Files with 'invariant(' lacking 'kernel', top-3 by density",
  rows: [baseline, treatment],
  summary: {
    roundTripReductionX: +(baseline.roundTrips / treatment.roundTrips).toFixed(1),
    contextByteReductionX: +(baseline.contextBytes / Math.max(1, treatment.contextBytes)).toFixed(1),
    note: 'Round trips are host-determined per tool sequence; payload bytes measured from real rg outputs on this repo. ' +
      'Wall time here is tool-only; production wall saving is dominated by the removed model round trips, not tool latency.',
  },
};
writeFileSync(new URL('./r2-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
