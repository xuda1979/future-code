import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { schedulerIndexStats } from "../../src/harness/foundry/schedulerIndex.ts";
import type { Contract, Json, Lease, Recipe, Task } from "../../src/harness/foundry/types.ts";

const contract: Contract = {
  schema: 1, name: "scheduler-index", workerId: "w", verifierId: "v", environmentId: "e",
  requiredChecks: ["behavior"], slos: [],
  limits: { parallelism: 16, attempts: 2, contextBytes: 32768, outputBytes: 32768, timeoutMs: 10000, tasks: 5000 },
};
const recipe: Recipe = { parallelism: 8, attempts: 1, contextBytes: 8192, timeoutMs: 5000, scheduling: "critical-path" };
const task = (id: string, dependencies: string[] = []): Task => ({
  id, goal: id, acceptance: ["verified"], dependencies, writeScope: [`out/${id}`], readScope: [], input: null,
  estimatedDurationMs: 1,
});
const zero = { tokens: 0, costUsd: 0 };

function accept(q: Scheduler, lease: Lease, artifact: Json = { ok: true }) {
  const spec: Task = JSON.parse(q.store.db.prepare(
    "SELECT spec FROM tasks WHERE run=? AND id=?"
  ).get(lease.runId, lease.taskId)!.spec);
  return q.finish(lease, artifact, {
    contractHash: lease.contractHash, recipeHash: lease.recipeHash,
    verifierId: contract.verifierId, taskHash: digest(spec), artifactHash: digest(artifact),
    metrics: { ...zero, durationMs: 1 },
    verification: { artifactHash: digest(artifact), checks: [{ id: "behavior", verdict: "PASS" }] },
  }, zero);
}

async function fixture(fn: (store: Store) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), "scheduler-index-"));
  const store = await Store.open(root);
  try { store.initialize(contract, recipe); await fn(store); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

test("large ready sets claim from the durable index and rebuild after index loss", async () => fixture(store => {
  const tasks = Array.from({ length: 1500 }, (_, i) => task(`t-${String(i).padStart(4, "0")}`));
  const q = new Scheduler(store); const run = q.start(tasks);
  const first = q.claimMany(run, "w1", 8);
  assert.equal(first.length, 8);
  let stats = schedulerIndexStats(store, run)!;
  assert.equal(stats.indexedTasks, 1500);
  assert.equal(stats.runnable, 1492);
  assert.equal(stats.dependencyBlocked, 0);

  assert.equal(accept(q, first[0]), true);
  store.transaction(() => {
    store.db.prepare("DELETE FROM scheduler_edges WHERE run=?").run(run);
    store.db.prepare("DELETE FROM scheduler_nodes WHERE run=?").run(run);
    store.db.prepare("DELETE FROM scheduler_index_meta WHERE run=?").run(run);
  });
  const next = q.claimMany(run, "w2", 1);
  assert.equal(next.length, 1);
  stats = schedulerIndexStats(store, run)!;
  assert.equal(stats.indexedTasks, 1500);
  assert.ok(stats.rebuilds >= 1);
}));

test("stale scheduler fingerprint is rebuilt before another claim", async () => fixture(store => {
  const q = new Scheduler(store); const run = q.start([task("a"), task("b")]);
  const before = schedulerIndexStats(store, run)!;
  store.db.prepare("UPDATE scheduler_index_meta SET source_version=source_version-1,source_hash=? WHERE run=?")
    .run("0".repeat(64), run);
  const lease = q.claim(run, "worker")!;
  assert.ok(lease);
  const after = schedulerIndexStats(store, run)!;
  assert.ok(after.rebuilds > before.rebuilds);
  assert.notEqual(after.sourceHash, "0".repeat(64));
  const drift = store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE run=? AND kind='scheduler.index.drift'").get(run)!.n;
  assert.equal(drift, 1);
}));

test("acceptance releases only indexed dependents and terminal failure blocks descendants", async () => fixture(store => {
  const q = new Scheduler(store);
  const run = q.start([task("a"), task("b", ["a"]), task("c", ["b"]), task("side")]);
  const leases = q.claimMany(run, "w", 8);
  assert.deepEqual(leases.map(x => x.taskId).sort(), ["a", "side"]);
  const a = leases.find(x => x.taskId === "a")!;
  assert.equal(accept(q, a), true);
  const b = q.claim(run, "w")!; assert.equal(b.taskId, "b");
  q.fail(b, "terminal", zero, Date.now(), { retryable: false });
  q.claim(run, "finalize");
  assert.equal(store.db.prepare("SELECT status FROM tasks WHERE run=? AND id='c'").get(run)!.status, "BLOCKED");
}));

test("corrupt low remaining count cannot bypass authoritative dependencies", async () => fixture(store => {
  const q = new Scheduler(store); const run = q.start([task("a"), task("b", ["a"])]);
  store.db.prepare("UPDATE scheduler_nodes SET remaining=0 WHERE run=? AND task='b'").run(run);
  const leases = q.claimMany(run, "w", 8);
  assert.deepEqual(leases.map(x => x.taskId), ["a"]);
  assert.equal(store.db.prepare("SELECT status FROM tasks WHERE run=? AND id='b'").get(run)!.status, "READY");
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE run=? AND kind='scheduler.index.unsafe_candidate'"
  ).get(run)!.n, 1);
}));

test("corrupt high remaining count self-heals starvation without granting unsafe work", async () => fixture(store => {
  const q = new Scheduler(store); const run = q.start([task("root")]);
  store.db.prepare("UPDATE scheduler_nodes SET remaining=1 WHERE run=? AND task='root'").run(run);
  assert.equal(q.claim(run, "first"), null);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE run=? AND kind='scheduler.index.starvation'"
  ).get(run)!.n, 1);
  assert.equal(q.claim(run, "second")!.taskId, "root");
}));

test("health-grade index stats distinguish runnable dependency-blocked and delayed work", async () => fixture(store => {
  const q = new Scheduler(store); const run = q.start([task("a"), task("b", ["a"]), task("c")]);
  const lease = q.claim(run, "w")!;
  assert.equal(lease.taskId, "a");
  const stats = schedulerIndexStats(store, run)!;
  assert.equal(stats.dependencyBlocked, 1);
  assert.equal(stats.runnable, 1);
}));
