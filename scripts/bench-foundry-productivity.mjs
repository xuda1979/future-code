#!/usr/bin/env node
/** Synthetic harness measurements, NOT a live-model coding benchmark.
 * Node >=22.16: node --experimental-strip-types scripts/bench-foundry-productivity.mjs
 * Compare an old source snapshot using --runtime-root PATH --overhead-only.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < argv.length; i++) {
  const key = argv[i];
  assert.ok(["--runtime-root", "--tasks", "--repetitions", "--overhead-only"].includes(key), `unknown option ${key}`);
  assert.ok(!options.has(key), `duplicate option ${key}`);
  if (key === "--overhead-only") options.set(key, true);
  else {
    const value = argv[++i]; assert.ok(value && !value.startsWith("--"), `missing value for ${key}`);
    options.set(key, value);
  }
}
const root = resolve(options.get("--runtime-root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const count = Number(options.get("--tasks") ?? 1000);
const repetitions = Number(options.get("--repetitions") ?? 3);
assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 10000, "--tasks must be 1..10000");
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 10, "--repetitions must be 1..10");
const load = name => import(pathToFileURL(join(root, "src/harness/foundry", name)).href);
const { Store } = await load("store.ts");
const { Scheduler } = await load("scheduler.ts");
const { runTasks } = await load("runtime.ts");
const { canonical, digest } = await load("kernel.ts");
const contract = { schema: 1, name: "synthetic-productivity", workerId: "synthetic-worker-v1", verifierId: "arithmetic-check-v1",
  environmentId: `node-${process.version}-${process.platform}-${process.arch}`, requiredChecks: ["correct"], slos: [],
  limits: { parallelism: 32, attempts: 1, contextBytes: 65536, outputBytes: 1048576, timeoutMs: 60000, tasks: 10000 } };
const recipe = { parallelism: 8, attempts: 1, contextBytes: 65536, timeoutMs: 60000 };
const zero = { tokens: 0, costUsd: 0 }; // No model calls: genuine zero for this synthetic adapter.
const task = (id, more = {}) => ({ id, goal: `Compute ${id}`, acceptance: ["independent arithmetic check"],
  input: null, dependencies: [], writeScope: [`src/${id}`], ...more });
async function withStore(p, fn) {
  const path = mkdtempSync(join(tmpdir(), "foundry-productivity-bench-")); const s = await Store.open(path);
  try { s.initialize(contract, p); return await fn(s); }
  finally { s.close(); rmSync(path, { recursive: true, force: true }); }
}
function accept(q, lease, task, artifact, now) {
  assert.equal(q.finish(lease, artifact, {
    contractHash: lease.contractHash, recipeHash: lease.recipeHash, verifierId: contract.verifierId,
    taskHash: digest(task), artifactHash: digest(artifact), metrics: { ...zero, durationMs: 1 },
    verification: { artifactHash: digest(artifact), checks: [{ id: "correct", verdict: "PASS" }] },
  }, zero, now), true);
}
async function schedule(scheduling) {
  const tasks = [...Array.from({ length: 64 }, (_, i) => task(`a${String(i).padStart(3, "0")}`, { estimatedDurationMs: 20 })),
    ...Array.from({ length: 8 }, (_, i) => task(`z${i}`, { estimatedDurationMs: 20, dependencies: i ? [`z${i - 1}`] : [] }))];
  return withStore({ ...recipe, scheduling }, s => {
    const q = new Scheduler(s); const start = Date.now(); let clock = start; let peak = 0;
    const run = q.start(tasks, s.active(), start); const byId = new Map(tasks.map(t => [t.id, t])); const active = [];
    while (true) {
      for (const lease of q.claimMany(run, "virtual-clock", 8, clock)) active.push({ lease, end: clock + byId.get(lease.taskId).estimatedDurationMs });
      peak = Math.max(peak, active.length);
      if (!active.length) break;
      clock = Math.min(...active.map(a => a.end));
      for (let i = active.length - 1; i >= 0; i--) if (active[i].end === clock) {
        const { lease } = active.splice(i, 1)[0]; const spec = byId.get(lease.taskId);
        accept(q, lease, spec, { answer: spec.estimatedDurationMs }, clock);
      }
    }
    const summary = q.summary(run, clock); assert.equal(summary.status, "PASS"); assert.equal(summary.accepted, 72);
    return { scheduling, taskHash: digest(tasks), taskCount: 72, workers: 8, peak,
      makespanVirtualMs: clock - start, lowerBoundVirtualMs: Math.max(72 * 20 / 8, 8 * 20), accepted: summary.accepted };
  });
}
async function contextViews() {
  return withStore(recipe, s => {
    const q = new Scheduler(s); const source = { api: { name: "add", parameters: ["a", "b"], returns: "number" },
      compilerLog: "irrelevant diagnostics\n".repeat(2200) };
    const a = task("interface"); const b = task("inline", { dependencies: [a.id] });
    const c = task("view", { dependencies: [a.id], dependencyViews: { interface: ["/api"] } });
    const run = q.start([a, b, c]); accept(q, q.claim(run, "source"), a, source, Date.now());
    const capsules = q.claimMany(run, "consumers", 2).map(l => q.capsule(l));
    const full = capsules.find(c => c.task.id === "inline"); const view = capsules.find(c => c.task.id === "view");
    assert.deepEqual(full.dependencies[0].artifact.api, view.dependencies[0].artifact["/api"]);
    assert.equal(full.dependencies[0].artifactHash, view.dependencies[0].artifactHash);
    const inlineBytes = Buffer.byteLength(canonical(full)); const projectedBytes = Buffer.byteLength(canonical(view));
    return { kind: "serialized worker input; not billed tokens", inlineBytes, projectedBytes,
      reduction: 1 - projectedBytes / inlineBytes, requiredApiEqual: true, sourceHash: digest(source) };
  });
}
async function overhead() {
  const tasks = Array.from({ length: count }, (_, i) => task(`t${String(i).padStart(5, "0")}`, { input: i % 31 }));
  const samples = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    samples.push(await withStore({ ...recipe, parallelism: 16, contextBytes: 4096 }, async s => {
      let running = 0; let peak = 0;
      const d = { workerId: contract.workerId, verifierId: contract.verifierId,
        async execute(capsule) {
          running++; peak = Math.max(peak, running);
          await new Promise(resolve => setTimeout(resolve, 1)); running--;
          return { artifact: { square: capsule.task.input * capsule.task.input }, measurement: zero };
        },
        async verify(capsule, result) {
          // Recompute without the producer's multiplication expression.
          let expected = 0; for (let i = 1; i <= capsule.task.input; i++) expected += 2 * i - 1;
          return { artifactHash: digest(result.artifact), checks: [{ id: "correct", verdict: result.artifact.square === expected ? "PASS" : "FAIL" }], measurement: zero };
        } };
      const started = performance.now(); const result = await runTasks(s, tasks, d); const elapsedMs = performance.now() - started;
      assert.equal(result.status, "PASS"); assert.equal(result.accepted, count); assert.equal(result.attempts, count);
      return { repetition, elapsedMs, verifiedTasksPerSecond: count * 1000 / elapsedMs, peak, accepted: result.accepted };
    }));
  }
  const sorted = samples.map(s => s.elapsedMs).sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  return { kind: "real-clock synthetic arithmetic workers; includes SQLite and artifact I/O", count,
    taskHash: digest(tasks), repetitions, samples, medianMs, medianVerifiedTasksPerSecond: count * 1000 / medianMs };
}
const files = ["types.ts", "kernel.ts", "store.ts", "scheduler.ts", "runtime.ts", "commands.ts"];
if (existsSync(join(root, "src/harness/foundry/productivity.ts"))) files.push("productivity.ts");
const sourceHashes = Object.fromEntries(files.map(f => [f, createHash("sha256").update(readFileSync(join(root, "src/harness/foundry", f))).digest("hex")]));
const report = { schema: 1, generatedAt: new Date().toISOString(), modelCalls: 0,
  runtime: { node: process.version, platform: process.platform, arch: process.arch }, sourceHashes };
if (!options.has("--overhead-only")) {
  report.scheduling = { priority: await schedule("priority"), criticalPath: await schedule("critical-path") };
  assert.equal(report.scheduling.priority.taskHash, report.scheduling.criticalPath.taskHash);
  report.contextViews = await contextViews();
}
report.overhead = await overhead();
console.log(JSON.stringify(report, null, 2));
