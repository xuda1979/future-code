import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { accessConflicts } from "../../src/harness/foundry/productivity.ts";
import type { Contract, Json, Lease, Recipe, Task } from "../../src/harness/foundry/types.ts";

// R5 speculative racing (rnd_plan.md issue 5): with recipe.scheduling ===
// "speculative-race", write-scope-conflicting tasks are admitted concurrently
// and the first accepted PASS atomically cancels its still-running peers.

const contract: Contract = {
  schema: 1, name: "speculative-race", workerId: "w", verifierId: "v", environmentId: "e",
  requiredChecks: ["behavior"], slos: [],
  limits: { parallelism: 16, attempts: 2, contextBytes: 32768, outputBytes: 32768, timeoutMs: 10000, tasks: 5000 },
};
const raceRecipe: Recipe = { parallelism: 8, attempts: 1, contextBytes: 8192, timeoutMs: 5000, scheduling: "speculative-race" };
const serialRecipe: Recipe = { parallelism: 8, attempts: 1, contextBytes: 8192, timeoutMs: 5000, scheduling: "critical-path" };
const zero = { tokens: 0, costUsd: 0 };

const hypothesis = (id: string): Task => ({
  id, goal: `Hypothesis ${id}`, acceptance: ["verified"], dependencies: [],
  writeScope: ["src/module.ts"], readScope: [], input: null, estimatedDurationMs: 1,
});
const independent = (id: string): Task => ({
  id, goal: id, acceptance: ["verified"], dependencies: [], writeScope: [`out/${id}`], readScope: [], input: null,
});

async function fixture(fn: (store: Store) => Promise<void> | void, recipe: Recipe = raceRecipe): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "speculative-race-"));
  const store = await Store.open(root);
  try { store.initialize(contract, recipe); await fn(store); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

function accept(q: Scheduler, lease: Lease, artifact: Json = { ok: true }): boolean {
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

test("racing admits conflicting hypotheses concurrently; serial mode still refuses", async () => {
  await fixture(store => {
    const q = new Scheduler(store);
    const run = q.start([hypothesis("h1"), hypothesis("h2"), hypothesis("h3")]);
    const leases = q.claimMany(run, "racer", 8);
    assert.equal(leases.length, 3, "all conflicting hypotheses claim at once under racing");
  });
  await fixture(store => {
    const q = new Scheduler(store);
    const run = q.start([hypothesis("h1"), hypothesis("h2"), hypothesis("h3")]);
    const leases = q.claimMany(run, "racer", 8);
    assert.equal(leases.length, 1, "serial mode still serializes write-scope conflicts");
  }, serialRecipe);
});

test("first PASS atomically cancels conflicting peers; non-conflicting work survives", async () => fixture(async store => {
  const q = new Scheduler(store);
  const run = q.start([hypothesis("h1"), hypothesis("h2"), hypothesis("h3"), independent("other")]);
  const leases = q.claimMany(run, "racer", 8);
  assert.equal(leases.length, 4);
  const winner = leases.find(l => l.taskId === "h2")!;
  const loser = leases.find(l => l.taskId === "h1")!;
  const survivor = leases.find(l => l.taskId === "other")!;

  assert.equal(accept(q, winner), true);
  const row = (id: string) => store.db.prepare("SELECT status,error FROM tasks WHERE run=? AND id=?").get(run, id);
  assert.equal(row("h1").status, "FAIL");
  assert.match(row("h1").error, /speculative race lost/);
  assert.equal(row("h3").status, "FAIL");
  assert.equal(row("h2").status, "PASS");
  assert.equal(row("other").status, "RUNNING", "non-conflicting work is never cancelled");
  const lost = store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE run=? AND kind='race.lost'").get(run)!.n;
  assert.equal(lost, 2);
  // The cancelled loser's lease is dead: a late finish is fenced off as stale.
  assert.equal(accept(q, loser), false);
  assert.equal(row("h1").status, "FAIL");
  void survivor;
}));

test("double-integration prevention: exactly one PASS per conflict group", async () => fixture(async store => {
  const q = new Scheduler(store);
  const run = q.start([hypothesis("h1"), hypothesis("h2")]);
  const [a, b] = q.claimMany(run, "racer", 8);
  assert.equal(accept(q, a), true);
  // Peer b was RUNNING and got cancelled atomically with a's acceptance.
  assert.equal(store.db.prepare("SELECT status FROM tasks WHERE run=? AND id=?").get(run, b.taskId)!.status, "FAIL");
  assert.equal(accept(q, b), false, "a second integration attempt is stale-fenced");
  const passed = store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE run=? AND status='PASS'").get(run)!.n;
  assert.equal(passed, 1);
}));

test("race losers do not block unrelated ready work (no starvation)", async () => fixture(async store => {
  const q = new Scheduler(store);
  const run = q.start([hypothesis("h1"), hypothesis("h2"), independent("later")]);
  const leases = q.claimMany(run, "racer", 2);
  assert.deepEqual(leases.map(l => l.taskId).sort(), ["h1", "h2"]);
  const winner = leases[0]!;
  accept(q, winner);
  // h2 was cancelled by the race outcome; "later" must still be claimable.
  const next = q.claimMany(run, "racer", 4);
  assert.ok(next.some(l => l.taskId === "later"), "unrelated work stays claimable after race resolution");
  assert.ok(!next.some(l => l.taskId === "h2"), "cancelled loser is never re-admitted (attempts=1)");
}));

test("a winner's completion cancels only genuinely conflicting scopes", async () => {
  // Direct semantic check on accessConflicts so the cancellation predicate
  // cannot drift from the admission predicate.
  const winner: Task = { ...hypothesis("win"), writeScope: ["src/a.txt"], readScope: [] };
  const peer: Task = { ...hypothesis("peer"), writeScope: ["src/b.txt"], readScope: [] };
  const writerOverlap: Task = { ...hypothesis("overlap"), writeScope: ["src/a.txt", "src/c.txt"], readScope: [] };
  const writerOverlapDir: Task = { ...hypothesis("overlapDir"), writeScope: ["src"], readScope: [] };
  assert.equal(accessConflicts(winner, peer), false, "disjoint writers with disjoint readers race freely");
  assert.equal(accessConflicts(winner, writerOverlap), true, "overlapping writers conflict");
  assert.equal(accessConflicts(winner, writerOverlapDir), true, "a prefix-directory writer conflicts with a nested file writer");
});
