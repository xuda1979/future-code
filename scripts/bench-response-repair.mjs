#!/usr/bin/env node
/** Fault-injection comparison using scripted replies, real Git/SQLite, and
 * independent task/integration checks. No network latency or live model. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const opts = new Map(), args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const key = args[i]; assert.ok(["--runtime-root", "--repetitions"].includes(key) && !opts.has(key), `invalid option ${key}`);
  const value = args[++i]; assert.ok(value && !value.startsWith("--"), `missing ${key}`); opts.set(key, value);
}
const root = resolve(opts.get("--runtime-root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const repetitions = Number(opts.get("--repetitions") ?? 3);
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 20);
const load = file => import(pathToFileURL(join(root, file)).href);
const { fixture, signal, task, reply } = await load("tests/foundry/swarm-fixtures.ts");
const { runSwarm, integrateSwarm } = await load("src/harness/foundry/swarm/host.ts");
const samples = [];
function malformed() {
  return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: "",
    tool_calls: [{ id: "broken", type: "function", function: { name: "write_file", arguments: '{"path":"src/a.txt","content":' } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } });
}
for (let repetition = 0; repetition < repetitions; repetition++) {
  for (const workload of ["healthy", "malformed", "empty", "repeated-malformed"]) {
    await fixture(async store => {
      let scriptedRequests = 0, encodedRequestBytes = 0;
      const fetcher = async (_url, init) => {
        scriptedRequests++; encodedRequestBytes += Buffer.byteLength(init.body);
        const body = JSON.parse(init.body);
        if (workload === "repeated-malformed") return malformed();
        if (body.messages.some(m => m.role === "tool")) return reply("implemented");
        const corrected = body.messages.some(m => m.role === "user" && m.content.includes('"modelResponseRejected":'));
        if (workload === "healthy" || corrected)
          return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
        return workload === "empty" ? reply(" \n ") : malformed();
      };
      const started = performance.now();
      const result = await runSwarm(store, [task()], signal(), undefined, fetcher);
      let independentlyIntegrated = false;
      if (result.status === "PASS") {
        const integration = await integrateSwarm(store, result.id, signal());
        assert.ok(integration.commit); independentlyIntegrated = true;
      }
      assert.equal(result.providerUsage.requests, scriptedRequests);
      assert.equal(result.providerUsage.requestBytes, encodedRequestBytes);
      const rejected = Number(store.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='model.rejected'").get().n);
      samples.push({ repetition, workload, status: result.status, elapsedMs: performance.now() - started,
        attempts: result.attempts, scriptedRequests, encodedRequestBytes, rejectedReplies: rejected,
        acceptedTasks: result.accepted, independentlyIntegrated,
        suppliedUsageTokens: result.providerUsage.knownTokens, unknownUsageRequests: result.providerUsage.unknownRequests,
        liveModelCalls: 0, actualBilledTokens: null, costUsd: null });
    });
  }
}
const paths = ["swarm/response.ts", "swarm/model.ts", "swarm/driver.ts", "swarm/session.ts"];
const sourceHashes = Object.fromEntries(paths.filter(p => existsSync(join(root, "src/harness/foundry", p)))
  .map(p => [p, createHash("sha256").update(readFileSync(join(root, "src/harness/foundry", p))).digest("hex")]));
console.log(JSON.stringify({ kind: "offline-scripted-response-faults", runtime: process.version,
  runtimeCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceHashes, fixture: "One exact-value edit. A scripted provider corrects its response only after host grammar feedback; repeated-malformed never corrects. Healthy replies are identical in both arms.",
  includes: "Task execution and, on accepted tasks only, independent final integration. Failed trials do not perform integration; timings across different outcomes are not speedup evidence.",
  samples }, null, 2));
