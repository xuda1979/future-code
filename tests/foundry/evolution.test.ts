import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, digest } from "../../src/harness/foundry/kernel.ts";
import { evaluate, loadEvaluation, promote, rollback, suggest } from "../../src/harness/foundry/evolution.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import type { Driver, Protocol } from "../../src/harness/foundry/types.ts";
import { contract, recipe, task } from "./fixtures.ts";

async function fixture(fn: (s: Store, d: Driver, baseline: string) => Promise<void>): Promise<void> {
  const path = mkdtempSync(join(tmpdir(), "foundry-evaluation-")); const s = await Store.open(path);
  const baseline = s.initialize(contract, { ...recipe, parallelism: 1 });
  // Synthetic host-side meter for admission tests, not a real savings claim.
  const d: Driver = { verifierId: contract.verifierId, workerId: contract.workerId,
    async execute(c) { return { artifact: { answer: 4 }, measurement: { tokens: c.recipeHash === baseline ? 20 : 10, costUsd: c.recipeHash === baseline ? 2 : 1 } }; },
    async verify(_c, r) { return { artifactHash: digest(r.artifact), checks: [{ id: "behavior", verdict: "PASS" }], measurement: { tokens: 0, costUsd: 0 } }; } };
  try { await fn(s, d, baseline); } finally { s.close(); rmSync(path, { recursive: true, force: true }); }
}
const protocol = (): Protocol => ({ datasetId: "fixture-holdout-v1", environmentId: contract.environmentId, tasks: [task()], repetitions: 2, objective: "costUsd", minRelativeGain: 0.2 });
test("matched evaluation is counterbalanced; promotion and rollback are explicit", async () => fixture(async (s, d, baseline) => {
  const candidate = s.propose({ parallelism: 2 }); const e = await evaluate(s, candidate, protocol(), d);
  assert.equal(e.decision, "ADMIT"); assert.equal(e.relativeGain, 0.5); assert.equal(s.active(), baseline);
  assert.deepEqual(s.db.prepare("SELECT recipe FROM runs ORDER BY rowid").all().map(r => r.recipe), [baseline, candidate, candidate, baseline]);
  assert.equal(promote(s, e.id), candidate); assert.equal(promote(s, e.id), candidate);
  rollback(s, baseline); assert.equal(s.active(), baseline);
  assert.throws(() => promote(s, e.id), /consumed/);
}));
test("insufficient gain rejects an otherwise healthy candidate", async () => fixture(async (s, d) => {
  d.execute = async () => ({ artifact: { answer: 4 }, measurement: { tokens: 20, costUsd: 2 } });
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  assert.equal(e.decision, "REJECT"); assert.throws(() => promote(s, e.id));
}));
test("zero observed baseline cost is not a fabricated improvement", async () => fixture(async (s, d) => {
  d.execute = async () => ({ artifact: {}, measurement: { tokens: 0, costUsd: 0 } });
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  assert.equal(e.decision, "UNKNOWN"); assert.throws(() => promote(s, e.id));
}));
test("missing token/cost evidence prevents cost-based promotion", async () => fixture(async (s, d) => {
  d.execute = async () => ({ artifact: {} });
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  assert.equal(e.decision, "UNKNOWN"); assert.throws(() => promote(s, e.id));
}));
test("a candidate with worse quality is rejected despite cheaper reported work", async () => fixture(async (s, d, baseline) => {
  d.verify = async (c, r) => ({ artifactHash: digest(r.artifact), checks: [{ id: "behavior", verdict: c.recipeHash === baseline ? "PASS" : "FAIL" }], measurement: { tokens: 0, costUsd: 0 } });
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  assert.equal(e.decision, "REJECT"); assert.throws(() => promote(s, e.id));
}));
test("stale parent cannot replace a subsequently promoted recipe", async () => fixture(async (s, d) => {
  const a = s.propose({ parallelism: 2 }); const b = s.propose({ parallelism: 3 });
  const ea = await evaluate(s, a, protocol(), d); const eb = await evaluate(s, b, protocol(), d);
  promote(s, ea.id); assert.throws(() => promote(s, eb.id), /stale/);
}));
test("changing a persisted evaluation or underlying run invalidates its receipt", async () => fixture(async (s, d) => {
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  s.db.prepare("UPDATE evaluations SET json=? WHERE id=?").run(JSON.stringify({ ...e, relativeGain: 0.99 }), e.id);
  assert.throws(() => promote(s, e.id), /integrity/);
  s.db.prepare("UPDATE evaluations SET json=?,hash=? WHERE id=?").run(canonical(e), digest(e), e.id);
  s.db.prepare("UPDATE attempts SET cost=0 WHERE run=?").run(e.pairs[0].candidate.id);
  assert.throws(() => promote(s, e.id), /evidence changed/);
}));
test("changing the protocol hash or task set cannot produce an admitted receipt", async () => fixture(async (s, d) => {
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  const altered = { ...e, protocol: { ...e.protocol, minRelativeGain: 0.0001 } };
  s.db.prepare("UPDATE evaluations SET json=?,hash=? WHERE id=?").run(canonical(altered), digest(altered), e.id);
  assert.throws(() => promote(s, e.id), /drift/);
  s.db.prepare("UPDATE evaluations SET json=?,hash=? WHERE id=?").run(canonical(e), digest(e), e.id);
  s.db.prepare("UPDATE tasks SET spec=? WHERE run=? AND id='a'").run(canonical({ ...task(), goal: "different problem" }), e.pairs[0].candidate.id);
  assert.throws(() => promote(s, e.id), /task set/);
}));
test("missing accepted artifacts invalidate promotion", async () => fixture(async (s, d) => {
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  const row = s.db.prepare("SELECT artifact FROM tasks WHERE run=?").get(e.pairs[0].candidate.id)!;
  unlinkSync(join(s.root, "artifacts", `${row.artifact}.json`));
  assert.throws(() => promote(s, e.id));
}));
test("bad environment and partial evaluations never promote", async () => fixture(async (s, d) => {
  const candidate = s.propose({ parallelism: 2 });
  await assert.rejects(evaluate(s, candidate, { ...protocol(), environmentId: "other" }, d), /environment/);
  const abort = new AbortController(); abort.abort();
  const e = await evaluate(s, candidate, protocol(), d, abort.signal);
  assert.equal(e.decision, "UNKNOWN"); assert.throws(() => promote(s, e.id));
}));
test("rollback refuses an unadmitted candidate", async () => fixture(async s => {
  const hash = s.propose({ parallelism: 2 }); assert.throws(() => rollback(s, hash), /unadmitted/);
}));
test("suggest proposes from recorded independent work without auto-applying", async () => fixture(async (s, d, baseline) => {
  assert.equal(suggest(s), null);
  for (let i = 0; i < 3; i++) await runTasks(s, [task(), task("b")], d);
  const candidate = suggest(s); assert.ok(candidate); assert.equal(s.recipe(candidate).parallelism, 2); assert.equal(s.active(), baseline);
}));

test("missing verification evidence prevents promotion even when code artifacts exist", async () => fixture(async (s, d) => {
  const e = await evaluate(s, s.propose({parallelism:2}), protocol(), d);
  const row = s.db.prepare("SELECT evidence FROM tasks WHERE run=?").get(e.pairs[0].candidate.id)!;
  unlinkSync(join(s.root,"artifacts",`${row.evidence}.json`));
  assert.throws(() => promote(s,e.id));
}));
