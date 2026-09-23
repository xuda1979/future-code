import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, conflicts, digest, encodeCapsule, validateContract, validateRecipe, validateTasks, verdict, sha256 } from "../../src/harness/foundry/kernel.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { CommandDriver, invoke, pinCommand } from "../../src/harness/foundry/commands.ts";
import { evaluate, promote, rollback, suggest, loadEvaluation, score } from "../../src/harness/foundry/evolution.ts";
import type { Contract, Evaluation, Json, Measurement, Protocol, Recipe, Task, Verification, Driver, WorkerResult, Capsule } from "../../src/harness/foundry/types.ts";
import { contract as fixtureContract, recipe as fixtureRecipe, task as fixtureTask } from "./fixtures.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const tmp = () => mkdtempSync(join(tmpdir(), "foundry-indepth-"));

async function fixture(fn: (s: Store, d: MockDriver, baseline: string) => Promise<void> | void): Promise<void> {
  const path = tmp();
  const s = await Store.open(path);
  // Use parallelism=1 for baseline so evaluate can test improvement
  s.initialize(fixtureContract, { ...fixtureRecipe, parallelism: 1 });
  const baseline = s.active();
  const d = new MockDriver(baseline);
  try { await fn(s, d, baseline); } finally { s.close(); rmSync(path, { recursive: true, force: true }); }
}

class MockDriver implements Driver {
  verifierId = fixtureContract.verifierId;
  workerId = fixtureContract.workerId;
  calls = 0;
  failNext = false;
  delayMs = 0;
  baselineHash: string;
  constructor(baselineHash: string) { this.baselineHash = baselineHash; }
  async execute(capsule: Capsule, signal: AbortSignal): Promise<WorkerResult> {
    this.calls++;
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
    if (this.failNext) throw new Error("mock worker failure");
    // Baseline costs more than candidate, enabling evaluate ADMIT tests
    const isBaseline = capsule.recipeHash === this.baselineHash;
    return { artifact: { result: "ok", taskId: capsule.task.id }, measurement: { durationMs: isBaseline ? 100 : 50, tokens: isBaseline ? 20 : 10, costUsd: isBaseline ? 2 : 1 } };
  }
  async verify(capsule: Capsule, result: WorkerResult, signal: AbortSignal): Promise<Verification> {
    if (this.failNext) throw new Error("mock verifier failure");
    return { artifactHash: digest(result.artifact), checks: [{ id: "behavior", verdict: "PASS" as const }], measurement: { durationMs: 5, tokens: 50, costUsd: 0.005 } };
  }
}

const protocol = (objective: "durationMs" | "costUsd" = "costUsd", gain = 0.2, reps = 2): Protocol => ({
  datasetId: "indepth-holdout-v1", environmentId: fixtureContract.environmentId,
  tasks: [fixtureTask()], repetitions: reps, objective, minRelativeGain: gain,
});

const makeEvidence = (s: Store, task: Task, artifact: Json, m: Measurement) => ({
  contractHash: digest(s.contract()), recipeHash: s.active(), verifierId: s.contract().verifierId,
  taskHash: digest(task), artifactHash: digest(artifact),
  metrics: { durationMs: m.durationMs, tokens: m.tokens ?? 0, costUsd: m.costUsd ?? 0 },
  verification: { artifactHash: digest(artifact), checks: [{ id: "behavior", verdict: "PASS" as const }] } as Verification,
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. KERNEL: canonical, digest, validation edge cases
// ═══════════════════════════════════════════════════════════════════════════════

test("canonical rejects NaN, Infinity, -Infinity", () => {
  assert.throws(() => canonical(NaN), /finite/);
  assert.throws(() => canonical(Infinity), /finite/);
  assert.throws(() => canonical(-Infinity), /finite/);
});

test("canonical rejects non-finite values nested in arrays", () => {
  assert.throws(() => canonical([1, NaN, 3]), /finite/);
  assert.throws(() => canonical({ a: [Infinity] }), /finite/);
});

test("canonical handles null, boolean, number, string primitives", () => {
  assert.equal(canonical(null), "null");
  assert.equal(canonical(true), "true");
  assert.equal(canonical(false), "false");
  assert.equal(canonical(42), "42");
  assert.equal(canonical("hello"), "\"hello\"");
});

test("canonical handles deeply nested objects", () => {
  const obj = { a: { b: { c: [1, 2, { d: "x" }] } }, e: null };
  const c = canonical(obj);
  assert.deepEqual(JSON.parse(c), obj);
});

test("canonical sorts object keys for deterministic output", () => {
  const a = canonical({ b: 1, a: 2 });
  const b = canonical({ a: 2, b: 1 });
  assert.equal(a, b);
});

test("canonical rejects undefined values (treated as non-finite)", () => {
  assert.throws(() => canonical({ x: undefined }), /finite/);
  assert.throws(() => canonical([undefined]), /finite/);
});

test("digest is 64-char hex (SHA-256)", () => {
  const h = digest({ a: 1 });
  assert.match(h, /^[0-9a-f]{64}$/);
});

test("digest of same canonical content is identical regardless of key order", () => {
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
});

test("digest differs for different content", () => {
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
});

test("sha256 of empty string matches known value", () => {
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("validateContract rejects schema != 1", () => {
  assert.throws(() => validateContract({ ...fixtureContract, schema: 2 as any }), /identity/);
  assert.throws(() => validateContract({ ...fixtureContract, schema: 0 as any }), /identity/);
});

test("validateContract rejects empty requiredChecks", () => {
  assert.throws(() => validateContract({ ...fixtureContract, requiredChecks: [] }), /mandatory/);
});

test("validateContract rejects zero parallelism in limits", () => {
  assert.throws(() => validateContract({ ...fixtureContract, limits: { ...fixtureContract.limits, parallelism: 0 } }), /parallelism/);
});

test("validateContract rejects zero timeoutMs", () => {
  assert.throws(() => validateContract({ ...fixtureContract, limits: { ...fixtureContract.limits, timeoutMs: 0 } }), /timeout/);
});

test("validateContract rejects zero attempts", () => {
  assert.throws(() => validateContract({ ...fixtureContract, limits: { ...fixtureContract.limits, attempts: 0 } }), /attempt/);
});

test("validateRecipe rejects parallelism exceeding contract limit", () => {
  assert.throws(() => validateRecipe(fixtureContract, { parallelism: 100, attempts: 1, contextBytes: 100, timeoutMs: 100 }), /parallelism/);
});

test("validateRecipe rejects attempts exceeding contract limit", () => {
  assert.throws(() => validateRecipe(fixtureContract, { parallelism: 1, attempts: 100, contextBytes: 100, timeoutMs: 100 }), /attempts/);
});

test("validateRecipe rejects contextBytes exceeding contract limit", () => {
  assert.throws(() => validateRecipe(fixtureContract, { parallelism: 1, attempts: 1, contextBytes: 100000, timeoutMs: 100 }), /contextBytes/);
});

test("validateRecipe rejects timeoutMs exceeding contract limit", () => {
  assert.throws(() => validateRecipe(fixtureContract, { parallelism: 1, attempts: 1, contextBytes: 100, timeoutMs: 100000 }), /timeoutMs/);
});

test("validateTasks rejects duplicate task ids", () => {
  const t = fixtureTask();
  assert.throws(() => validateTasks(fixtureContract, [t, { ...t }]), /duplicate/);
});

test("validateTasks rejects dependency on non-existent task", () => {
  assert.throws(() => validateTasks(fixtureContract, [fixtureTask("a", ["nonexistent"])]), /dependency/);
});

test("validateTasks rejects too many tasks", () => {
  const tasks = Array.from({ length: 101 }, (_, i) => fixtureTask(`t${i}`));
  assert.throws(() => validateTasks({ ...fixtureContract, limits: { ...fixtureContract.limits, tasks: 100 } }, tasks), /task count/);
});

test("validateTasks rejects self-dependency", () => {
  assert.throws(() => validateTasks(fixtureContract, [fixtureTask("a", ["a"])]), /dependency/);
});

test("conflicts detects overlapping write scopes", () => {
  assert.ok(conflicts(["src/a.js"], ["src/a.js"]));
  assert.ok(!conflicts(["src/a.js"], ["src/b.js"]));
  assert.ok(!conflicts(["src/a.js"], ["test/a.js"]));
});

test("verdict returns FAIL when a required check is FAIL", () => {
  const v: Verification = { artifactHash: digest({}), checks: [{ id: "behavior", verdict: "FAIL" }] };
  assert.equal(verdict(fixtureContract, {}, v, { durationMs: 10, tokens: 0, costUsd: 0 }), "FAIL");
});

test("verdict returns UNKNOWN when a required check is UNKNOWN", () => {
  const v: Verification = { artifactHash: digest({}), checks: [{ id: "behavior", verdict: "UNKNOWN" }] };
  assert.equal(verdict(fixtureContract, {}, v, { durationMs: 10, tokens: 0, costUsd: 0 }), "UNKNOWN");
});

test("verdict returns UNKNOWN when a required check is missing from checks array", () => {
  const v: Verification = { artifactHash: digest({}), checks: [] };
  assert.equal(verdict(fixtureContract, {}, v, { durationMs: 10, tokens: 0, costUsd: 0 }), "UNKNOWN");
});

test("verdict returns PASS when all required checks pass and SLOs satisfied", () => {
  const c: Contract = { ...fixtureContract, slos: [{ metric: "durationMs", maximum: 100 }] };
  const v: Verification = { artifactHash: digest({}), checks: [{ id: "behavior", verdict: "PASS" }] };
  assert.equal(verdict(c, {}, v, { durationMs: 50, tokens: 0, costUsd: 0 }), "PASS");
});

test("verdict returns FAIL when SLO durationMs is violated", () => {
  const c: Contract = { ...fixtureContract, slos: [{ metric: "durationMs", maximum: 10 }] };
  const v: Verification = { artifactHash: digest({}), checks: [{ id: "behavior", verdict: "PASS" }] };
  assert.equal(verdict(c, {}, v, { durationMs: 100, tokens: 0, costUsd: 0 }), "FAIL");
});

test("verdict returns FAIL when SLO costUsd is violated", () => {
  const c: Contract = { ...fixtureContract, slos: [{ metric: "costUsd", maximum: 0.001 }] };
  const v: Verification = { artifactHash: digest({}), checks: [{ id: "behavior", verdict: "PASS" }] };
  assert.equal(verdict(c, {}, v, { durationMs: 0, tokens: 0, costUsd: 0.01 }), "FAIL");
});

test("encodeCapsule truncates at context byte budget", () => {
  const c: Capsule = { schema: 1, task: fixtureTask(), runId: "r", fence: 1, contractHash: "c", recipeHash: "p", dependencies: [] };
  assert.throws(() => encodeCapsule(c, 5), /CONTEXT_OVERFLOW/);
  const encoded = encodeCapsule(c, 100000);
  const decoded = JSON.parse(encoded);
  assert.equal(decoded.task.id, "a");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. STORE: persistence, recipes, artifacts, events
// ═══════════════════════════════════════════════════════════════════════════════

test("store active() returns the initial recipe hash", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    assert.equal(s.active(), digest(fixtureRecipe));
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store contract() returns the pinned contract", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    const c = s.contract();
    assert.equal(c.name, fixtureContract.name);
    assert.equal(c.verifierId, fixtureContract.verifierId);
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store recipe() returns recipe by hash", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    const r = s.recipe(s.active());
    assert.equal(r.parallelism, fixtureRecipe.parallelism);
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store recipe() throws for unknown hash", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    assert.throws(() => s.recipe("0000000000000000000000000000000000000000000000000000000000000000"), /recipe/);
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store propose() creates a child recipe with changed fields", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    const child = s.propose({ parallelism: 4 });
    assert.notEqual(child, s.active());
    assert.equal(s.recipe(child).parallelism, 4);
    assert.equal(s.recipe(child).attempts, fixtureRecipe.attempts);
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store propose() with same params returns same hash (idempotent)", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    const a = s.propose({ parallelism: 4 });
    const b = s.propose({ parallelism: 4 });
    assert.equal(a, b);
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store setActive() changes active recipe", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    const child = s.propose({ parallelism: 4 });
    s.setMeta("active", child);
    assert.equal(s.active(), child);
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store artifact() round-trips JSON", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    const art = { result: "test", nested: { values: [1, 2, 3] } };
    const hash = s.artifact(art);
    assert.equal(hash, digest(art));
    assert.deepEqual(s.readArtifact(hash), art);
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store readArtifact rejects path traversal", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    assert.throws(() => s.readArtifact("../../etc/passwd"), /invalid artifact id/);
    assert.throws(() => s.readArtifact("abc"), /invalid artifact id/);
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store events are append-only with sequential ids", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    s.event("test.a", { n: 1 });
    s.event("test.b", { n: 2 });
    const events = s.events();
    const testEvents = events.filter(e => e.kind.startsWith("test."));
    assert.equal(testEvents.length, 2);
    assert.equal(testEvents[0].kind, "test.a");
    assert.equal(testEvents[1].kind, "test.b");
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store events pagination with after/limit", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    for (let i = 0; i < 5; i++) s.event("test", { i });
    const all = s.events(0, 100);
    const testEvents = all.filter(e => e.kind === "test");
    assert.equal(testEvents.length, 5);
    const page1 = s.events(testEvents[0].seq, 2);
    assert.equal(page1.length, 2);
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store events reject invalid pagination params", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    assert.throws(() => s.events(-1, 10), /invalid/);
    assert.throws(() => s.events(0, 0), /invalid/);
    assert.throws(() => s.events(0, 1001), /invalid/);
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store transaction rollback undoes events", async () => {
  const path = tmp();
  try {
    const s = await Store.open(path);
    s.initialize(fixtureContract, fixtureRecipe);
    s.event("before", {});
    const before = s.events().length;
    assert.throws(() => s.transaction(() => { s.event("inside", {}); throw new Error("rollback"); }));
    assert.equal(s.events().length, before);
    s.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("store persists across reopen", async () => {
  const path = tmp();
  try {
    const s1 = await Store.open(path);
    s1.initialize(fixtureContract, fixtureRecipe);
    s1.event("persisted", { x: 42 });
    s1.close();
    const s2 = await Store.open(path);
    const events = s2.events();
    assert.ok(events.some(e => e.kind === "persisted" && (e.payload as any).x === 42));
    s2.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SCHEDULER: DAG, retries, blocked deps, lease management
// ═══════════════════════════════════════════════════════════════════════════════

test("scheduler start creates a run with all tasks in READY state", async () => {
  await fixture(async (s) => {
    const q = new Scheduler(s);
    const run = q.start([fixtureTask("a"), fixtureTask("b")]);
    const tasks = s.db.prepare("SELECT * FROM tasks WHERE run=?").all(run);
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t: any) => t.status === "READY"));
    const runRow = s.db.prepare("SELECT * FROM runs WHERE id=?").get(run) as any;
    assert.equal(runRow.status, "RUNNING");
  });
});

test("scheduler blocks dependent tasks when a dependency fails", async () => {
  await fixture(async (s) => {
    const q = new Scheduler(s);
    const run = q.start([fixtureTask("root"), fixtureTask("child", ["root"])]);
    // Exhaust both attempts on root to make it FAIL
    const lease1 = q.claim(run, "owner1");
    assert.ok(lease1);
    q.fail(lease1!, "first failure", { durationMs: 1, tokens: 0, costUsd: 0 });
    const lease2 = q.claim(run, "owner1");
    assert.ok(lease2);
    assert.equal(lease2!.fence, 2);
    q.fail(lease2!, "second failure", { durationMs: 1, tokens: 0, costUsd: 0 });
    // root is now FAIL, child should be BLOCKED
    const next = q.claim(run, "owner1");
    assert.equal(next, null);
    const summary = q.summary(run);
    assert.equal(summary.status, "FAIL");
    assert.equal(summary.failed, 1);
    assert.equal(summary.blocked, 1);
  });
});

test("scheduler retry resets task to READY when attempts remain", async () => {
  await fixture(async (s) => {
    const q = new Scheduler(s);
    const run = q.start([fixtureTask("a")]);
    const lease = q.claim(run, "owner1");
    assert.ok(lease);
    q.fail(lease!, "first failure", { durationMs: 1, tokens: 0, costUsd: 0 });
    const taskRow = s.db.prepare("SELECT status FROM tasks WHERE run=? AND id=?").get(run, "a") as any;
    assert.equal(taskRow.status, "READY"); // recipe.attempts=2, so retry
  });
});

test("scheduler sets FAIL after exhausting all attempts", async () => {
  await fixture(async (s) => {
    const q = new Scheduler(s);
    const run = q.start([fixtureTask("a")]);
    let lease = q.claim(run, "owner1");
    assert.ok(lease);
    q.fail(lease!, "attempt 1", { durationMs: 1, tokens: 0, costUsd: 0 });
    lease = q.claim(run, "owner2");
    assert.ok(lease);
    assert.equal(lease!.fence, 2);
    q.fail(lease!, "attempt 2", { durationMs: 1, tokens: 0, costUsd: 0 });
    const taskRow = s.db.prepare("SELECT status FROM tasks WHERE run=? AND id=?").get(run, "a") as any;
    assert.equal(taskRow.status, "FAIL");
  });
});

test("scheduler lease becomes stale after deadline", async () => {
  await fixture(async (s) => {
    const q = new Scheduler(s);
    const run = q.start([fixtureTask("a")]);
    const lease = q.claim(run, "owner1");
    assert.ok(lease);
    const stale = q.current(lease!, lease!.deadline + 1000);
    assert.equal(stale, false);
  });
});

test("scheduler claim returns null when no tasks are ready", async () => {
  await fixture(async (s) => {
    const q = new Scheduler(s);
    const run = q.start([fixtureTask("a")]);
    const lease1 = q.claim(run, "owner1");
    assert.ok(lease1);
    const lease2 = q.claim(run, "owner2");
    assert.equal(lease2, null);
  });
});

test("scheduler claim returns null when parallelism limit reached", async () => {
  await fixture(async (s) => {
    // Fixture recipe has parallelism=1, so only 1 task can be claimed at a time
    const q = new Scheduler(s);
    const run = q.start([fixtureTask("a"), fixtureTask("b")]);
    const lease1 = q.claim(run, "owner1");
    assert.ok(lease1);
    const lease2 = q.claim(run, "owner2");
    assert.equal(lease2, null); // parallelism=1
  });
});

test("scheduler respects write-scope conflicts for concurrent tasks", async () => {
  await fixture(async (s) => {
    const t1 = fixtureTask("a", [], ["src/shared.js"]);
    const t2 = fixtureTask("b", [], ["src/shared.js"]);
    const q = new Scheduler(s);
    const run = q.start([t1, t2]);
    const lease1 = q.claim(run, "owner1");
    assert.ok(lease1);
    const lease2 = q.claim(run, "owner2");
    assert.equal(lease2, null); // blocked by write-scope conflict
  });
});

test("scheduler summary reports correct counts after a full run", async () => {
  await fixture(async (s, d) => {
    const result = await runTasks(s, [fixtureTask("a"), fixtureTask("b")], d);
    const q = new Scheduler(s);
    const summary = q.summary(result.id);
    assert.equal(summary.accepted, 2);
    assert.equal(summary.failed, 0);
    assert.equal(summary.blocked, 0);
    assert.equal(summary.status, "PASS");
  });
});

test("scheduler capsule includes dependency artifacts", async () => {
  await fixture(async (s) => {
    const q = new Scheduler(s);
    const tasks = [fixtureTask("parent"), fixtureTask("child", ["parent"])];
    const run = q.start(tasks);
    const lease = q.claim(run, "owner1");
    assert.ok(lease);
    const artifact = { result: "parent-output" };
    q.finish(lease!, artifact, makeEvidence(s, tasks[0], artifact, { durationMs: 1, tokens: 0, costUsd: 0 }), { durationMs: 1, tokens: 0, costUsd: 0 });
    const childLease = q.claim(run, "owner2");
    assert.ok(childLease);
    assert.equal(childLease!.taskId, "child");
    const capsule = q.capsule(childLease!);
    assert.ok(capsule.dependencies);
    assert.equal(capsule.dependencies.length, 1);
    assert.equal(capsule.dependencies[0].taskId, "parent");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. RUNTIME: end-to-end execution, cancellation, resume
// ═══════════════════════════════════════════════════════════════════════════════

test("runTasks completes all tasks and returns PASS", async () => {
  await fixture(async (s, d) => {
    const result = await runTasks(s, [fixtureTask("a"), fixtureTask("b"), fixtureTask("c")], d);
    assert.equal(result.status, "PASS");
    assert.equal(result.accepted, 3);
    assert.equal(result.failed, 0);
    assert.ok(result.durationMs >= 0);
  });
});

test("runTasks with dependency chain completes in order", async () => {
  await fixture(async (s, d) => {
    const tasks = [fixtureTask("a"), fixtureTask("b", ["a"]), fixtureTask("c", ["b"])];
    const result = await runTasks(s, tasks, d);
    assert.equal(result.status, "PASS");
    assert.equal(result.accepted, 3);
  });
});

test("runTasks returns FAIL when worker throws on all attempts", async () => {
  await fixture(async (s, d) => {
    d.failNext = true;
    const result = await runTasks(s, [fixtureTask("a")], d);
    assert.equal(result.status, "FAIL");
    assert.equal(result.failed, 1);
  });
});

test("runTasks retries on failure and succeeds on second attempt", async () => {
  await fixture(async (s, d) => {
    let callCount = 0;
    const origExecute = d.execute.bind(d);
    d.execute = async (capsule: Capsule, signal: AbortSignal) => {
      callCount++;
      if (callCount === 1) throw new Error("transient failure");
      return origExecute(capsule, signal);
    };
    const result = await runTasks(s, [fixtureTask("a")], d);
    assert.equal(result.status, "PASS");
    assert.equal(result.accepted, 1);
    assert.ok(callCount >= 2);
  });
});

test("runTasks with signal cancellation pauses gracefully", async () => {
  await fixture(async (s, d) => {
    const controller = new AbortController();
    d.delayMs = 200;
    const tasks = [fixtureTask("a"), fixtureTask("b"), fixtureTask("c"), fixtureTask("d")];
    const promise = runTasks(s, tasks, d, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    assert.ok(result.accepted >= 0);
    assert.ok(result.status === "PASS" || result.status === "RUNNING");
  });
});

test("runTasks resume continues a paused run", async () => {
  await fixture(async (s, d) => {
    const controller = new AbortController();
    d.delayMs = 100;
    const tasks = [fixtureTask("a"), fixtureTask("b"), fixtureTask("c"), fixtureTask("d")];
    const promise = runTasks(s, tasks, d, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const first = await promise;
    if (first.accepted < tasks.length) {
      d.delayMs = 0;
      const resumed = await runTasks(s, tasks, d, { resumeRun: first.id });
      assert.equal(resumed.status, "PASS");
      assert.equal(resumed.accepted, tasks.length);
    }
  });
});

test("runTasks rejects driver with mismatched verifierId", async () => {
  await fixture(async (s) => {
    const badDriver: Driver = { ...new MockDriver(s.active()), verifierId: "wrong" };
    await assert.rejects(runTasks(s, [fixtureTask("a")], badDriver), /identity mismatch/);
  });
});

test("runTasks rejects driver with mismatched workerId", async () => {
  await fixture(async (s) => {
    const badDriver: Driver = { ...new MockDriver(s.active()), workerId: "wrong" };
    await assert.rejects(runTasks(s, [fixtureTask("a")], badDriver), /identity mismatch/);
  });
});

test("runTasks recipe hash uses specified recipe", async () => {
  await fixture(async (s, d) => {
    const candidate = s.propose({ parallelism: 4 });
    const result = await runTasks(s, [fixtureTask("a")], d, { recipeHash: candidate });
    assert.equal(result.recipeHash, candidate);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. COMMANDS: subprocess isolation, timeout, output limits
// ═══════════════════════════════════════════════════════════════════════════════

async function cmdFixture(code: string, fn: (c: any, dir: string) => Promise<void> | void): Promise<void> {
  const dir = tmp();
  const script = join(dir, "worker.mjs");
  writeFileSync(script, code);
  const spec = { argv: [process.execPath, script], files: [script] };
  try {
    const c = pinCommand(spec, dir);
    await fn(c, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("invoke returns parsed JSON output", async () => {
  await cmdFixture("console.log(JSON.stringify({ artifact: { result: 42 } }))", async (c) => {
    const result = await invoke(c, { kind: "execute", capsule: { task: { id: "test" } } }, 65536, AbortSignal.timeout(3000));
    assert.deepEqual(result.artifact, { result: 42 });
  });
});

test("invoke rejects non-JSON stdout", async () => {
  await cmdFixture("console.log('not json')", async (c) => {
    await assert.rejects(invoke(c, { kind: "execute" }, 65536, AbortSignal.timeout(3000)), /JSON/);
  });
});

test("invoke rejects non-zero exit code", async () => {
  await cmdFixture("process.exit(1)", async (c) => {
    await assert.rejects(invoke(c, { kind: "execute" }, 65536, AbortSignal.timeout(3000)), /exit/);
  });
});

test("invoke rejects output exceeding byte budget", async () => {
  await cmdFixture("console.log(JSON.stringify({a:'x'.repeat(10000)}))", async (c) => {
    await assert.rejects(invoke(c, { kind: "execute" }, 100, AbortSignal.timeout(5000)), /byte budget/);
  });
});

test("invoke times out on slow worker", async () => {
  await cmdFixture("await new Promise(r => setTimeout(r, 5000))", async (c) => {
    await assert.rejects(invoke(c, { kind: "execute" }, 65536, AbortSignal.timeout(200)), /timed out|cancelled/);
  });
});

test("invoke succeeds with stderr output if stdout is valid JSON", async () => {
  await cmdFixture("console.error('error to stderr'); console.log(JSON.stringify({ artifact: 1 }))", async (c) => {
    const result = await invoke(c, { kind: "execute" }, 65536, AbortSignal.timeout(3000));
    assert.ok(result.artifact);
  });
});

test("CommandDriver execute returns artifact and null measurement", async () => {
  await cmdFixture("console.log(JSON.stringify({ artifact: { code: '(a,b)=>a+b' } }))", async (c) => {
    const driver = new CommandDriver(c, c, 65536);
    const result = await driver.execute(
      { schema: 1, task: fixtureTask(), runId: "r", fence: 1, contractHash: "c", recipeHash: "p", dependencies: [] } as Capsule,
      AbortSignal.timeout(3000)
    );
    assert.ok(result.artifact);
    assert.equal(result.measurement.tokens, null);
    assert.equal(result.measurement.costUsd, null);
  });
});

test("CommandDriver verify returns verification with checks", async () => {
  const verifyCode = `console.log(JSON.stringify({ artifactHash: "test", checks: [{ id: "behavior", verdict: "PASS" }] }))`;
  await cmdFixture(verifyCode, async (c) => {
    const driver = new CommandDriver(c, c, 65536);
    const capsule = { schema: 1 as const, task: fixtureTask(), runId: "r", fence: 1, contractHash: "c", recipeHash: "p", dependencies: [] };
    const workerResult = { artifact: { code: "test" }, measurement: { durationMs: 1, tokens: null, costUsd: null } };
    const verification = await driver.verify(capsule, workerResult, AbortSignal.timeout(3000));
    assert.ok(verification.checks);
    assert.equal(verification.checks.length, 1);
    assert.equal(verification.checks[0].verdict, "PASS");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. EVOLUTION: evaluation, scoring, promotion, rollback, suggest
// ═══════════════════════════════════════════════════════════════════════════════

test("evaluate ADMITS candidate with sufficient gain", async () => {
  await fixture(async (s, d, baseline) => {
    const candidate = s.propose({ parallelism: 2 });
    const e = await evaluate(s, candidate, protocol("costUsd", 0.1), d);
    assert.equal(e.decision, "ADMIT");
    assert.ok(e.relativeGain! >= 0.1);
    assert.equal(s.active(), baseline);
  });
});

test("evaluate REJECTS candidate with insufficient gain", async () => {
  await fixture(async (s, d) => {
    // Use a driver that returns same cost for both arms → gain = 0
    const sameCostDriver: Driver = {
      verifierId: fixtureContract.verifierId, workerId: fixtureContract.workerId,
      async execute(c) { return { artifact: { answer: 4 }, measurement: { tokens: 10, costUsd: 1 } }; },
      async verify(_c, r) { return { artifactHash: digest(r.artifact), checks: [{ id: "behavior", verdict: "PASS" as const }], measurement: { tokens: 0, costUsd: 0 } }; },
    };
    const candidate = s.propose({ parallelism: 2 });
    const e = await evaluate(s, candidate, protocol("costUsd", 0.99), sameCostDriver);
    assert.equal(e.decision, "REJECT");
    assert.equal(e.relativeGain, 0);
    assert.ok(e.reasons.some((r: string) => r.includes("insufficient")));
  });
});

test("evaluate REJECTS when candidate fails quality contract", async () => {
  await fixture(async (s, d) => {
    const candidate = s.propose({ parallelism: 2 });
    d.failNext = true;
    const e = await evaluate(s, candidate, protocol("costUsd", 0.1), d);
    assert.equal(e.decision, "REJECT");
    assert.ok(e.reasons.some((r: string) => r.includes("all") || r.includes("pass") || r.includes("quality")));
    d.failNext = false;
  });
});

test("evaluate counterbalances A/B order across repetitions", async () => {
  await fixture(async (s, d) => {
    const candidate = s.propose({ parallelism: 2 });
    const e = await evaluate(s, candidate, protocol("costUsd", 0.1, 4), d);
    assert.equal(e.pairs.length, 4);
    for (const pair of e.pairs) {
      assert.ok(pair.baseline);
      assert.ok(pair.candidate);
    }
  });
});

test("promote makes candidate the active recipe", async () => {
  await fixture(async (s, d) => {
    const candidate = s.propose({ parallelism: 2 });
    const e = await evaluate(s, candidate, protocol("costUsd", 0.1), d);
    assert.equal(e.decision, "ADMIT");
    promote(s, e.id);
    assert.equal(s.active(), candidate);
  });
});

test("promote rejects non-ADMIT evaluation", async () => {
  await fixture(async (s, d) => {
    const sameCostDriver: Driver = {
      verifierId: fixtureContract.verifierId, workerId: fixtureContract.workerId,
      async execute(c) { return { artifact: { answer: 4 }, measurement: { tokens: 10, costUsd: 1 } }; },
      async verify(_c, r) { return { artifactHash: digest(r.artifact), checks: [{ id: "behavior", verdict: "PASS" as const }], measurement: { tokens: 0, costUsd: 0 } }; },
    };
    const candidate = s.propose({ parallelism: 2 });
    const e = await evaluate(s, candidate, protocol("costUsd", 0.99), sameCostDriver);
    assert.equal(e.decision, "REJECT");
    assert.throws(() => promote(s, e.id), /admit/);
  });
});

test("promote is idempotent for already-promoted evaluation", async () => {
  await fixture(async (s, d) => {
    const candidate = s.propose({ parallelism: 2 });
    const e = await evaluate(s, candidate, protocol("costUsd", 0.1), d);
    const first = promote(s, e.id);
    assert.equal(s.active(), candidate);
    // Second promote should be a no-op (returns same hash, no throw)
    const second = promote(s, e.id);
    assert.equal(second, candidate);
    assert.equal(s.active(), candidate);
  });
});

test("rollback restores previous active recipe", async () => {
  await fixture(async (s, d, baseline) => {
    const candidate = s.propose({ parallelism: 2 });
    const e = await evaluate(s, candidate, protocol("costUsd", 0.1), d);
    promote(s, e.id);
    assert.equal(s.active(), candidate);
    rollback(s, baseline);
    assert.equal(s.active(), baseline);
  });
});

test("loadEvaluation retrieves a saved evaluation", async () => {
  await fixture(async (s, d) => {
    const candidate = s.propose({ parallelism: 2 });
    const e = await evaluate(s, candidate, protocol("costUsd", 0.1), d);
    const loaded = loadEvaluation(s, e.id);
    assert.equal(loaded.id, e.id);
    assert.equal(loaded.decision, e.decision);
    assert.equal(loaded.relativeGain, e.relativeGain);
  });
});

test("score returns UNKNOWN for incomplete evaluation", async () => {
  await fixture(async (s) => {
    const p = protocol();
    const e: Evaluation = {
      id: "test", baselineHash: s.active(), candidateHash: "x", contractHash: digest(s.contract()),
      protocol: p, protocolHash: digest(p),
      pairs: [], decision: "UNKNOWN", reasons: [], relativeGain: null,
    };
    const result = score(e);
    assert.equal(result.decision, "UNKNOWN");
    assert.equal(result.relativeGain, null);
  });
});

test("score returns UNKNOWN when baseline cost is zero", async () => {
  await fixture(async (s) => {
    const p = protocol("costUsd", 0.1, 1); // 1 repetition
    const e: Evaluation = {
      id: "test", baselineHash: s.active(), candidateHash: "x", contractHash: digest(s.contract()),
      protocol: p, protocolHash: digest(p),
      pairs: [{ baseline: { id: "r1", recipeHash: s.active(), contractHash: digest(s.contract()), status: "PASS", accepted: 1, failed: 0, blocked: 0, attempts: 1, durationMs: 0, tokens: 0, costUsd: 0 }, candidate: { id: "r2", recipeHash: "x", contractHash: digest(s.contract()), status: "PASS", accepted: 1, failed: 0, blocked: 0, attempts: 1, durationMs: 0, tokens: 0, costUsd: 0 } }],
      decision: "UNKNOWN", reasons: [], relativeGain: null,
    };
    const result = score(e);
    assert.equal(result.decision, "UNKNOWN");
    assert.equal(result.relativeGain, null);
    assert.ok(result.reasons.some((r: string) => r.includes("zero")));
  });
});

test("suggest returns null with fewer than 3 runs", async () => {
  await fixture(async (s, d) => {
    await runTasks(s, [fixtureTask("a")], d);
    const result = suggest(s);
    assert.equal(result, null);
  });
});

test("suggest returns null when independent tasks <= parallelism", async () => {
  await fixture(async (s, d) => {
    // fixture recipe has parallelism=1, 1 task → 1 <= 1 → null
    for (let i = 0; i < 3; i++) await runTasks(s, [fixtureTask("a")], d);
    const result = suggest(s);
    assert.equal(result, null);
  });
});

test("suggest proposes +1 parallelism when independent tasks > current", async () => {
  await fixture(async (s, d, baseline) => {
    // fixture recipe has parallelism=1, run 3 times with 4 independent tasks
    for (let i = 0; i < 3; i++) await runTasks(s, [fixtureTask("a"), fixtureTask("b"), fixtureTask("c"), fixtureTask("d")], d);
    const result = suggest(s);
    assert.ok(result);
    assert.equal(s.recipe(result).parallelism, 2); // 1 + 1
    assert.equal(s.active(), baseline);
  });
});

test("evaluate rejects candidate not child of active baseline", async () => {
  await fixture(async (s, d, baseline) => {
    // baseline has parallelism=1, so use 3 for otherParent to avoid no-op
    const otherParent = s.propose({ parallelism: 3 });
    s.setMeta("active", otherParent);
    const candidate = s.propose({ parallelism: 4 });
    s.setMeta("active", baseline);
    await assert.rejects(evaluate(s, candidate, protocol(), d), /child of active/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. CONCURRENCY: parallel execution, lease isolation
// ═══════════════════════════════════════════════════════════════════════════════

test("two schedulers on the same store claim different tasks", async () => {
  await fixture(async (s) => {
    // Use parallelism=2 recipe so two tasks can be claimed concurrently
    const recipe2 = s.propose({ parallelism: 2 });
    s.setMeta("active", recipe2);
    const q = new Scheduler(s);
    const run = q.start([fixtureTask("a"), fixtureTask("b")], recipe2);
    const lease1 = q.claim(run, "process-1");
    const lease2 = q.claim(run, "process-2");
    assert.ok(lease1);
    assert.ok(lease2);
    assert.notEqual(lease1!.taskId, lease2!.taskId);
  });
});

test("lease from one owner cannot be finished by another", async () => {
  await fixture(async (s) => {
    const q = new Scheduler(s);
    const run = q.start([fixtureTask("a")]);
    const lease = q.claim(run, "owner1");
    assert.ok(lease);
    const fakeLease = { ...lease!, owner: "owner2" };
    const result = q.finish(fakeLease, { x: 1 }, makeEvidence(s, fixtureTask("a"), { x: 1 }, { durationMs: 1, tokens: 0, costUsd: 0 }), { durationMs: 1, tokens: 0, costUsd: 0 });
    assert.equal(result, false);
  });
});

test("expired lease is reclaimed by next claim with incremented fence", async () => {
  await fixture(async (s) => {
    const q = new Scheduler(s);
    const run = q.start([fixtureTask("a")]);
    const lease1 = q.claim(run, "owner1");
    assert.ok(lease1);
    s.db.prepare("UPDATE tasks SET deadline=? WHERE run=? AND id=?").run(1, run, "a");
    const lease2 = q.claim(run, "owner2");
    assert.ok(lease2);
    assert.equal(lease2!.fence, lease1!.fence + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. STRESS: many tasks, deep DAGs
// ═══════════════════════════════════════════════════════════════════════════════

test("stress: 50 independent tasks complete", async () => {
  await fixture(async (s, d) => {
    const tasks = Array.from({ length: 50 }, (_, i) => fixtureTask(`t${i}`));
    const result = await runTasks(s, tasks, d);
    assert.equal(result.status, "PASS");
    assert.equal(result.accepted, 50);
  });
});

test("stress: diamond DAG (1→10→1) completes", async () => {
  await fixture(async (s, d) => {
    const root = fixtureTask("root");
    const middles = Array.from({ length: 10 }, (_, i) => fixtureTask(`m${i}`, ["root"]));
    const leaf = fixtureTask("leaf", middles.map(m => m.id));
    const result = await runTasks(s, [root, ...middles, leaf], d);
    assert.equal(result.status, "PASS");
    assert.equal(result.accepted, 12);
  });
});

test("stress: linear chain of 20 tasks completes", async () => {
  await fixture(async (s, d) => {
    const tasks: Task[] = [];
    for (let i = 0; i < 20; i++) tasks.push(fixtureTask(`t${i}`, i === 0 ? [] : [`t${i - 1}`]));
    const result = await runTasks(s, tasks, d);
    assert.equal(result.status, "PASS");
    assert.equal(result.accepted, 20);
  });
});

test("stress: 100 tasks with mixed DAG completes", async () => {
  await fixture(async (s, d) => {
    const tasks: Task[] = [];
    for (let i = 0; i < 100; i++) {
      const deps = i < 5 ? [] : [`t${i - 1}`];
      tasks.push(fixtureTask(`t${i}`, deps));
    }
    const result = await runTasks(s, tasks, d);
    assert.equal(result.status, "PASS");
    assert.equal(result.accepted, 100);
  });
});
