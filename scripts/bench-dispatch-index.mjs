#!/usr/bin/env node
/** Synthetic SQL/workspace-planning measurements, not live-model productivity.
 * node --experimental-strip-types scripts/bench-dispatch-index.mjs --baseline PATH
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const current = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = new Map();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const key = argv[i], value = argv[++i];
  assert.ok(["--baseline", "--sizes", "--samples", "--iterations"].includes(key) && !options.has(key), `invalid option ${key}`);
  assert.ok(value && !value.startsWith("--"), `missing ${key}`); options.set(key, value);
}
const sizes = String(options.get("--sizes") ?? "1000,10000").split(",").map(Number);
const samples = Number(options.get("--samples") ?? 9), iterations = Number(options.get("--iterations") ?? 20);
assert.ok(sizes.length <= 6 && sizes.every(n => Number.isSafeInteger(n) && n >= 4 && n <= 100000), "sizes must be 4..100000");
assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 31, "samples must be 3..31");
assert.ok(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 100, "iterations must be 1..100");
const roots = options.has("--baseline") ? { baseline: resolve(options.get("--baseline")), candidate: current } : { candidate: current };
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
function measure(work) {
  for (let i = 0; i < 5; i++) work();
  const perCallMs = [];
  for (let sample = 0; sample < samples; sample++) {
    const before = performance.now();
    for (let i = 0; i < iterations; i++) work();
    perCallMs.push((performance.now() - before) / iterations);
  }
  return { medianMs: median(perCallMs), perCallMs, iterationsPerSample: iterations };
}
const reference = `SELECT t.id,t.spec,t.fence,n.priority,n.rank,n.budget
  FROM scheduler_nodes n JOIN tasks t ON t.run=n.run AND t.id=n.task
  LEFT JOIN task_waits w ON w.run=t.run AND w.task=t.id
  LEFT JOIN fabric_allocations a ON a.run=t.run AND a.task=t.id
  WHERE n.run=? AND n.remaining=0 AND t.status='READY' AND (w.wake IS NULL OR w.wake<=?)
  ORDER BY n.priority DESC,COALESCE(a.score,0) DESC,n.rank DESC,t.id LIMIT ? OFFSET ?`;

async function benchmark(root, count) {
  const load = name => import(pathToFileURL(join(root, "src/harness/foundry", name)).href);
  const { Store } = await load("store.ts"), { Scheduler } = await load("scheduler.ts");
  const { readyCandidates } = await load("schedulerIndex.ts"), { orderedTasks } = await load("swarm/workspace.ts");
  const temp = mkdtempSync(join(tmpdir(), "dispatch-bench-")), store = await Store.open(temp);
  const contract = { schema: 1, name: "dispatch-query-fixture", workerId: "fixture", verifierId: "fixture", environmentId: "fixture",
    requiredChecks: ["fixture"], slos: [], limits: { parallelism: 16, attempts: 2, contextBytes: 8192, outputBytes: 8192, timeoutMs: 10000, tasks: 100000 } };
  const recipe = { parallelism: 8, attempts: 1, contextBytes: 4096, timeoutMs: 5000, scheduling: "critical-path" };
  const id = n => "t" + String(n).padStart(6, "0");
  const tasks = Array.from({ length: count }, (_, i) => ({ id: id(i), goal: "Measure host query overhead", acceptance: ["fixture"],
    dependencies: i === 1 ? [id(0)] : [], writeScope: ["out/" + id(i)], readScope: [], input: null }));
  try {
    store.initialize(contract, recipe);
    const q = new Scheduler(store), before = performance.now(), run = q.start(tasks);
    const initializationMs = performance.now() - before;
    store.transaction(() => {
      // Query fixtures only. These rows do not certify artifacts or acceptance.
      const update = store.db.prepare("UPDATE tasks SET status=?,artifact='query-fixture' WHERE run=? AND id=?");
      for (let i = 0; i < count; i++) update.run(i < 2 || i % 2 === 0 ? "PASS" : "READY", run, id(i));
      store.db.prepare("UPDATE scheduler_nodes SET remaining=0 WHERE run=?").run(run);
      store.db.prepare("UPDATE fabric_allocations SET score=(rowid%17)/10.0 WHERE run=?").run(run);
      const edge = store.db.prepare("INSERT INTO spawn_edges VALUES(?,?,?,?,?,?)");
      for (let i = 2; i + 1 < count; i += 2) edge.run(run, id(i), id(i + 1), "fixture", 1, 1);
    });
    const now = Date.now(), expected = store.db.prepare(reference).all(run, now, 64, 0).map(r => r.id);
    assert.deepEqual(readyCandidates(store, run, now, 64).map(r => r.id), expected);
    assert.deepEqual(orderedTasks(store, run, [id(1)]).map(t => t.id), [id(0), id(1)]);
    const rank = store.db.prepare("SELECT MAX(rank) AS value FROM scheduler_nodes WHERE run=?");
    const prepare = store.db.prepare.bind(store.db), queries = [];
    store.db.prepare = sql => { queries.push(sql); return prepare(sql); };
    readyCandidates(store, run, now, 64);
    store.db.prepare = prepare;
    const actual = queries.find(sql => sql.includes("t.fence") && sql.includes("ORDER BY"));
    const candidatePlan = prepare("EXPLAIN QUERY PLAN " + actual).all(run, now, 64, 0).map(r => String(r.detail));
    return { count, fixtureOnly: true, modelCalls: 0, taskHash: createHash("sha256").update(JSON.stringify(tasks)).digest("hex"),
      initializationMs, initializationSamples: 1, runnableFixtureTasks: Math.floor(count / 2) - 1,
      unrelatedSpawnEdges: Math.floor((count - 2) / 2), candidatePlan,
      readyWindow: measure(() => readyCandidates(store, run, now, 64)),
      maxRank: measure(() => rank.get(run)),
      dependencyClosure: measure(() => orderedTasks(store, run, [id(1)])),
      orderingMatchesReference: true };
  } finally { store.close(); rmSync(temp, { recursive: true, force: true }); }
}

const runtimes = Object.fromEntries(Object.entries(roots).map(([name, root]) => {
  const sources = ["store.ts", "schedulerIndex.ts", "schedulerDispatch.ts", "evidenceFabric.ts", "swarm/workspace.ts"];
  return [name, { commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceHashes: Object.fromEntries(sources.filter(file => existsSync(join(root, "src/harness/foundry", file)))
      .map(file => [file, createHash("sha256").update(readFileSync(join(root, "src/harness/foundry", file))).digest("hex")])), cases: [] }];
}));
for (let i = 0; i < sizes.length; i++) {
  // Reverse the runtime order for alternate sizes to reduce ordering bias.
  const names = Object.keys(roots); if (i % 2) names.reverse();
  for (const name of names) runtimes[name].cases.push(await benchmark(roots[name], sizes[i]));
}
const comparisons = runtimes.baseline ? sizes.map(count => {
  const baseline = runtimes.baseline.cases.find(c => c.count === count), candidate = runtimes.candidate.cases.find(c => c.count === count);
  assert.equal(baseline.taskHash, candidate.taskHash);
  return { count, readyWindowRatio: baseline.readyWindow.medianMs / candidate.readyWindow.medianMs,
    maxRankRatio: baseline.maxRank.medianMs / candidate.maxRank.medianMs,
    dependencyClosureRatio: baseline.dependencyClosure.medianMs / candidate.dependencyClosure.medianMs,
    initializationRatioSingleSample: baseline.initializationMs / candidate.initializationMs };
}) : [];
console.log(JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), modelCalls: 0,
  scope: "Synthetic host queries and initialization; no accepted-output or live-LLM productivity claim",
  runtime: { node: process.version, platform: process.platform, arch: process.arch }, runtimes, comparisons }, null, 2));
