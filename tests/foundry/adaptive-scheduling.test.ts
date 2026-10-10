import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { learnedDurationHints, shouldRerankAfter } from "../../src/harness/foundry/adaptiveScheduling.ts";
import type { Contract, Recipe, Task, Lease } from "../../src/harness/foundry/types.ts";

const contract: Contract = {
  schema: 1, name: "adaptive-fixture", workerId: "w", verifierId: "v", environmentId: "fixture",
  requiredChecks: ["correct"], slos: [],
  limits: { parallelism: 8, attempts: 2, contextBytes: 16384, outputBytes: 16384, timeoutMs: 100000, tasks: 100 },
};
const recipe: Recipe = { parallelism: 1, attempts: 1, contextBytes: 4096, timeoutMs: 50000,
  scheduling: "adaptive-critical-path" };
const task = (id: string, goal = id, dependencies: string[] = []): Task => ({
  id, goal, dependencies, acceptance: ["verified"], writeScope: ["src/" + id], input: null,
});
async function fixture(fn: (s: Store) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "foundry-adaptive-"));
  const s = await Store.open(root);
  try { s.initialize(contract, recipe); await fn(s); }
  finally { s.close(); rmSync(root, { recursive: true, force: true }); }
}
function accept(q: Scheduler, lease: Lease, at: number) {
  const artifact = { ok: true };
  const t = JSON.parse(q.store.db.prepare("SELECT spec FROM tasks WHERE run=? AND id=?").get(lease.runId, lease.taskId)!.spec);
  return q.finish(lease, artifact, {
    contractHash: lease.contractHash, recipeHash: lease.recipeHash, verifierId: "v",
    taskHash: digest(t), artifactHash: digest(artifact),
    metrics: { tokens: 0, costUsd: 0, durationMs: 1 },
    verification: { artifactHash: digest(artifact), checks: [{ id: "correct", verdict: "PASS" }] },
  }, { tokens: 0, costUsd: 0 }, at);
}

test("small DAGs and non-opt-in recipes have no learned duration work", async () => fixture(s => {
  const small = [task("a", "compile"), task("b", "test")];
  const result = learnedDurationHints(s, small, recipe);
  assert.equal(result.matchedTasks, 0);
  assert.deepEqual(result.tasks, small);
  assert.equal(learnedDurationHints(s, Array.from({ length: 8 }, (_, i) => task("t" + i)),
    { ...recipe, scheduling: "priority" }).usedObservations, 0);
}));

test("duration priors require three verified same-contract samples, preserve explicit estimates", async () => fixture(s => {
  const now = Date.now(), q = new Scheduler(s);
  for (let i = 0; i < 3; i++) {
    const old = q.start([task("history", "shared goal")], undefined, now - 10000 * (i + 1));
    const lease = q.claim(old, "w", now - 10000 * (i + 1) + 1)!;
    assert.equal(accept(q, lease, now - 10000 * (i + 1) + [1000, 5000, 2000][i]), true);
  }
  const tasks = [task("a", "shared goal"), task("b", "unseen"), ...Array.from({ length: 6 }, (_, i) => task("x" + i))];
  const hints = learnedDurationHints(s, tasks, recipe, now);
  assert.equal(hints.matchedTasks, 1);
  assert.equal(hints.usedObservations, 3);
  assert.equal(hints.tasks[0].estimatedDurationMs, 1999);
  assert.equal(hints.tasks[1].estimatedDurationMs, undefined);
  assert.equal(learnedDurationHints(s, [task("a", "shared goal", []), ...tasks.slice(1).map((t, i) =>
    i === 0 ? { ...t, estimatedDurationMs: 7 } : t)], recipe, now).tasks[1].estimatedDurationMs, 7);
}));

test("adaptive historical durations affect real scheduler claim ordering on wide long DAG", async () => fixture(s => {
  const q = new Scheduler(s), now = Date.now();
  for (let i = 0; i < 3; i++) {
    const id = q.start([task("h", "slow branch")], undefined, now - 10000 * (i + 1));
    const lease = q.claim(id, "w", now - 10000 * (i + 1) + 10)!;
    accept(q, lease, now - 10000 * (i + 1) + 4010);
  }
  const tasks = [task("a", "short branch"), task("z", "slow branch"),
    ...Array.from({ length: 6 }, (_, i) => task("f" + i))];
  const run = q.start(tasks, undefined, now);
  assert.equal(q.claim(run, "w", now + 1)?.taskId, "z");
  const index = s.db.prepare("SELECT rank FROM scheduler_nodes WHERE run=? AND task='z'").get(run);
  assert.ok(index.rank >= 4000);
}));

test("rebuild milestones are bounded and exclude short completions", () => {
  assert.deepEqual(Array.from({ length: 52 }, (_, i) => i).filter(shouldRerankAfter), [3, 6, 12, 24, 48]);
  assert.equal(shouldRerankAfter(-1), false);
  assert.equal(shouldRerankAfter(3.5), false);
});
