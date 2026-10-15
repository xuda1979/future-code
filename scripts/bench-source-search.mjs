#!/usr/bin/env node
/** Matched source-discovery policies with real Git/SQLite, scripted provider
 * replies and independent task/integration checks. No live-model speed claim. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2), opts = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i]; assert.ok(["--runtime-root", "--mode", "--repetitions", "--files"].includes(key) && !opts.has(key), `invalid option ${key}`);
  const value = args[++i]; assert.ok(value && !value.startsWith("--"), `missing ${key}`); opts.set(key, value);
}
const root = resolve(opts.get("--runtime-root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const mode = opts.get("--mode") ?? "search", repetitions = Number(opts.get("--repetitions") ?? 3), files = Number(opts.get("--files") ?? 256);
assert.ok(["browse", "search"].includes(mode)); assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 20);
assert.ok(Number.isSafeInteger(files) && files >= 2 && files <= 1000);
const load = name => import(pathToFileURL(join(root, "src/harness/foundry", name)).href);
const { Store } = await load("store.ts"), { initializeSwarm, runSwarm, integrateSwarm } = await load("swarm/host.ts");
const temp = mkdtempSync(join(tmpdir(), "future-source-search-bench-")), project = join(temp, "repo"), signal = new AbortController().signal;
const name = i => `src/file${String(i).padStart(4, "0")}.mjs`, target = name(files - 1);
mkdirSync(join(project, "src"), { recursive: true });
for (let i = 0; i < files; i++) writeFileSync(join(project, name(i)), i === files - 1 ? "export const targetMarker = 0;\n" : `export const value${i} = 0;\n`);
execFileSync("git", ["init", "-q", project]); execFileSync("git", ["-C", project, "add", "."]);
execFileSync("git", ["-C", project, "-c", "user.name=Benchmark", "-c", "user.email=benchmark@localhost", "commit", "-qm", "corpus"]);
const samples = [];
try {
  for (let repetition = 0; repetition < repetitions; repetition++) for (const workload of ["discovery", "known-file"]) {
    const store = await Store.open(join(temp, `state-${workload}-${repetition}`));
    try {
      const known = workload === "known-file", path = known ? name(0) : target, marker = known ? "value0" : "targetMarker";
      const spec = { schema: 1, name: "source-search-benchmark", project, baseRef: "HEAD", defaultAgent: "worker",
        agents: { worker: { protocol: "chat-completions", url: "http://127.0.0.1:1/v1/chat/completions", model: "scripted-source-discovery",
          system: "Locate the observed literal, edit only that value and rely on independent acceptance.",
          tools: ["list_files", "read_file", "edit_file", "recall", ...(mode === "search" ? ["search_files"] : [])], checks: ["behavior"] } },
        checks: { behavior: { argv: [process.execPath, "-e", `if(require('node:fs').readFileSync(${JSON.stringify(path)},'utf8')!==${JSON.stringify(`export const ${marker} = 42;\n`)})process.exit(1)`], replaySafe: true } },
        integrationChecks: ["behavior"], protectedPaths: ["checks"],
        limits: { parallelism: 1, attempts: 1, contextBytes: 524288, outputBytes: 65536, timeoutMs: 60000, tasks: 10 },
        recipe: { parallelism: 1, attempts: 1, contextBytes: 262144, timeoutMs: 30000 },
        budget: { maxRequests: 64, maxRequestBytes: 32 * 1024 * 1024, maxTurns: 64, maxToolCalls: 1200, modelConcurrency: 1,
          requestTimeoutMs: 5000, toolTimeoutMs: 5000, maxOutputTokens: 4096, maxToolOutputBytes: 65536, maxPatchBytes: 65536 } };
      await initializeSwarm(store, spec, signal);
      let requests = 0, toolCalls = 0, inputBytes = 0, found = known ? path : null, edited = false, cursor = null, listingOffset = 0;
      const names = []; let nextRead = 0, listingDone = false, callsById = new Map(), serial = 0;
      const call = (name, arguments_) => { const c = { id: `c${serial++}`, name, arguments: arguments_ }; callsById.set(c.id, c); return c; };
      const fetcher = async (_url, init) => {
        requests++; inputBytes += Buffer.byteLength(init.body); const body = JSON.parse(init.body);
        // Process only previously unseen, complete tool results from this thread.
        for (const message of body.messages.filter(m => m.role === "tool")) {
          const prior = callsById.get(message.tool_call_id); if (!prior) continue;
          callsById.delete(message.tool_call_id); const result = JSON.parse(message.content);
          assert.ok(!result.error && !result.truncated, JSON.stringify(result));
          if (prior.name === "search_files") {
            assert.equal(result.skippedFiles, 0); if (result.matches.length) found = result.matches[0].path;
            cursor = result.nextCursor;
          } else if (prior.name === "list_files") {
            names.push(...result.files); listingOffset += result.files.length; listingDone = listingOffset >= result.total;
          } else if (prior.name === "read_file" && result.content.includes(marker)) found = result.path;
          else if (prior.name === "edit_file") edited = true;
        }
        let calls;
        if (edited) calls = [];
        else if (found) calls = [call("edit_file", { path: found, oldText: `${marker} = 0`, newText: `${marker} = 42` })];
        else if (mode === "search") calls = [call("search_files", { query: marker, ...(cursor ? { cursor } : {}) })];
        else if (!listingDone) calls = [call("list_files", { offset: listingOffset, limit: 50 })];
        else { calls = names.slice(nextRead, nextRead + 32).map(path => call("read_file", { path })); nextRead += calls.length; assert.ok(calls.length, "discovery exhausted without result"); }
        toolCalls += calls.length;
        return Response.json({ choices: [{ finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: calls.length ? "" : "implemented",
          ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) } }] });
      };
      const task = { id: "change", goal: `Set ${marker} to 42${known ? ` in ${path}` : "; find its source location"}`, acceptance: ["independent exact value check"],
        dependencies: [], writeScope: ["src"], readScope: ["src"], input: null };
      const started = performance.now(), result = await runSwarm(store, [task], signal, undefined, fetcher);
      assert.equal(result.status, "PASS"); assert.equal(result.accepted, 1);
      assert.equal(result.providerUsage.requests, requests); assert.equal(result.providerUsage.requestBytes, inputBytes);
      assert.equal(result.providerUsage.tokens, null);
      const integration = await integrateSwarm(store, result.id, signal);
      const elapsedMs = performance.now() - started;
      assert.ok(integration.commit); assert.equal(readFileSync(join(project, path), "utf8"), `export const ${marker} = 0;\n`);
      samples.push({ repetition, workload, elapsedMs, scriptedProviderRequests: requests, toolCalls, encodedRequestBytes: inputBytes,
        acceptedTasks: result.accepted, independentlyIntegrated: true, liveModelCalls: 0, tokens: null, costUsd: null });
    } finally { store.close(); }
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
const sourceFiles = ["swarm/sourceSearch.ts", "swarm/driver.ts", "swarm/model.ts", "swarm/workspace.ts", "swarm/config.ts", "swarm/toolBatches.ts"];
const sourceHashes = Object.fromEntries(sourceFiles.filter(f => existsSync(join(root, "src/harness/foundry", f)))
  .map(f => [f, createHash("sha256").update(readFileSync(join(root, "src/harness/foundry", f))).digest("hex")]));
console.log(JSON.stringify({ kind: "offline-scripted-source-discovery", mode, runtime: process.version,
  runtimeCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceHashes, files,
  policy: "Exhaustive listing plus 32-file read batches versus bounded literal search; target is last in a synthetic filename-opaque corpus. Known-file arms directly edit the supplied path.",
  samples }, null, 2));
