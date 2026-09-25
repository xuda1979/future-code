/** Real local Git/check processes + synthetic model latency. NOT a live coding benchmark. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { fixture, signal, reply, task } from "../tests/foundry/swarm-fixtures.ts";
import { runSwarm, integrateSwarm } from "../src/harness/foundry/swarm/host.ts";
const count = Number(process.argv[2] ?? 12); const repetitions = Number(process.argv[3] ?? 3);
assert.ok(Number.isSafeInteger(count) && count >= 4 && count <= 32);
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
const results = []; const modelDelayMs = 80;
for (let repetition = 0; repetition < repetitions; repetition++) {
  for (const parallelism of repetition % 2 ? [4, 1] : [1, 4]) {
    await fixture(async (store, cfg) => {
      let active = 0; let peak = 0; let calls = 0;
      const fetcher = async (_url, init) => {
        calls++; active++; peak = Math.max(peak, active);
        try {
          await delay(modelDelayMs, undefined, { signal: init.signal });
          const body = JSON.parse(init.body); const t = JSON.parse(body.messages[1].content).task;
          return body.messages.some(m => m.role === "tool") ? reply("done", [], null)
            : reply("", [{ name: "write_file", arguments: { path: t.writeScope[0], content: `${t.input.value}\n` } }], null);
        } finally { active--; }
      };
      const tasks = Array.from({ length: count }, (_, i) => ({ ...task(`t${i}`), agent: `worker${i}`,
        readScope: [`src/t${i}.txt`], input: { value: i + 1 }, estimatedDurationMs: 200 }));
      const started = performance.now();
      const run = await runSwarm(store, tasks, signal(), undefined, fetcher);
      assert.equal(run.status, "PASS"); assert.equal(run.accepted, count); assert.equal(run.attempts, count);
      const taskMs = performance.now() - started;
      const integration = await integrateSwarm(store, run.id, signal()); assert.ok(integration.commit);
      results.push({ repetition, parallelism, count, taskMs, totalMs: performance.now() - started,
        calls, peakMockModelRequests: peak, accepted: run.accepted, providerTokens: run.providerUsage.tokens });
    }, s => {
      const profile = { ...s.agents.coder }; s.agents = {}; s.checks = {}; s.integrationChecks = []; s.defaultAgent = "worker0";
      for (let i = 0; i < count; i++) {
        const name = `check${i}`;
        s.checks[name] = { argv: [process.execPath, "-e", `const fs=require('node:fs');if(fs.readFileSync('src/t${i}.txt','utf8').trim()!=='${i + 1}')process.exit(1)`], replaySafe: true };
        s.agents[`worker${i}`] = { ...profile, checks: [name] }; s.integrationChecks.push(name);
      }
      s.recipe.parallelism = parallelism; s.budget.modelConcurrency = parallelism;
      s.recipe.maxInFlightContextBytes = s.recipe.contextBytes * parallelism;
      s.budget.maxRequests = 2 * count; s.budget.maxRequestBytes = 100_000_000;
    });
  }
}
const median = xs => { const ys = [...xs].sort((a, b) => a - b); const i = Math.floor(ys.length / 2); return ys.length % 2 ? ys[i] : (ys[i - 1] + ys[i]) / 2; };
const baseline = median(results.filter(r => r.parallelism === 1).map(r => r.totalMs));
const parallel = median(results.filter(r => r.parallelism === 4).map(r => r.totalMs));
console.log(JSON.stringify({ kind: "synthetic-model-latency-with-real-git-and-independent-checks", modelDelayMs, count, repetitions,
  includes: "local scheduling, durable journals, worktrees, checks, branch publication; excludes live model behavior and init cost",
  medianTotalMs: { oneWorker: baseline, fourWorkers: parallel }, ratio: baseline / parallel, results }, null, 2));
