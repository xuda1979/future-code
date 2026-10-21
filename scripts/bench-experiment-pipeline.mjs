#!/usr/bin/env node
/** Offline matched allocation benchmark: real POSIX job processes, Git/SQLite,
 * task and integration checks; scripted provider, no ML training or API spend. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/harness/foundry/store.ts";
import { initializeSwarm, integrateSwarm, runSwarm } from "../src/harness/foundry/swarm/host.ts";

assert.equal(process.argv.length, 2, "this benchmark takes no arguments");
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), sig = new AbortController().signal;
const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const temp = mkdtempSync(join(tmpdir(), "future-experiment-pipeline-")), project = join(temp, "repo");
mkdirSync(join(project, "src"), { recursive: true }); writeFileSync(join(project, "src/coefficient.txt"), "0\n");
execFileSync("git", ["init", "-q", project]); execFileSync("git", ["-C", project, "add", "."]);
execFileSync("git", ["-C", project, "-c", "user.name=Benchmark", "-c", "user.email=benchmark@localhost", "commit", "-qm", "base"]);
const worker = join(temp, "experiment.py"), endpoint = join(root, "scripts/research-job-agent.py");
writeFileSync(worker, `import json, os, sys
from pathlib import Path
request = json.loads(Path(os.environ["FUTURE_JOB_INPUT_PATH"]).read_text())
n = 16 if sys.argv[1] == "pilot" else 4096
k = request["coefficient"]
loss = sum((k * (i / n) - 2 * (i / n)) ** 2 for i in range(n)) / n
Path(os.environ["FUTURE_JOB_RESULT_PATH"]).write_text(json.dumps({"metrics": {"mse": loss}, "samples": n}, allow_nan=False))
`);
const adapters = {};
for (const stage of ["pilot", "full"]) {
  const config = join(temp, stage + ".json");
  writeFileSync(config, JSON.stringify({ argv: [python, worker, stage], timeoutMs: 10000, resultMaxBytes: 2048 }));
  adapters[stage] = { argv: [python, endpoint, "--root", join(temp, "spool-" + stage), "--config", config],
    files: [endpoint, worker, config] };
}
const prerequisite = { from: "pilot", matchInput: ["coefficient", "dataset", "evaluation", "seed"],
  metric: ["data", "metrics", "mse"], direction: "min", threshold: 0.01 };
const samples = [];
try {
  for (const enabled of [false, true]) {
    const store = await Store.open(join(temp, enabled ? "pipeline" : "baseline"));
    try {
      const jobs = Object.fromEntries(["pilot", "full"].map(name => [name, {
        adapter: adapters[name], idempotentEnsure: true, pollMs: 20, staleMs: 10000, maxJobs: 8, maxConcurrent: 3,
        ...(enabled ? { experiment: { reuseIdentical: true, ...(name === "full" ? { promotion: prerequisite } : {}) } } : {}),
      }]));
      const spec = { schema: 1, name: "experiment-pipeline-benchmark", project, baseRef: "HEAD", defaultAgent: "worker",
        agents: { worker: { protocol: "chat-completions", url: "http://127.0.0.1:1/v1/chat/completions", model: "scripted-allocation",
          system: "Screen coefficients, evaluate eligible candidates, and save the best verified coefficient.",
          tools: ["run_job", "write_file", "run_check", "recall"], checks: ["behavior"], jobs: ["pilot", "full"] } },
        jobs, checks: { behavior: { argv: [process.execPath, "-e",
          "const k=Number(require('node:fs').readFileSync('src/coefficient.txt','utf8'));if(!Number.isFinite(k)||Array.from({length:100},(_,i)=>((k-2)*i/100)**2).some(x=>x>1e-8))process.exit(1)"], replaySafe: true } },
        integrationChecks: ["behavior"], protectedPaths: ["checks"],
        limits: { parallelism: 1, attempts: 3, contextBytes: 65536, outputBytes: 32768, timeoutMs: 60000, tasks: 10 },
        recipe: { parallelism: 1, attempts: 3, contextBytes: 32768, timeoutMs: 30000 },
        budget: { maxRequests: 16, maxRequestBytes: 4_000_000, maxTurns: 16, maxToolCalls: 32, modelConcurrency: 1,
          requestTimeoutMs: 5000, toolTimeoutMs: 5000, maxOutputTokens: 2048, maxToolOutputBytes: 65536, maxPatchBytes: 65536 } };
      await initializeSwarm(store, spec, sig);
      const job = (id, name, coefficient) => ({ id, name: "run_job", arguments: { name,
        input: { coefficient, dataset: "deterministic-linear-v1", evaluation: "mse-v1", seed: 0 } } });
      const turns = [
        [0, 1, 2].map(k => job("pilot-" + k, "pilot", k)),
        [0, 1, 2].map(k => job("full-" + k, "full", k)),
        [job("repeat-full", "full", 2)],
        [{ id: "save", name: "write_file", arguments: { path: "src/coefficient.txt", content: "2\n" } }],
        [],
      ];
      let requests = 0;
      const fetcher = async () => {
        const calls = turns[requests++]; assert.ok(calls, "unexpected provider request");
        return Response.json({ choices: [{ finish_reason: calls.length ? "tool_calls" : "stop", message: {
          role: "assistant", content: calls.length ? "execute next stage" : "completed", ...(calls.length ? {
            tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
          } : {}),
        } }] });
      };
      const result = await runSwarm(store, [{ id: "fit", goal: "Select a coefficient for y=2x and save it.",
        acceptance: ["independent error check"], dependencies: [], writeScope: ["src/coefficient.txt"], input: null }], sig, undefined, fetcher);
      assert.equal(result.status, "PASS");
      const integration = await integrateSwarm(store, result.id, sig); assert.ok(integration.commit);
      const rows = store.db.prepare("SELECT template,status,result_hash FROM research_jobs WHERE run=?").all(result.id);
      assert.ok(rows.every(r => r.status === "SUCCEEDED"));
      const full = rows.filter(r => r.template === "full");
      const bestLoss = Math.min(...full.map(r => store.readArtifact(r.result_hash).result.data.metrics.mse));
      assert.equal(bestLoss, 0); assert.equal(requests, 5);
      samples.push({ policy: enabled ? "reuse-and-promotion" : "call-id-baseline", pilotExecutions: rows.length - full.length,
        fullExecutions: full.length, totalExternalExecutions: rows.length, bestFullMse: bestLoss,
        acceptedTasks: result.accepted, independentlyIntegrated: true, scriptedProviderRequests: requests,
        liveModelCalls: 0, tokens: null, costUsd: null });
    } finally { store.close(); }
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
assert.equal(samples[0].fullExecutions, 4); assert.equal(samples[1].fullExecutions, 1);
const sourceFiles = ["src/harness/foundry/swarm/experimentPipeline.ts", "src/harness/foundry/swarm/jobs.ts",
  "src/harness/foundry/swarm/config.ts", "src/harness/foundry/swarm/driver.ts", "src/harness/decisionGuidance.ts",
  "scripts/research-job-agent.py", "scripts/bench-experiment-pipeline.mjs"];
console.log(JSON.stringify({ schema: 1, kind: "offline-computational-experiment-allocation", runtime: process.version,
  baseCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceHashes: Object.fromEntries(sourceFiles.map(f => [f, createHash("sha256").update(readFileSync(join(root, f))).digest("hex")])),
  workload: "Three fixed coefficients for y=2x; pilot evaluates 16 points, full evaluates 4096; min MSE <= 0.01 promotes; same proposed calls in both policies, including one duplicate full run.",
  limitation: "Scripted provider and a small deterministic numerical workload; no live-LLM, GPU/NPU training, or quantum-gpt productivity measurement.",
  samples }, null, 2));
