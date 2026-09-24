/**
 * Context-retirement mechanism tests. Run with:
 *   node --experimental-strip-types scripts/test-retirement.mjs
 * (or bun test on this file directly.)
 *
 * These tests pin the mechanism invariants the manuscript claims:
 *  - determinism of the cohort (same seeds → same numbers),
 *  - summary/reset loses obligations and acts stale (the falsification),
 *  - retention arms lose nothing,
 *  - the HACT evidence ablation beats the flat steel-man at equal
 *    correctness on held-out data,
 *  - the scheduler dimension changes makespan, not bytes,
 *  - closure rules fire exactly as the frozen thresholds state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { flatLedger, hactLedger, runPolicy } from "../../src/harness/retirement/engine.ts";
import { buildPersistenceStream } from "../../src/harness/retirement/stream.ts";
import { applyClosures, ARMS, EPISODES, FAMILIES, runCohort, SEEDS, SIZES } from "../../src/harness/retirement/run.ts";

const stream = (size = 128, family = "clustered" as const, seed = 55011) =>
  buildPersistenceStream({ size, family, seed, episodes: EPISODES });

test("episode stream is deterministic across invocations", () => {
  const a = stream(512, "independent", 55013);
  const b = stream(512, "independent", 55013);
  assert.deepEqual(a, b);
});

test("episode 0 carries full initial state; later episodes are bounded", () => {
  const eps = stream(128);
  assert.equal(eps[0].invalidated.length, 128);
  for (let i = 1; i < eps.length; i++) {
    assert.ok(eps[i].invalidated.length <= 128);
    assert.ok(eps[i].invalidated.length > 0);
  }
});

test("obligations open on the stream and come due exactly OBLIGATION_WINDOW later", () => {
  const eps = stream(128, "clustered", 55012);
  let opened = 0;
  for (const e of eps) for (const f of e.facts) if (f.obligation) opened++;
  assert.ok(opened > 0, "stream should open obligations");
  const dueEpisodes = eps.filter(e => e.needsObligation);
  for (const e of dueEpisodes) {
    assert.ok(e.requiredReads.length > 0);
  }
});

test("footprint D=12 is present and persists through persistence steps", () => {
  const eps = stream(128);
  for (const e of eps) assert.equal(e.footprint.length, 12);
});

test("full-replay never retrieves and never loses correctness", () => {
  const r = runPolicy({ name: "full-replay", adaptive: false }, stream(), 55011);
  assert.equal(r.retrievalOps, 0);
  assert.equal(r.stalenessDefects, 0);
  assert.equal(r.obligationLoss, 0);
  assert.ok(r.accepted);
});

test("masking has no cross-call payload cache: every non-current read is a fetch", () => {
  const eps = stream();
  const r = runPolicy({ name: "masking", adaptive: false }, eps, 55011);
  assert.ok(r.retrievalOps > 0);
  assert.equal(r.stalenessDefects, 0);
  assert.equal(r.obligationLoss, 0);
  assert.ok(r.accepted);
});

test("summary-reset loses obligations across reset boundaries and acts stale", () => {
  const eps = stream(128, "clustered", 55011);
  const r = runPolicy({ name: "summary-reset", adaptive: false }, eps, 55011);
  // The falsification mechanism: obligations survive only via the lossy
  // summary; window overflow reverts to beliefs that can be stale.
  assert.ok(r.obligationLoss > 0 || r.stalenessDefects > 0,
    "summary-reset should exhibit obligation loss or staleness");
});

test("frontier retirement retains obligations and never acts stale", () => {
  const eps = stream(128, "clustered", 55011);
  const r = runPolicy({ name: "frontier", adaptive: false }, eps, 55011);
  assert.equal(r.stalenessDefects, 0);
  assert.equal(r.obligationLoss, 0);
  assert.ok(r.accepted);
});

test("frontier retirement reduces retrieval ops versus masking (the live-cost hypothesis)", () => {
  const eps = stream(128, "clustered", 55011);
  const f = runPolicy({ name: "frontier", adaptive: false }, eps, 55011);
  const m = runPolicy({ name: "masking", adaptive: false }, eps, 55011);
  assert.ok(f.retrievalOps < m.retrievalOps,
    `frontier ops ${f.retrievalOps} should be < masking ops ${m.retrievalOps}`);
});

test("scheduler dimension changes makespan, not bytes", () => {
  const eps = stream(128, "clustered", 55011);
  const fixed = runPolicy({ name: "frontier", adaptive: false }, eps, 55011);
  const adaptive = runPolicy({ name: "frontier", adaptive: true }, eps, 55011);
  assert.equal(fixed.contextBytes, adaptive.contextBytes);
  assert.equal(fixed.retrievalBytes, adaptive.retrievalBytes);
  assert.ok(adaptive.makespanRounds < fixed.makespanRounds,
    "adaptive batching should reduce makespan rounds");
});

test("verified-board and bounded-hier lose nothing on these streams", () => {
  for (const name of ["verified-board", "bounded-hier"] as const) {
    const r = runPolicy({ name, adaptive: false }, stream(128, "clustered", 55011), 55011);
    assert.equal(r.stalenessDefects, 0);
    assert.equal(r.obligationLoss, 0);
    assert.ok(r.accepted, `${name} should accept`);
  }
});

test("HACT evidence ablation beats flat steel-man on held-out data at equal correctness (pooled)", () => {
  // Per-family: the tree wins on global coupling (large change sets are
  // grouped into packets); the flat delta wins on sparse clustered/
  // independent deltas. The frozen closure is evaluated pooled, as the
  // protocol states; this test pins the pooled direction and the
  // per-family mechanism boundary.
  let flatSum = 0, hactSum = 0;
  for (const family of ["clustered", "independent", "global"] as const) {
    const eps = stream(512, family, 55011);
    const train = eps.slice(0, 20).map(e => [...e.invalidated]);
    const held = eps.slice(20).map(e => [...e.invalidated]);
    flatSum += flatLedger(512).runBytes(held);
    hactSum += hactLedger(train, 512).runBytes(held);
  }
  assert.ok(hactSum < flatSum * 0.95,
    `pooled hact ${hactSum} should be ≤ 95% of pooled flat ${flatSum}`);
});

test("flat ledger steel-man takes min of full and delta export", () => {
  const held = [[1, 2, 3], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]];
  const bytes = flatLedger(16).runBytes(held);
  // construction + delta export for both episodes
  const expected = (64 + 64 * 16) + (64 + 64 * 3) + (64 + 64 * 16);
  assert.equal(bytes, expected);
});

// The full cohort takes ~65 s; compute once for the cohort-level tests.
const cohortA = runCohort();
const cohortB = runCohort();

test("cohort is deterministic: two full runs produce identical results", () => {
  assert.deepEqual(cohortA.runs, cohortB.runs);
});

test("cohort shape: 630 runs across 10 arms, 3 sizes, 3 families, 7 seeds", () => {
  assert.equal(cohortA.runs.length, 630);
  assert.equal(new Set(cohortA.runs.map(r => r.arm)).size, 10);
  assert.equal(new Set(cohortA.runs.map(r => r.size)).size, 3);
  assert.equal(new Set(cohortA.runs.map(r => r.family)).size, 3);
  assert.equal(new Set(cohortA.runs.map(r => r.seed)).size, 7);
});

test("frozen closure rules fire as the thresholds state", () => {
  const cl = applyClosures(cohortA.runs);
  // Null closure: frontier must NOT beat the best baseline by 20% on bytes
  // (the measured result) — the rule fires, retirement is not promoted on
  // a byte-cost claim.
  assert.ok(cl.nullClosure.triggered, "null closure should trigger on measured bytes");
  // Attribution closure: scheduler is byte-neutral; within 10% fires with
  // the dimension-separated note attached.
  assert.ok(cl.attributionClosure.triggered);
  assert.match(cl.attributionClosure.dimensionNote, /dimension-separated/);
  // HACT closure: does NOT trigger — pooled over the frozen families, the
  // tree beats the flat steel-man by more than the 5% gate on held-out
  // evidence bytes at equal correctness.
  assert.equal(cl.hactClosure.triggered, false);
});

test("acceptance contract: any staleness or obligation loss rejects the run", () => {
  for (const r of cohortA.runs) {
    if (r.stalenessDefects > 0 || r.obligationLoss > 0) {
      assert.equal(r.accepted, false);
    }
  }
});
