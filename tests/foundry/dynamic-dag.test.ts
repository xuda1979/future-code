import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { spawnTasks } from "../../src/harness/foundry/dynamicDag.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { validateSwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { integrateSwarm, runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import type { Contract, Driver, Json, Lease, Recipe, SpawnPolicy, Task } from "../../src/harness/foundry/types.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { fixture, reply, signal, spec, task as swarmTask } from "./swarm-fixtures.ts";

const contract: Contract = {
  schema: 1, name: "dynamic-dag", workerId: "worker", verifierId: "verifier", environmentId: "test",
  requiredChecks: ["correct"], slos: [],
  limits: { parallelism: 8, attempts: 3, contextBytes: 32768, outputBytes: 1048576, timeoutMs: 10000, tasks: 100 },
};
const recipe: Recipe = { parallelism: 4, attempts: 2, contextBytes: 8192, timeoutMs: 5000, scheduling: "critical-path" };
const policy: SpawnPolicy = { maxChildrenPerTask: 4, maxDepth: 3, maxSpawnedTasks: 20 };
const coreTask = (id: string, extra: Partial<Task> = {}): Task => ({
  id, goal: `Implement ${id}`, acceptance: ["verified"], dependencies: [],
  writeScope: ["src"], readScope: ["src"], input: null, ...extra,
});
const zero = { tokens: 0, costUsd: 0 };

function accept(q: Scheduler, lease: Lease, artifact: Json = { answer: 4 }) {
  const spec: Task = JSON.parse(q.store.db.prepare(
    "SELECT spec FROM tasks WHERE run=? AND id=?"
  ).get(lease.runId, lease.taskId)!.spec);
  return q.finish(lease, artifact, {
    contractHash: lease.contractHash, recipeHash: lease.recipeHash,
    verifierId: q.store.contract().verifierId,
    taskHash: digest(spec), artifactHash: digest(artifact),
    metrics: { ...zero, durationMs: 1 },
    verification: { artifactHash: digest(artifact),
      checks: [{ id: "correct", verdict: "PASS" }] },
  }, zero);
}
async function coreFixture(fn: (store: Store) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), "future-dynamic-dag-"));
  const store = await Store.open(root);
  try { store.initialize(contract, recipe); await fn(store); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

test("resume with the admitted root DAG remains valid after runtime expansion", async () => {
  await coreFixture(async store => {
    const root = coreTask("root");
    const q = new Scheduler(store); const run = q.start([root]);
    const parent = q.claim(run, "parent")!; const capsule = q.capsule(parent);
    const child = coreTask("root.leaf", { writeScope: ["src/leaf"], readScope: ["src"] });
    spawnTasks(store, capsule, "spawn-1", digest({ children: ["leaf"] }), [child], policy);
    q.defer(parent, new DeferredAttemptError("spawn", Date.now(), "waiting for child"));

    const d: Driver = {
      workerId: contract.workerId, verifierId: contract.verifierId,
      async execute(capsule) { return { artifact: { task: capsule.task.id }, measurement: zero }; },
      async verify(_capsule, result) {
        return { artifactHash: digest(result.artifact), checks: [{ id: "correct", verdict: "PASS" }], measurement: zero };
      },
    };
    const result = await runTasks(store, [root], d, { resumeRun: run });
    assert.equal(result.status, "PASS");
    assert.equal(result.accepted, 2);
    assert.equal(result.id, run);
  });
});

test("spawn admission and parent yield commit atomically", async () => {
  await coreFixture(store => {
    const q = new Scheduler(store); const run = q.start([coreTask("root")]);
    const lease = q.claim(run, "parent")!; const capsule = q.capsule(lease);
    const child = coreTask("root.leaf", { writeScope: ["src/leaf"], readScope: ["src"] });
    const result = spawnTasks(store, capsule, "atomic-spawn", digest({ child: "leaf" }), [child], policy,
      Date.now(), { reason: "waiting for verified child", wakeAt: Date.now(), measurement: zero });
    assert.equal(result.parentDeferred, true);
    assert.equal(store.db.prepare("SELECT status FROM tasks WHERE run=? AND id='root'").get(run)!.status, "READY");
    assert.equal(store.db.prepare("SELECT status FROM attempts WHERE run=? AND task='root' AND fence=?")
      .get(run, lease.fence)!.status, "DEFERRED");
    assert.equal(store.db.prepare("SELECT status FROM tasks WHERE run=? AND id='root.leaf'").get(run)!.status, "READY");
    assert.equal(store.db.prepare("SELECT kind FROM task_waits WHERE run=? AND task='root'").get(run)!.kind, "spawn");
    const next = q.claim(run, "child")!;
    assert.equal(next.taskId, "root.leaf");
  });
});

test("dynamic DAG batches are durable, replay-safe, and use measured progress density", async () => {
  await coreFixture(store => {
    const q = new Scheduler(store); const run = q.start([coreTask("root")]);
    const firstLease = q.claim(run, "parent")!; const firstCapsule = q.capsule(firstLease);
    const child = coreTask("root.leaf", { writeScope: ["src/leaf"], readScope: ["src"] });
    const requestHash = digest({ children: [{ id: "leaf" }] });
    const first = spawnTasks(store, firstCapsule, "call-1", requestHash, [child], policy);
    assert.deepEqual(first.childIds, ["root.leaf"]); assert.equal(first.complete, false);
    assert.deepEqual(JSON.parse(store.db.prepare(
      "SELECT spec FROM tasks WHERE run=? AND id='root'"
    ).get(run)!.spec).dependencies, []);
    assert.throws(() => spawnTasks(store, firstCapsule, "call-1",
      digest({ changed: true }), [child], policy), /drift/);

    q.defer(firstLease, new DeferredAttemptError("spawn", Date.now(), "waiting for child"));
    const childLease = q.claim(run, "child")!; assert.equal(childLease.taskId, "root.leaf");
    q.capsule(childLease); assert.equal(accept(q, childLease, { value: 7 }), true);

    const secondLease = q.claim(run, "parent-resume")!; assert.equal(secondLease.taskId, "root");
    const secondCapsule = q.capsule(secondLease);
    const replay = spawnTasks(store, secondCapsule, "call-1", requestHash, [child], policy);
    assert.equal(replay.complete, true);
    assert.equal(replay.dependencies[0].artifactHash, digest({ value: 7 }));
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM spawn_edges WHERE run=?")
      .get(run)!.n, 1);
    assert.equal(accept(q, secondLease), true);
    // Run finalization is scheduler-owned and occurs on the next refill/claim.
    assert.equal(q.claim(run, "finalize"), null);

    const measured = store.db.prepare(
      "SELECT context_bytes FROM attempt_telemetry WHERE run=? AND context_bytes IS NOT NULL"
    ).all(run);
    const bytes = measured.reduce((n, row) => n + row.context_bytes, 0);
    const summary = q.summary(run);
    assert.equal(summary.status, "PASS"); assert.equal(summary.accepted, 2);
    // The dynamic child is real accepted work and remains visible in accepted,
    // but it must not manufacture extra objective progress by changing task granularity.
    assert.equal(summary.progressDensity, 1 / bytes);
    assert.notEqual(summary.progressDensity, 2 / bytes);
    assert.notEqual(summary.progressDensity, 1 / (2 * recipe.contextBytes));
  });
});

test("nested dynamic DAG failure propagates through runtime spawn edges", async () => {
  await coreFixture(store => {
    const q = new Scheduler(store);
    const run = q.start([coreTask("root", { writeScope: ["src"], readScope: ["src"] })]);
    const rootLease = q.claim(run, "root")!; const rootCapsule = q.capsule(rootLease);
    const mid = coreTask("root.mid", { writeScope: ["src/mid"], readScope: ["src"] });
    spawnTasks(store, rootCapsule, "root-spawn", digest({ child: "mid" }), [mid], policy);
    q.defer(rootLease, new DeferredAttemptError("spawn", Date.now(), "waiting for mid"));

    const midLease = q.claim(run, "mid")!; assert.equal(midLease.taskId, "root.mid");
    const midCapsule = q.capsule(midLease);
    const leaf = coreTask("root.mid.leaf", { writeScope: ["src/mid/leaf"], readScope: ["src/mid"] });
    spawnTasks(store, midCapsule, "mid-spawn", digest({ child: "leaf" }), [leaf], policy);
    q.defer(midLease, new DeferredAttemptError("spawn", Date.now(), "waiting for leaf"));

    const leafLease = q.claim(run, "leaf")!; assert.equal(leafLease.taskId, "root.mid.leaf");
    q.fail(leafLease, "leaf failed permanently", zero, Date.now(), { retryable: false });
    assert.equal(q.claim(run, "finalize"), null);
    assert.equal(q.summary(run).status, "FAIL");
    assert.equal(store.db.prepare("SELECT status FROM tasks WHERE run=? AND id='root.mid'").get(run)!.status, "BLOCKED");
    assert.equal(store.db.prepare("SELECT status FROM tasks WHERE run=? AND id='root'").get(run)!.status, "BLOCKED");
  });
});

test("dynamic DAG admits ordered sibling dependencies and serializes conflicting scopes", async () => {
  await coreFixture(store => {
    const q = new Scheduler(store);
    const run = q.start([coreTask("root", { writeScope: ["src"], readScope: ["src"] })]);
    const lease = q.claim(run, "parent")!; const capsule = q.capsule(lease);
    const first = coreTask("root.first", { writeScope: ["src/shared"], readScope: ["src"] });
    const second = coreTask("root.second", {
      dependencies: ["root.first"], writeScope: ["src/shared"], readScope: ["src"],
    });
    const spawned = spawnTasks(store, capsule, "ordered", digest({ children: ["first", "second"] }),
      [first, second], policy, Date.now(), {
        reason: "waiting for ordered children", wakeAt: Date.now(), measurement: zero,
      });
    assert.equal(spawned.parentDeferred, true);
    const firstLease = q.claim(run, "first")!;
    assert.equal(firstLease.taskId, "root.first");
    assert.equal(q.claim(run, "blocked"), null, "dependent sibling must not run early");
    assert.equal(accept(q, firstLease, { stage: 1 }), true);
    const secondLease = q.claim(run, "second")!;
    assert.equal(secondLease.taskId, "root.second");
    assert.equal(accept(q, secondLease, { stage: 2 }), true);
    assert.equal(q.claim(run, "parent-resume")!.taskId, "root");
  });
});

test("dynamic DAG admission rejects authority expansion and sibling conflicts", async () => {
  await coreFixture(store => {
    const q = new Scheduler(store);
    const run = q.start([coreTask("root", { writeScope: ["src/owned"], readScope: ["src"] })]);
    const lease = q.claim(run, "parent")!; const c = q.capsule(lease);
    assert.throws(() => spawnTasks(store, c, "escape", digest({ a: 1 }), [
      coreTask("root.escape", { writeScope: ["src/outside"], readScope: ["src"] }),
    ], policy), /write scope/);
    assert.throws(() => spawnTasks(store, c, "conflict", digest({ a: 2 }), [
      coreTask("root.a", { writeScope: ["src/owned/a"], readScope: ["src/owned"] }),
      coreTask("root.b", { writeScope: ["src/owned/a/file"], readScope: ["src/owned"] }),
    ], policy), /access conflict/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM spawn_edges WHERE run=?")
      .get(run)!.n, 0);
  });
});

test("spawn_tasks requires explicit host policy; no KV-cache or inference-engine setting is required", () => {
  const s = spec("/tmp/repo"); s.agents.coder.tools.push("spawn_tasks");
  assert.throws(() => validateSwarmSpec(s), /dynamicDAG/);
  s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 10000,
    dynamicDAG: { maxChildrenPerTask: 4, maxDepth: 3, maxSpawnedTasks: 20 } };
  validateSwarmSpec(s);
  assert.equal(s.agents.coder.promptCache, undefined);
});

test("external HTTP agent can fan out a child and resume after verified completion", async () => {
  await fixture(async (store, cfg, project) => {
    const root: Task = { ...swarmTask("root"), writeScope: ["src"], readScope: ["src"], input: null };
    let calls = 0;
    const fetcher = (async (_url: any, init: any) => {
      calls++; const body = JSON.parse(init.body);
      const firstUser = body.messages.find((m: any) =>
        m.role === "user" && typeof m.content === "string" && m.content.includes('"task"'));
      const packet = JSON.parse(firstUser.content); const id = packet.task.id as string;
      const hasToolResult = body.messages.some((m: any) => m.role === "tool");
      if (id === "root") {
        if (hasToolResult) return reply("root integrated verified child");
        return reply("", [{ name: "spawn_tasks", arguments: { children: [{
          id: "prep", goal: "Write the verified fixture value",
          acceptance: ["behavior check passes"], input: { value: 42 },
          writeScope: ["src/a.txt"], readScope: ["src"]
        }, {
          id: "leaf", goal: "Verify the prepared value in an ordered sibling",
          acceptance: ["behavior check passes"], input: { value: 42 },
          writeScope: ["src/a.txt"], readScope: ["src"], dependsOn: ["prep"]
        }] } }]);
      }
      if (id === "root.prep") {
        if (hasToolResult) return reply("prep complete");
        return reply("", [{ name: "write_file",
          arguments: { path: "src/a.txt", content: "42\n" } }]);
      }
      assert.equal(id, "root.leaf");
      return reply("leaf verified inherited prep output");
    }) as typeof fetch;

    const result: any = await runSwarm(store, [root], signal(), undefined, fetcher);
    assert.equal(result.status, "PASS"); assert.equal(result.accepted, 3); assert.equal(calls, 5);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM spawn_edges WHERE run=?")
      .get(result.id)!.n, 2);
    const integrated = await integrateSwarm(store, result.id, signal());
    assert.equal(execFileSync("git", ["-C", project, "show",
      `${integrated.commit}:src/a.txt`], { encoding: "utf8" }), "42\n");
    assert.equal(cfg.spec.agents.coder.promptCache, undefined);
  }, s => {
    s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 10000,
      dynamicDAG: { maxChildrenPerTask: 4, maxDepth: 3, maxSpawnedTasks: 20 } };
    s.agents.coder.tools.push("spawn_tasks");
  });
});
