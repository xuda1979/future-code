import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { validateTasks, validateRecipe } from "../../src/harness/foundry/kernel.ts";
import type { Contract, Recipe, Task } from "../../src/harness/foundry/types.ts";

import { writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { criticalPathRanks, accessConflicts, compilePlan, projectDependency, ProgressWindow } from "../../src/harness/foundry/productivity.ts";
import { allocateContext, canonical, digest } from "../../src/harness/foundry/kernel.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { invoke, pinCommand, CommandDriver } from "../../src/harness/foundry/commands.ts";
import type { AttemptControl, Driver, Json, Lease, PinnedCommand } from "../../src/harness/foundry/types.ts";


const contract: Contract = {
  schema: 1, name: "productivity-tests", workerId: "worker-v1", verifierId: "check-v1", environmentId: "fixture-v1",
  requiredChecks: ["correct"], slos: [],
  limits: { parallelism: 32, attempts: 5, contextBytes: 16384, outputBytes: 1048576, timeoutMs: 10000, tasks: 20000 },
};
const recipe: Recipe = { parallelism: 4, attempts: 2, contextBytes: 4096, timeoutMs: 5000 };
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, goal: `Implement ${id}`, acceptance: ["independent test passes"], dependencies: [], writeScope: [`src/${id}`], input: null, ...extra,
});
async function fixture(fn: (s: Store) => void | Promise<void>, p: Recipe = recipe, c: Contract = contract) {
  const root = mkdtempSync(join(tmpdir(), "foundry-productivity-test-"));
  const s = await Store.open(root);
  try { s.initialize(c, p); await fn(s); } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
}

test("reject non-integral task context budgets before starting a worker", () => {
  for (const contextBudget of [0, -1, 0.5, contract.limits.contextBytes + 1]) {
    assert.throws(() => validateTasks(contract, [task("a", { contextBudget })]), /context/i);
  }
});

test("priority weighting cannot exceed the immutable contract ceiling", async () => {
  const c = { ...contract, limits: { ...contract.limits, contextBytes: 1024 } };
  const p = { ...recipe, contextBytes: 1024, priorityContextShare: 0.5 };
  await fixture(s => {
    const scheduler = new Scheduler(s);
    const run = scheduler.start([task("a", { priority: 10, goal: "x".repeat(750) }), task("b")]);
    const lease = scheduler.claim(run, "test")!;
    assert.equal(lease.taskId, "a");
    assert.throws(() => scheduler.capsule(lease), /CONTEXT_OVERFLOW/);
  }, p, c);
});

test("validate read scopes, duration estimates and explicit dependency views", () => {
  for (const extra of [
    { readScope: ["../secret"] }, { estimatedDurationMs: 0 },
    { dependencyViews: { missing: ["/api"] } },
  ]) assert.throws(() => validateTasks(contract, [task("a", extra)]));
});

test("new recipe controls reject unsafe settings", () => {
  for (const extra of [
    { scheduling: "random" }, { maxInFlightContextBytes: 0 },
    { noProgressMs: recipe.timeoutMs + 1 }, { maxRepeatedFailures: 0 },
  ]) assert.throws(() => validateRecipe(contract, { ...recipe, ...extra } as Recipe));
});


const zero = { tokens: 0, costUsd: 0 };
function accept(q: Scheduler, lease: Lease, artifact: Json = { answer: 4 }, now = Date.now()) {
  const spec: Task = JSON.parse(q.store.db.prepare("SELECT spec FROM tasks WHERE run=? AND id=?").get(lease.runId, lease.taskId)!.spec);
  return q.finish(lease, artifact, {
    contractHash: lease.contractHash, recipeHash: lease.recipeHash, verifierId: q.store.contract().verifierId,
    taskHash: digest(spec), artifactHash: digest(artifact), metrics: { ...zero, durationMs: 1 },
    verification: { artifactHash: digest(artifact), checks: [{ id: "correct", verdict: "PASS" }] },
  }, zero, now);
}
function driver(): Driver {
  return { workerId: contract.workerId, verifierId: contract.verifierId,
    async execute() { return { artifact: { answer: 4 }, measurement: zero }; },
    async verify(_capsule, result) {
      const correct = (result.artifact as { answer?: number })?.answer === 2 + 2;
      return { artifactHash: digest(result.artifact), checks: [{ id: "correct", verdict: correct ? "PASS" : "FAIL" }], measurement: zero };
    },
  };
}
const names = (leases: Lease[]) => leases.map(l => l.taskId);

test("critical-path rank includes downstream duration, not only a task's own duration", () => {
  const tasks = [task("a", { estimatedDurationMs: 7 }), task("z", { estimatedDurationMs: 2 }),
    task("z1", { dependencies: ["z"], estimatedDurationMs: 10 }), task("join", { dependencies: ["a", "z1"], estimatedDurationMs: 3 })];
  const ranks = criticalPathRanks(tasks);
  assert.deepEqual(Object.fromEntries(ranks), { join: 3, z1: 13, z: 15, a: 10 });
  assert.deepEqual(compilePlan(tasks, { ...recipe, scheduling: "critical-path" }, 16384).order.map(t => t.id), ["z", "z1", "a", "join"]);
});
test("critical-path fallback handles 10000-node chains without recursion", () => {
  const tasks = Array.from({ length: 10000 }, (_, i) => task(`t${i}`, { dependencies: i ? [`t${i - 1}`] : [] }));
  const ranks = criticalPathRanks(tasks);
  assert.equal(ranks.get("t0"), 10000); assert.equal(ranks.get("t9999"), 1);
  assert.throws(() => criticalPathRanks([task("a", { dependencies: ["b"] }), task("b", { dependencies: ["a"] })]), /cycle/);
  assert.throws(() => criticalPathRanks([task("a", { dependencies: ["missing"] })]), /unknown/);
  assert.throws(() => criticalPathRanks([task("a"), task("a")]), /duplicate/);
});
test("batch claims prioritize the critical path and still respect explicit priorities", async () => {
  await fixture(s => {
    const q = new Scheduler(s);
    const tasks = [task("a"), task("z"), task("z1", { dependencies: ["z"] }), task("urgent", { priority: 100 })];
    const run = q.start(tasks);
    assert.deepEqual(names(q.claimMany(run, "owner", 2)), ["urgent", "z"]);
    assert.deepEqual(names(q.claimMany(run, "other", 32)), ["a"]);
  }, { ...recipe, scheduling: "critical-path" });
});
test("legacy ordering is unchanged when critical-path scheduling is omitted", async () => {
  await fixture(s => {
    const q = new Scheduler(s); const run = q.start([task("a"), task("z"), task("z1", { dependencies: ["z"] })]);
    assert.deepEqual(names(q.claimMany(run, "worker", 4)), ["a", "z"]);
    assert.throws(() => q.claimMany(run, "worker", 0), /batch/);
    assert.throws(() => q.claimMany(run, "worker", 257), /batch/);
  });
});
test("read/write exclusion is symmetric; read/read and sibling paths are independent", () => {
  const reader = task("r", { readScope: ["src/shared"], writeScope: [] });
  const writer = task("w", { writeScope: ["src/shared/file.ts"] });
  assert.equal(accessConflicts(reader, writer), true); assert.equal(accessConflicts(writer, reader), true);
  assert.equal(accessConflicts(reader, reader), false);
  assert.equal(accessConflicts(reader, task("other", { writeScope: ["src/shared2"] })), false);
});
test("separate connections respect the aggregate context ceiling and intra-batch scopes", async () => {
  await fixture(async s => {
    const other = await Store.open(s.root);
    try {
      const q = new Scheduler(s); const r = new Scheduler(other);
      const run = q.start([task("a", { readScope: ["src/shared"], writeScope: [] }),
        task("b", { readScope: ["src/shared/one"], writeScope: [] }),
        task("c", { writeScope: ["src/shared"] }), task("d")]);
      const first = q.claimMany(run, "one", 32);
      assert.deepEqual(names(first), ["a", "b"]);
      assert.deepEqual(r.claimMany(run, "two", 32), []);
      assert.equal(accept(q, first[0]), true);
      assert.deepEqual(names(r.claimMany(run, "two", 32)), ["d"]);
      assert.equal(accept(q, first[1]), true);
      assert.deepEqual(names(q.claimMany(run, "one", 32)), ["c"]);
    } finally { other.close(); }
  }, { ...recipe, maxInFlightContextBytes: 8192 });
});
test("an impossible context reservation fails before persisting a run", async () => {
  await fixture(s => {
    assert.throws(() => new Scheduler(s).start([task("a")]), /cannot admit/);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 0);
  }, { ...recipe, maxInFlightContextBytes: 1024 });
});
test("explicit and weighted budgets always fit the contract ceiling", () => {
  for (const priorityContextShare of [0, 0.1, 0.5, 0.99, 1]) {
    const tasks = [task("a", { priority: 5 }), task("b"), task("c", { contextBudget: 16000 })];
    const budgets = allocateContext(tasks, { ...recipe, priorityContextShare }, 4096);
    for (const n of budgets.values()) assert.ok(n > 0 && n <= 4096 && Number.isInteger(n));
  }
});
test("explicit dependency views preserve escaped keys, arrays, null and root values", () => {
  const source = { "a/b": { "~x": [null, { value: 7 }] }, toString: "own" };
  const projected = projectDependency(source, ["/a~1b/~0x/0", "/a~1b/~0x/1/value", "/toString", ""]);
  assert.equal((projected as Record<string, Json>)["/a~1b/~0x/0"], null);
  assert.equal((projected as Record<string, Json>)["/a~1b/~0x/1/value"], 7);
  assert.deepEqual((projected as Record<string, Json>)[""], source);
  for (const pointer of ["/missing", "/a~1b/~0x/01", "/a~1b/~0x/length", "/constructor", "/a~2b"]) {
    assert.throws(() => projectDependency(source, [pointer]), /DEPENDENCY_VIEW/);
  }
});
test("projected capsules retain full source hashes, exact values and measured input bytes", async () => {
  await fixture(s => {
    const q = new Scheduler(s);
    const run = q.start([task("a"), task("b", { dependencies: ["a"], dependencyViews: { a: ["/api"] } })]);
    const source = { api: { signature: "sum(a: number, b: number): number" }, logs: "verbose ".repeat(2000) };
    assert.equal(accept(q, q.claim(run, "one")!, source), true);
    const lease = q.claim(run, "two")!; const capsule = q.capsule(lease); const dep = capsule.dependencies[0];
    assert.equal(dep.artifactHash, digest(source)); assert.equal(dep.view!.hash, digest(dep.artifact));
    assert.deepEqual((dep.artifact as Record<string, Json>)["/api"], source.api);
    const bytes = Buffer.byteLength(canonical(capsule));
    assert.ok(bytes < Buffer.byteLength(canonical(source)) / 5);
    assert.equal(s.db.prepare("SELECT context_bytes FROM attempt_telemetry WHERE run=? AND task=? AND fence=?").get(run, "b", 1)!.context_bytes, bytes);
    assert.deepEqual(s.readArtifact(dep.artifactHash), source);
    writeFileSync(join(s.root, "artifacts", `${dep.artifactHash}.json`), '{"api":"tampered"}');
    assert.throws(() => q.capsule(lease), /integrity/);
  });
});
test("unselected dependency output is still inline by default", async () => {
  await fixture(s => {
    const q = new Scheduler(s); const run = q.start([task("a"), task("b", { dependencies: ["a"] })]);
    accept(q, q.claim(run, "one")!, { api: 3, notes: "keep" });
    const dep = q.capsule(q.claim(run, "two")!).dependencies[0];
    assert.deepEqual(dep.artifact, { api: 3, notes: "keep" }); assert.equal(dep.view, undefined);
  });
});
test("missing projected fields fail closed without wasting repeated worker calls", async () => {
  await fixture(async s => {
    const d = driver(); let calls = 0;
    d.execute = async () => { calls++; return { artifact: { answer: 4 } }; };
    const result = await runTasks(s, [task("a"), task("b", { dependencies: ["a"], dependencyViews: { a: ["/missing"] } }),
      task("c", { dependencies: ["b"] })], d);
    assert.equal(calls, 1); assert.equal(result.status, "FAIL");
    assert.equal(result.accepted, 1); assert.equal(result.blocked, 1); assert.equal(result.attempts, 2);
  }, { ...recipe, attempts: 5 });
});
test("batch expiry fences stale progress and output before replacement starts", async () => {
  await fixture(s => {
    const q = new Scheduler(s); const run = q.start([task("a"), task("b")]); const now = Date.now();
    const old = q.claimMany(run, "old", 4, now);
    const fresh = q.claimMany(run, "new", 4, now + recipe.timeoutMs + 1);
    assert.equal(fresh.length, 2); assert.equal(fresh[0].fence, 2);
    assert.equal(q.progress(old[0], "late", now + recipe.timeoutMs + 2), false);
    assert.equal(q.finish(old[0], {}, {}, zero, now + recipe.timeoutMs + 2), false);
    assert.equal(accept(q, fresh[0], { answer: 4 }, now + recipe.timeoutMs + 2), true);
  });
});
test("progress cannot bypass verification or unblock downstream work", async () => {
  await fixture(s => {
    const q = new Scheduler(s); const run = q.start([task("a"), task("b", { dependencies: ["a"] })]);
    const lease = q.claim(run, "one")!;
    assert.equal(q.progress(lease, "tests-started"), true);
    assert.equal(q.claim(run, "two"), null); assert.equal(q.summary(run).accepted, 0);
    assert.throws(() => q.finish(lease, {}, {}, zero), /evidence/);
    accept(q, lease); assert.equal(q.claim(run, "two")!.taskId, "b");
  });
});
test("repeated failure accounting survives a new connection and stops wasted retries", async () => {
  await fixture(async s => {
    const q = new Scheduler(s); const run = q.start([task("a"), task("b", { dependencies: ["a"] })]);
    q.fail(q.claim(run, "one")!, "same error");
    const other = await Store.open(s.root);
    try {
      const r = new Scheduler(other); r.fail(r.claim(run, "two")!, "same error");
      assert.equal(r.claim(run, "three"), null);
      assert.equal(r.summary(run).attempts, 2); assert.equal(r.summary(run).blocked, 1);
    } finally { other.close(); }
  }, { ...recipe, attempts: 5, maxRepeatedFailures: 2 });
});
test("changing rejected candidates are not mistaken for an unchanged failure", async () => {
  await fixture(async s => {
    const d = driver(); let calls = 0;
    d.execute = async () => ({ artifact: { answer: ++calls } });
    const result = await runTasks(s, [task("a")], d);
    assert.equal(result.status, "PASS"); assert.equal(result.attempts, 4);
  }, { ...recipe, attempts: 5, maxRepeatedFailures: 2 });
});
test("identical rejected candidate and check evidence stop at the configured limit", async () => {
  await fixture(async s => {
    const d = driver(); d.execute = async () => ({ artifact: { answer: -1 } });
    const result = await runTasks(s, [task("a")], d);
    assert.equal(result.status, "FAIL"); assert.equal(result.attempts, 2);
  }, { ...recipe, attempts: 5, maxRepeatedFailures: 2 });
});
test("terminal failures propagate through a deep DAG without recursive scans", async () => {
  await fixture(s => {
    const tasks = Array.from({ length: 1000 }, (_, i) => task(`t${i}`, { dependencies: i ? [`t${i - 1}`] : [] }));
    const q = new Scheduler(s); const run = q.start(tasks); const lease = q.claim(run, "one")!;
    q.fail(lease, "fatal", zero, Date.now(), { retryable: false });
    assert.deepEqual(q.claimMany(run, "two", 4), []);
    assert.equal(q.summary(run).blocked, 999); assert.equal(q.status(run), "FAIL");
  });
});
test("novelty detector rejects alternating repeats and caps retained fingerprints", () => {
  const window = new ProgressWindow(0);
  assert.equal(window.observe("a", 10), true); assert.equal(window.observe("b", 20), true);
  assert.equal(window.observe("a", 30), false); assert.equal(window.observe("b", 40), false);
  assert.equal(window.idleMs(50), 30);
  assert.throws(() => window.observe("", 51)); assert.throws(() => window.observe("x".repeat(257), 51));
  for (let i = 0; i < 1022; i++) assert.equal(window.observe(`new-${i}`, 60), true);
  assert.equal(window.observe("overflow", 80), false); assert.equal(window.idleMs(100), 40);
});
test("no-progress deadline cancels an unresponsive worker before the hard deadline", async () => {
  await fixture(async s => {
    const d = driver(); let cancelled = false; let verifications = 0;
    d.execute = async (_c, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => {
      cancelled = true; reject(signal.reason);
    }, { once: true }));
    d.verify = async () => { verifications++; throw new Error("should not reach verifier"); };
    const result = await runTasks(s, [task("a")], d);
    assert.equal(result.status, "FAIL"); assert.equal(cancelled, true); assert.equal(verifications, 0);
    assert.match(s.db.prepare("SELECT error FROM tasks WHERE run=?").get(result.id)!.error, /NO_PROGRESS: execute/);
  }, { ...recipe, attempts: 1, noProgressMs: 60, timeoutMs: 2000 });
});
test("no-progress control also bounds a hung verifier", async () => {
  await fixture(async s => {
    const d = driver(); d.verify = async () => new Promise(() => {});
    const result = await runTasks(s, [task("a")], d);
    assert.equal(result.status, "FAIL");
    assert.match(s.db.prepare("SELECT error FROM tasks WHERE run=?").get(result.id)!.error, /NO_PROGRESS: verify/);
  }, { ...recipe, attempts: 1, noProgressMs: 60 });
});
test("distinct progress keeps a real attempt alive; post-completion callbacks are ignored", async () => {
  await fixture(async s => {
    const d = driver(); let lastControl: AttemptControl | undefined;
    d.execute = async (_c, signal, control) => {
      lastControl = control;
      for (let i = 0; i < 4; i++) { await delay(35, undefined, { signal }); control!.progress(`artifact-${i}`); }
      return { artifact: { answer: 4 } };
    };
    const result = await runTasks(s, [task("a")], d);
    assert.equal(result.status, "PASS");
    assert.equal(s.db.prepare("SELECT progress_count FROM attempt_telemetry WHERE run=?").get(result.id)!.progress_count, 4);
    lastControl!.progress("late");
    assert.equal(s.db.prepare("SELECT progress_count FROM attempt_telemetry WHERE run=?").get(result.id)!.progress_count, 4);
  }, { ...recipe, attempts: 1, noProgressMs: 100 });
});
test("repeating the same heartbeat does not keep a stalled attempt alive", async () => {
  await fixture(async s => {
    const d = driver();
    d.execute = async (_c, signal, control) => {
      while (!signal.aborted) { control!.progress("same"); await delay(10, undefined, { signal }); }
      return { artifact: { answer: 4 } };
    };
    const result = await runTasks(s, [task("a")], d);
    assert.equal(result.status, "FAIL");
    assert.equal(s.db.prepare("SELECT progress_count FROM attempt_telemetry WHERE run=?").get(result.id)!.progress_count, 1);
  }, { ...recipe, attempts: 1, noProgressMs: 70 });
});
test("novel progress never extends the absolute attempt deadline", async () => {
  await fixture(async s => {
    const d = driver(); let count = 0;
    d.execute = async (_c, signal, control) => {
      while (!signal.aborted) { control!.progress(`new-${count++}`); await delay(15, undefined, { signal }); }
      return { artifact: { answer: 4 } };
    };
    const result = await runTasks(s, [task("a")], d);
    assert.equal(result.status, "FAIL"); assert.equal(result.attempts, 1); assert.ok(count > 1);
  }, { ...recipe, attempts: 1, noProgressMs: 80, timeoutMs: 200 });
});
test("many workers use one caller cancellation listener and release it", async () => {
  await fixture(async s => {
    const controller = new AbortController(); const d = driver(); let started = 0; let maxListeners = 0;
    d.execute = async (_c, signal) => {
      maxListeners = Math.max(maxListeners, getEventListeners(controller.signal, "abort").length);
      if (++started === 24) queueMicrotask(() => controller.abort());
      await delay(2000, undefined, { signal }); return { artifact: { answer: 4 } };
    };
    const result = await runTasks(s, Array.from({ length: 24 }, (_, i) => task(`t${i}`)), d, { signal: controller.signal });
    assert.equal(started, 24); assert.equal(result.accepted, 0); assert.equal(result.status, "RUNNING");
    assert.equal(maxListeners, 1); assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }, { ...recipe, parallelism: 24 });
});
test("a fast verified dependency releases its child before unrelated slow work completes", async () => {
  await fixture(async s => {
    const d = driver(); let releaseSlow!: () => void; const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    let childRan = false;
    d.execute = async (c, signal) => {
      if (c.task.id === "slow") await Promise.race([slow, delay(2000, undefined, { signal })]);
      if (c.task.id === "child") { childRan = true; releaseSlow(); }
      return { artifact: { answer: 4 } };
    };
    const result = await runTasks(s, [task("fast"), task("slow"), task("child", { dependencies: ["fast"] })], d);
    assert.equal(result.status, "PASS"); assert.equal(childRan, true);
  }, { ...recipe, parallelism: 2 });
});

async function commandFixture(code: string, fn: (p: PinnedCommand) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "foundry-progress-command-")); const file = join(root, "worker.mjs");
  writeFileSync(file, code);
  try { await fn(pinCommand({ argv: [process.execPath, file] }, root)); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
test("subprocess progress protocol tolerates split UTF-8 and final line without newline", async () => {
  await commandFixture(`
    const line = Buffer.from('FUTURE_CODE_PROGRESS {"fingerprint":"check-\\u03bb"}');
    const split = line.indexOf(Buffer.from('\\u03bb')) + 1;
    process.stderr.write(line.subarray(0, split));
    setTimeout(() => { process.stderr.write(line.subarray(split)); console.log('{}'); }, 20);
  `, async p => {
    const seen: string[] = []; const result = await invoke(p, {}, 4096, AbortSignal.timeout(2000), { progress: s => { seen.push(s); } });
    assert.deepEqual(result, {}); assert.deepEqual(seen, ["check-\u03bb"]);
  });
});
test("malformed progress is rejected rather than silently refreshing the timer", async () => {
  await commandFixture(`process.stderr.write('FUTURE_CODE_PROGRESS {bad}\\n'); console.log('{}');`, async p => {
    await assert.rejects(invoke(p, {}, 4096, AbortSignal.timeout(2000), { progress() { throw new Error("must not call"); } }));
  });
});
test("ordinary stderr logs are not progress and progress records still consume output budget", async () => {
  await commandFixture(`process.stderr.write('compiling...\\n'); console.log('{}');`, async p => {
    let count = 0; await invoke(p, {}, 4096, AbortSignal.timeout(2000), { progress() { count++; } }); assert.equal(count, 0);
  });
  await commandFixture(`process.stderr.write(('FUTURE_CODE_PROGRESS {"fingerprint":"x"}\\n').repeat(100)); console.log('{}');`, async p => {
    await assert.rejects(invoke(p, {}, 100, AbortSignal.timeout(2000), { progress() {} }), /byte budget/);
  });
});
test("command driver forwards progress but continues to distrust child usage claims", async () => {
  await commandFixture(`process.stderr.write('FUTURE_CODE_PROGRESS {"fingerprint":"test-pass"}\\n');
    console.log(JSON.stringify({artifact:{answer:4},measurement:{tokens:0,costUsd:0}}));`, async p => {
    const d = new CommandDriver(p, p, 4096); const seen: string[] = [];
    const result = await d.execute({ schema: 1, runId: "r", task: task("a"), fence: 1, recipeHash: "p", contractHash: "c", dependencies: [] },
      AbortSignal.timeout(2000), { progress: s => { seen.push(s); } });
    assert.deepEqual(seen, ["test-pass"]); assert.deepEqual(result.measurement, { tokens: null, costUsd: null });
  });
});


test("remote completion wakes spare local slots before a local straggler ends", async () => {
  await fixture(async s => {
    const q = new Scheduler(s);
    const tasks = [task("remote", { priority: 100 }), task("slow", { priority: 50 }), task("child", { dependencies: ["remote"] })];
    const run = q.start(tasks); const remote = q.claim(run, "other-process")!;
    let releaseSlow!: () => void; const wait = new Promise<void>(resolve => { releaseSlow = resolve; });
    const d = driver(); let childRan = false;
    d.execute = async (c, signal) => {
      if (c.task.id === "slow") {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          void wait.then(() => { signal.removeEventListener("abort", abort); resolve(); });
        });
      }
      if (c.task.id === "child") { childRan = true; releaseSlow(); }
      return { artifact: { answer: 4 } };
    };
    const outcome = runTasks(s, [], d, { resumeRun: run });
    await delay(20); assert.equal(accept(q, remote), true);
    const result = await outcome;
    assert.equal(result.status, "PASS"); assert.equal(childRan, true);
    assert.equal(result.accepted, 3); assert.equal(result.attempts, 3);
  }, { ...recipe, parallelism: 2, attempts: 1, timeoutMs: 2000 });
});
