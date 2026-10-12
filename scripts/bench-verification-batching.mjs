#!/usr/bin/env node
/** Independently checked host workload; optional check delays are simulated.
 * Provider replies are scripted. This is not a live R&D productivity claim. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const options = new Map(), args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const key = args[i]; assert.ok(["--runtime-root", "--mode", "--repetitions", "--delay-ms"].includes(key) && !options.has(key), `invalid option ${key}`);
  const value = args[++i]; assert.ok(value && !value.startsWith("--"), `missing ${key}`); options.set(key, value);
}
const root = resolve(options.get("--runtime-root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const mode = options.get("--mode") ?? "parallel", repetitions = Number(options.get("--repetitions") ?? 3);
const delayMs = Number(options.get("--delay-ms") ?? 250);
assert.ok(["serial", "parallel"].includes(mode));
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
assert.ok(Number.isSafeInteger(delayMs) && delayMs >= 0 && delayMs <= 1000);
const load = file => import(pathToFileURL(join(root, file)).href);
const { fixture, task, signal, scripted, reply } = await load("tests/foundry/swarm-fixtures.ts");
const { runSwarm, integrateSwarm } = await load("src/harness/foundry/swarm/host.ts");
const { digest } = await load("src/harness/foundry/kernel.ts");
const cases = [{ name: "single", checks: 1, delay: 0 }, { name: "fourFast", checks: 4, delay: 0 }, { name: "eightDelayed", checks: 8, delay: delayMs }];
const samples = [];
for (let repetition = 0; repetition < repetitions; repetition++) for (const workload of cases) {
  await fixture(async (store, cfg, project) => {
    const mock = scripted([
      () => reply("", [{ id: "write", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
      () => reply("ready for verification"),
    ]);
    const started = performance.now(), run = await runSwarm(store, [task()], signal(), undefined, mock.fetcher);
    const runMs = performance.now() - started;
    assert.equal(run.status, "PASS"); assert.equal(run.accepted, 1); assert.equal(run.attempts, 1);
    const integrationStarted = performance.now(), integrated = await integrateSwarm(store, run.id, signal());
    const integrationMs = performance.now() - integrationStarted;
    const row = store.db.prepare("SELECT evidence FROM tasks WHERE run=? AND id='a'").get(run.id);
    const evidence = store.readArtifact(row.evidence), logsHash = evidence.verification.checks.find(c => c.id === "behavior").detail;
    const taskReports = store.readArtifact(logsHash), integrationReports = store.readArtifact(integrated.checksHash);
    const reports = [...taskReports, ...integrationReports];
    assert.equal(reports.length, workload.checks * 2); assert.ok(reports.every(r => r.code === 0 && !r.error));
    assert.equal(mock.bodies.length, 2); assert.equal(run.providerUsage.requests, 2);
    assert.equal(readFileSync(join(project, "src/a.txt"), "utf8"), "0\n");
    const intervals = reports.flatMap(r => {
      const data = JSON.parse(r.stdout); return [{ at: data.started, delta: 1 }, { at: data.ended, delta: -1 }];
    }).sort((a, b) => a.at - b.at || a.delta - b.delta);
    let active = 0, peak = 0; for (const event of intervals) { active += event.delta; peak = Math.max(peak, active); }
    assert.ok(peak <= (mode === "parallel" && workload.checks > 1 ? 4 : 1));
    samples.push({ case: workload.name, repetition, runMs, integrationMs, totalMs: runMs + integrationMs,
      verifierWorkerMs: run.productivity.phaseWorkerMs.verify, checkExecutions: reports.length, peakCheckProcesses: peak,
      mockProviderRequests: mock.bodies.length, acceptedTasks: run.accepted, integrated: true,
      taskAndChecksHash: digest({ task: task(), checks: cfg.spec.checks, integrationChecks: cfg.spec.integrationChecks }) });
  }, cfg => {
    cfg.recipe.parallelism = 1; cfg.recipe.attempts = 1;
    cfg.checks = Object.fromEntries(Array.from({ length: workload.checks }, (_, i) => [`check${i}`, {
      argv: [process.execPath, "-e", `const fs=require('node:fs'),started=Date.now();
        if(fs.readFileSync('src/a.txt','utf8')!=='42\\n')process.exit(1);
        setTimeout(()=>console.log(JSON.stringify({name:'check${i}',started,ended:Date.now(),cwd:process.cwd()})),${workload.delay});`],
      replaySafe: true, ...(mode === "parallel" ? { parallelSafe: true } : {}),
    }]));
    cfg.agents.coder.checks = Object.keys(cfg.checks); cfg.integrationChecks = Object.keys(cfg.checks);
    if (mode === "parallel") cfg.verification = { parallelism: 4 };
  });
}
const median = values => { const a = [...values].sort((a, b) => a - b), i = Math.floor(a.length / 2); return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2; };
const files = ["src/harness/foundry/swarm/config.ts", "src/harness/foundry/swarm/driver.ts", "src/harness/foundry/swarm/workspace.ts",
  "src/harness/foundry/swarm/host.ts", "src/harness/foundry/swarm/verification.ts"];
const sourceHashes = Object.fromEntries(files.filter(f => existsSync(join(root, f))).map(f =>
  [f, createHash("sha256").update(readFileSync(join(root, f))).digest("hex")]));
const summary = Object.fromEntries(cases.map(w => {
  const s = samples.filter(s => s.case === w.name);
  return [w.name, { samples: s.length, medianTotalMs: median(s.map(s => s.totalMs)), medianRunMs: median(s.map(s => s.runMs)),
    medianIntegrationMs: median(s.map(s => s.integrationMs)), peakCheckProcesses: Math.max(...s.map(s => s.peakCheckProcesses)) }];
}));
process.stdout.write(JSON.stringify({ schema: 1, measurement: "OFFLINE_VERIFIED_HOST_WORKLOAD_NOT_LIVE_RND",
  generatedAt: new Date().toISOString(), mode, liveLLMCalls: 0, simulatedCheckDelayMs: delayMs,
  runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceHashes, summary, samples }, null, 2) + "\n");
