import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import type { Driver, Recipe, Lease, Json, Measurement } from "../../src/harness/foundry/types.ts";
import { contract, recipe, task } from "./fixtures.ts";

async function fixture(fn: (store: Store, path: string) => Promise<void>, p: Recipe = recipe): Promise<void> {
  const path = mkdtempSync(join(tmpdir(), "foundry-test-")); const store = await Store.open(path);
  try { store.initialize(contract, p); await fn(store, path); } finally { store.close(); rmSync(path, { recursive: true, force: true }); }
}
function driver(): Driver {
  return { verifierId: contract.verifierId, workerId: contract.workerId,
    async execute(c) { return { artifact: { task: c.task.id, answer: 4 }, measurement: { tokens: 10, costUsd: 1 } }; },
    async verify(_c, r) { return { artifactHash: digest(r.artifact), checks: [{ id: "behavior", verdict: "PASS" }], measurement: { tokens: 1, costUsd: 0.2 } }; } };
}
function evidence(q: Scheduler, l: Lease, artifact: Json, m: Measurement): Json {
  const spec = JSON.parse(q.store.db.prepare("SELECT spec FROM tasks WHERE run=? AND id=?").get(l.runId, l.taskId)!.spec);
  return { contractHash: l.contractHash, recipeHash: l.recipeHash, verifierId: contract.verifierId,
    taskHash: digest(spec), artifactHash: digest(artifact), metrics: { ...m, durationMs: 1 },
    verification: { artifactHash: digest(artifact), checks: [{ id: "behavior", verdict: "PASS" }] } } as Json;
}
test("store persists versions and proposal cannot rewrite the frozen contract", async () => fixture(async (s, path) => {
  const before = s.active(); const hash = digest(s.contract());
  const candidate = s.propose({ parallelism: 3 }); assert.notEqual(candidate, before); assert.equal(s.active(), before);
  assert.throws(() => s.propose({ requiredChecks: [] } as any));
  assert.throws(() => s.initialize(contract, recipe));
  assert.equal(digest(s.contract()), hash);
  const second = await Store.open(path);
  try { assert.equal(second.active(), before); assert.equal(second.recipe(candidate).parallelism, 3); } finally { second.close(); }
}));
test("artifact hash detects tampering and path traversal", async () => fixture(async (s, path) => {
  const hash = s.artifact({ x: 1 }); assert.deepEqual(s.readArtifact(hash), { x: 1 });
  writeFileSync(join(path, "artifacts", `${hash}.json`), '{"x":2}');
  assert.throws(() => s.readArtifact(hash), /integrity/);
  assert.throws(() => s.readArtifact("../../secret"));
}));
test("transaction rollback also rolls back its events", async () => fixture(async s => {
  const before = s.events().length;
  assert.throws(() => s.transaction(() => { s.event("should.not.exist", {}); throw new Error("rollback"); }));
  assert.equal(s.events().length, before);
}));
test("independent connections honor write scopes and the global parallelism cap", async () => fixture(async (s, path) => {
  const scheduler = new Scheduler(s); const other = await Store.open(path);
  try {
    const run = scheduler.start([task("a", [], ["src/shared"]), task("b", [], ["src/shared/x"]), task("c", [], ["src/other"])]);
    const a = scheduler.claim(run, "worker-1")!; const c = new Scheduler(other).claim(run, "worker-2")!;
    assert.equal(a.taskId, "a"); assert.equal(c.taskId, "c"); assert.equal(scheduler.claim(run, "worker-3"), null);
    assert.equal(scheduler.finish(a, { x: 1 }, evidence(scheduler, a, { x: 1 }, { tokens: 1, costUsd: 0 }), { tokens: 1, costUsd: 0 }), true);
    assert.equal(scheduler.claim(run, "worker-3")!.taskId, "b");
  } finally { other.close(); }
}));
test("lease expiry retries once; old completions cannot overwrite the new owner", async () => fixture(async s => {
  const q = new Scheduler(s); const start = Date.now(); const run = q.start([task()], s.active(), start);
  const a = q.claim(run, "old", start)!;
  const b = q.claim(run, "new", a.deadline + 1)!;
  assert.equal(b.fence, a.fence + 1);
  assert.equal(q.finish(a, { wrong: true }, {}, { tokens: 0, costUsd: 0 }, a.deadline + 2), false);
  assert.equal(q.finish(b, { correct: true }, evidence(q, b, { correct: true }, { tokens: 1, costUsd: 0 }), { tokens: 1, costUsd: 0 }, a.deadline + 2), true);
  q.claim(run, "poll", a.deadline + 3);
  assert.equal(q.summary(run, a.deadline + 3).status, "PASS");
  // A lost worker has unknown spend, even when its replacement succeeds.
  assert.equal(q.summary(run).costUsd, null);
  assert.equal(q.summary(run).attempts, 2);
}));
test("exhausted parents block descendants rather than falsely accepting them", async () => fixture(async s => {
  const q = new Scheduler(s); const run = q.start([task(), task("b", ["a"]), task("c", ["b"])]);
  q.fail(q.claim(run, "w")!, "broken"); q.fail(q.claim(run, "w")!, "still broken"); q.claim(run, "w");
  const summary = q.summary(run); assert.equal(summary.status, "FAIL"); assert.equal(summary.failed, 1); assert.equal(summary.blocked, 2);
}));
test("runtime passes verified dependency artifacts without conversation accumulation", async () => fixture(async s => {
  const d = driver(); const original = d.execute; let dependencies = 0;
  d.execute = async (c, signal) => { dependencies += c.dependencies.length; return original(c, signal); };
  const r = await runTasks(s, [task(), task("b", ["a"]), task("c")], d);
  assert.equal(r.status, "PASS"); assert.equal(r.accepted, 3); assert.equal(dependencies, 1);
  assert.equal(r.tokens, 33); assert.ok(Math.abs(r.costUsd! - 3.6) < 1e-9);
}));
test("failed verification attempts are included in the total cost", async () => fixture(async s => {
  const d = driver(); let checks = 0;
  d.verify = async (_c, r) => ({ artifactHash: digest(r.artifact), checks: [{ id: "behavior", verdict: ++checks === 1 ? "FAIL" : "PASS" }], measurement: { tokens: 1, costUsd: 0.2 } });
  const r = await runTasks(s, [task()], d);
  assert.equal(r.status, "PASS"); assert.equal(r.attempts, 2); assert.equal(r.tokens, 22); assert.ok(Math.abs(r.costUsd! - 2.4) < 1e-9);
}));
test("unknown spend is not converted to zero", async () => fixture(async s => {
  const d = driver(); d.execute = async () => ({ artifact: { x: 1 } });
  const r = await runTasks(s, [task()], d); assert.equal(r.status, "PASS"); assert.equal(r.tokens, null); assert.equal(r.costUsd, null);
}));
test("verifier identity mismatch never starts a run", async () => fixture(async s => {
  await assert.rejects(runTasks(s, [task()], { ...driver(), verifierId: "wrong" }), /identity/);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 0);
}));
test("empty evidence and an oversized mandatory capsule both fail closed", async () => fixture(async s => {
  const d = driver(); d.verify = async (_c, r) => ({ artifactHash: digest(r.artifact), checks: [] });
  const r = await runTasks(s, [task()], d); assert.equal(r.status, "FAIL");
  const small = s.propose({ contextBytes: 32 }); let calls = 0;
  const next = driver(); next.execute = async () => { calls++; return { artifact: {} }; };
  const overflow = await runTasks(s, [task()], next, { recipeHash: small });
  assert.equal(overflow.status, "FAIL"); assert.equal(calls, 0);
}));
test("non-resolving worker hits a deadline instead of hanging the harness", async () => fixture(async s => {
  const d = driver(); let verifierCalls = 0;
  d.execute = async () => new Promise(() => {});
  d.verify = async () => { verifierCalls++; throw new Error("must not verify timed-out work"); };
  const t = Date.now(); const r = await runTasks(s, [task()], d);
  assert.equal(r.status, "FAIL"); assert.equal(verifierCalls, 0); assert.ok(Date.now() - t < 2000);
}, { ...recipe, timeoutMs: 60, attempts: 1 }));
test("late worker output after cancellation cannot invoke the verifier", async () => fixture(async s => {
  const d = driver(); let verify = 0;
  d.execute = async () => { await new Promise(r => setTimeout(r, 150)); return { artifact: {} }; };
  d.verify = async () => { verify++; throw new Error("late verify"); };
  const r = await runTasks(s, [task()], d); assert.equal(r.status, "FAIL");
  await new Promise(r => setTimeout(r, 200)); assert.equal(verify, 0);
}, { ...recipe, timeoutMs: 50, attempts: 1 }));
test("metadata status and events do not execute a worker", async () => fixture(async s => {
  const d = driver(); let calls = 0; const orig = d.execute;
  d.execute = async (c, signal) => { calls++; return orig(c, signal); };
  const r = await runTasks(s, [task()], d); const before = calls;
  new Scheduler(s).summary(r.id); s.events(); assert.equal(calls, before);
}));

test("the acceptance boundary rejects an empty proof even through the host API", async () => fixture(async s => {
  const q = new Scheduler(s); const run = q.start([task()]); const lease = q.claim(run, "host")!;
  assert.throws(() => q.finish(lease, {}, {}, {tokens:0,costUsd:0}), /evidence/);
  assert.equal(q.summary(run).accepted, 0);
}));
test("resume rejects a different graph or an explicitly mismatched recipe", async () => fixture(async s => {
  const q = new Scheduler(s); const run = q.start([task()]); const candidate = s.propose({parallelism:3});
  await assert.rejects(runTasks(s, [task("different")], driver(), {resumeRun:run}), /graph mismatch/);
  await assert.rejects(runTasks(s, [], driver(), {resumeRun:run,recipeHash:candidate}), /recipe mismatch/);
  const r = await runTasks(s, [], driver(), {resumeRun:run}); assert.equal(r.status,"PASS"); assert.equal(r.id,run);
}));
