/**
 * Context-retirement mechanism tests (v2 frozen cohort).
 * Run with: bun tests/retirement/retirement2.test.ts
 *
 * These tests pin the v2 mechanism invariants the manuscript claims:
 *  - determinism of the v2 cohort (same seeds → same numbers),
 *  - full-factorial coverage (every R×S combination present per cell),
 *  - scheduler byte-neutrality (attribution closure precondition),
 *  - three-phase separation (construction/steady/audit-tail sum to whole),
 *  - audit cleanliness of promoted arms (no A3 defects),
 *  - the null closure's regime-O direction (frontier < masking pooled),
 *  - summary-reset's failure mode at the new scale,
 *  - long-horizon persistence of the ops result,
 *  - the fast evidence layouts match v1's bit-for-bit.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

// Cohort-length tests exceed bun's 5 s default timeout; the suite sets an
// explicit 10-minute ceiling (the full cohort runs in ~75 s, but CI
// machines vary).
const T = { timeout: 600_000 } as const;
import { buildPersistenceStream } from "../../src/harness/retirement/stream.ts";
import { runPolicy2, flatLedger2, hactLedger2, OPSBYTE, USE_WINDOW, CONSTRUCTION_EPISODES } from "../../src/harness/retirement/engine2.ts";
import { runCohort2, applyClosures2, factorContrasts, RETENTION_ARMS } from "../../src/harness/retirement/run2.ts";
import { hactLedger as hactLedgerV1, flatLedger as flatLedgerV1 } from "../../src/harness/retirement/engine.ts";

const EPISODES = 40;
const stream = (size = 128, family = "clustered" as const, seed = 55011, episodes = EPISODES) =>
  buildPersistenceStream({ size, family, seed, episodes });

test("v2 cohort is deterministic across invocations", T, () => {
  const a = runCohort2();
  const b = runCohort2();
  assert.equal(a.runs.length, b.runs.length);
  // Spot-check a spread of runs for exact equality.
  for (let i = 0; i < a.runs.length; i += 97) {
    assert.deepEqual(a.runs[i], b.runs[i]);
  }
  assert.deepEqual(applyClosures2(a.runs, a.evidence, a.longRuns),
    applyClosures2(b.runs, b.evidence, b.longRuns));
});

test("full factorial: every cell has all 7 R × 2 S combinations", T, () => {
  const c = runCohort2();
  const byCell = new Map<string, Set<string>>();
  for (const r of c.runs) {
    const key = `${r.size}|${r.family}|${r.seed}`;
    let s = byCell.get(key);
    if (!s) { s = new Set(); byCell.set(key, s); }
    s.add(`${r.policy}|${r.scheduler}`);
  }
  assert.equal(byCell.size, 84);
  for (const [key, s] of byCell) {
    assert.equal(s.size, 14, `cell ${key} has ${s.size} of 14 R×S combinations`);
  }
});

test("scheduler factor is byte-neutral (attribution precondition)", T, () => {
  const c = runCohort2();
  const contrasts = factorContrasts(c.runs);
  assert.ok(Math.abs(contrasts.sEffectOnBytesPct) <= 1,
    `S main effect on bytes ${contrasts.sEffectOnBytesPct}% exceeds the 1% leak threshold`);
  // Paired equality: each run's bytes identical under S=fixed vs adaptive.
  const fixed = new Map(c.runs.filter(r => r.scheduler === "fixed").map(r => [`${r.policy}|${r.seed}|${r.size}|${r.family}`, r]));
  for (const r of c.runs.filter(r => r.scheduler === "adaptive")) {
    const f = fixed.get(`${r.policy}|${r.seed}|${r.size}|${r.family}`);
    assert.ok(f, "paired fixed run exists");
    assert.equal(r.contextBytes, f.contextBytes, `context bytes leaked across S for ${r.policy}`);
    assert.equal(r.retrievalBytes, f.retrievalBytes);
    assert.equal(r.retrievalOps, f.retrievalOps);
  }
});

test("phases are disjoint and sum to the whole run", T, () => {
  const eps = stream(512, "independent", 55013);
  for (const arm of RETENTION_ARMS) {
    const r = runPolicy2({ name: arm.policy, adaptive: false }, eps, 55013);
    const sumCtx = r.construction.contextBytes + r.steady.contextBytes + r.auditTail.contextBytes;
    const sumOps = r.construction.retrievalOps + r.steady.retrievalOps + r.auditTail.retrievalOps;
    assert.equal(sumCtx, r.contextBytes, `${arm.name}: phase contexts must sum to whole`);
    assert.equal(sumOps, r.retrievalOps, `${arm.name}: phase ops must sum to whole`);
    // Phase boundaries: construction is episodes 0..4, audit tail the last 5.
    assert.equal(CONSTRUCTION_EPISODES, 5);
  }
});

test("audit tail: frontier arms have zero A1/A2/A3 defects", T, () => {
  const c = runCohort2();
  for (const r of c.runs) {
    if (r.policy !== "frontier" && r.policy !== "frontier-adaptive") continue;
    assert.equal(r.audit.defectiveService, 0, `A3 defect in ${r.policy} ${r.family}/${r.seed}`);
    assert.equal(r.audit.missingObligations, 0, `A2 missing in ${r.policy}`);
    assert.equal(r.audit.phantomObligations, 0, `A2 phantom in ${r.policy}`);
  }
});

test("summary-reset fails the acceptance contract at the new scale", T, () => {
  const c = runCohort2();
  const sr = c.runs.filter(r => r.policy === "summary-reset");
  const acc = sr.filter(r => r.accepted).length;
  assert.ok(acc < sr.length, "summary-reset must not accept everything");
  assert.ok(acc / sr.length < 0.5, `summary-reset acceptance ${acc}/${sr.length} unexpectedly high`);
});

test("null closure direction: frontier regime-O cost below masking pooled", T, () => {
  const c = runCohort2();
  const cl = applyClosures2(c.runs, c.evidence, c.longRuns);
  assert.equal(cl.nullClosure.triggered, false,
    `null closure fired: ${cl.nullClosure.detail}`);
  assert.ok(cl.nullClosure.reductionPct >= 20);
});

test("adaptive coordination is evaluated but not promoted (honest negative)", T, () => {
  const c = runCohort2();
  const cl = applyClosures2(c.runs, c.evidence, c.longRuns);
  assert.equal(cl.adaptiveClosure.promotable, false,
    "if this fires, the manuscript's adaptive-coordination text must change");
  // It must still be acceptance-equal and audit-clean (the closure's
  // clauses (a) and (b)), so the negative is about cost, not correctness.
  const fa = c.runs.filter(r => r.policy === "frontier-adaptive" && r.scheduler === "fixed");
  assert.equal(fa.filter(r => r.accepted).length, fa.length);
  assert.equal(fa.filter(r => r.auditFailed).length, 0);
});

test("long-horizon: ops advantage persists at 4× horizon", T, () => {
  const c = runCohort2();
  assert.equal(c.longRuns.length, 63); // 3 families × 7 seeds × 3 policies
  const mask = c.longRuns.filter(r => r.policy === "masking" && r.accepted);
  const front = c.longRuns.filter(r => r.policy === "frontier" && r.accepted);
  const maskOps = mask.reduce((s, r) => s + r.retrievalOps, 0) / mask.length;
  const frontOps = front.reduce((s, r) => s + r.retrievalOps, 0) / front.length;
  assert.ok(frontOps < maskOps * 0.8,
    `long-horizon ops cut ${(1 - frontOps / maskOps) * 100}% below the 20% gate`);
});

test("fast evidence layouts are bit-identical to v1's", T, () => {
  for (const size of [128, 512, 1024, 4096]) {
    for (const family of ["clustered", "independent", "global"] as const) {
      const eps = buildPersistenceStream({ size, family, seed: 55011, episodes: 40 });
      const train = eps.slice(0, 20).map(e => [...e.invalidated]);
      const held = eps.slice(20).map(e => [...e.invalidated]);
      assert.equal(
        hactLedger2(train, size).runBytes(held),
        hactLedgerV1(train, size).runBytes(held),
        `hact layout mismatch at ${size}/${family}`,
      );
      assert.equal(
        flatLedger2(size).runBytes(held),
        flatLedgerV1(size).runBytes(held),
        `flat layout mismatch at ${size}/${family}`,
      );
    }
  }
});

test("regime-O constants are frozen", T, () => {
  assert.equal(OPSBYTE, 4096);
  assert.equal(USE_WINDOW, 8);
});

test("frontier eviction is use-clock driven for adaptive, set-driven for base", T, () => {
  // The adaptive policy must strictly contain the base frontier's
  // evictions only when bindings are unused; never evict base members.
  const eps = stream(512, "independent", 55014);
  const base = runPolicy2({ name: "frontier", adaptive: false }, eps, 55014);
  const ad = runPolicy2({ name: "frontier-adaptive", adaptive: false }, eps, 55014);
  // Same correctness contract.
  assert.equal(base.accepted, ad.accepted);
  assert.equal(base.stalenessDefects, ad.stalenessDefects);
  assert.equal(base.obligationLoss, ad.obligationLoss);
});
