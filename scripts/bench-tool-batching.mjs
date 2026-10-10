#!/usr/bin/env node
/** Real worktrees and independent checks, scripted provider replies and an
 * explicitly simulated read service delay. NOT live R&D productivity. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2), opts = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i]; assert.ok(["--runtime-root", "--repetitions", "--read-delay-ms"].includes(key) && !opts.has(key), `invalid option ${key}`);
  const value = args[++i]; assert.ok(value && !value.startsWith("--"), `missing ${key}`); opts.set(key, value);
}
const root = resolve(opts.get("--runtime-root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const repetitions = Number(opts.get("--repetitions") ?? 3), readDelayMs = Number(opts.get("--read-delay-ms") ?? 40);
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0 && repetitions <= 10);
assert.ok(Number.isSafeInteger(readDelayMs) && readDelayMs >= 0 && readDelayMs <= 1000);
const load = f => import(pathToFileURL(join(root, "src/harness/foundry", f)).href);
const { Store } = await load("store.ts"), { runTasks } = await load("runtime.ts"), { digest } = await load("kernel.ts");
const { initializeSwarm } = await load("swarm/host.ts"), { SwarmDriver } = await load("swarm/driver.ts");
const { LocalGitHands, localGitBackend } = await load("swarm/workspace.ts");
const temp = mkdtempSync(join(tmpdir(), "future-tool-benchmark-")), project = join(temp, "project");
mkdirSync(join(project, "src"), { recursive: true }); writeFileSync(join(project, "src/a.txt"), "0\n");
for (let i = 0; i < 8; i++) writeFileSync(join(project, `src/read${i}.txt`), `evidence ${i}\n`);
execFileSync("git", ["init", "-q", project]); execFileSync("git", ["-C", project, "add", "."]);
execFileSync("git", ["-C", project, "-c", "user.name=Benchmark", "-c", "user.email=benchmark@localhost", "commit", "-qm", "base"]);
const signal = new AbortController().signal, store = await Store.open(join(temp, "state"));
const spec = { schema: 1, name: "tool-batching-benchmark", project, baseRef: "HEAD", defaultAgent: "worker",
  agents: { worker: { protocol: "chat-completions", url: "http://127.0.0.1:1/v1/chat/completions", model: "scripted-benchmark",
    system: "Use scoped tools and independent checks.", tools: ["list_files", "read_file", "write_file", "edit_file", "delete_file", "run_check", "recall"], checks: ["behavior"] } },
  checks: { behavior: { argv: [process.execPath, "-e", "if(require('node:fs').readFileSync('src/a.txt','utf8')!=='42\\n')process.exit(1)"], replaySafe: true } },
  integrationChecks: ["behavior"], protectedPaths: ["checks"],
  limits: { parallelism: 1, attempts: 1, contextBytes: 65536, outputBytes: 32768, timeoutMs: 60000, tasks: 100 },
  recipe: { parallelism: 1, attempts: 1, contextBytes: 32768, timeoutMs: 30000 },
  budget: { maxRequests: 4, maxRequestBytes: 1_000_000, maxTurns: 4, maxToolCalls: 40, modelConcurrency: 1,
    requestTimeoutMs: 5000, toolTimeoutMs: 5000, maxOutputTokens: 1024, maxToolOutputBytes: 65536, maxPatchBytes: 65536 } };
const write = (id, n) => ({ id, name: "write_file", arguments: { path: "src/a.txt", content: `${n}\n` } });
const read = (id, n) => ({ id, name: "read_file", arguments: { path: `src/read${n}.txt` } });
const cases = {
  short: [write("write", 42)],
  edits: Array.from({ length: 12 }, (_, i) => write(`w${i}`, i === 11 ? 42 : i)),
  reads: [...Array.from({ length: 8 }, (_, i) => read(`r${i}`, i)), read("repeat1", 0), read("repeat2", 0), write("write", 42)],
};
const sourceFiles = ["store.ts", "runtime.ts", "scheduler.ts", "swarm/driver.ts", "swarm/workspace.ts", "swarm/session.ts", "swarm/toolBatches.ts"];
const sourceHashes = Object.fromEntries(sourceFiles.filter(f => existsSync(join(root, "src/harness/foundry", f)))
  .map(f => [f, createHash("sha256").update(readFileSync(join(root, "src/harness/foundry", f))).digest("hex")]));
const samples = [];
try {
  const cfg = await initializeSwarm(store, spec, signal);
  for (let repetition = 0; repetition < repetitions; repetition++) for (const [name, calls] of Object.entries(cases)) {
    let snapshotCalls = 0, readExecutions = 0, active = 0, peak = 0, readStart = null, readEnd = null;
    const backend = { ...localGitBackend,
      open(s, config, c, profile, sig, restore) {
        const hands = new LocalGitHands(s, config, c, profile, sig, restore);
        return { batchPolicy: hands.batchPolicy,
          async tool(call) {
            if (call.name !== "read_file") return hands.tool(call);
            await hands.ready(); // Exclude initialization from the service window only.
            readExecutions++; active++; peak = Math.max(peak, active); readStart ??= performance.now();
            try { await delay(readDelayMs); return await hands.tool(call); }
            finally { active--; readEnd = performance.now(); }
          },
          snapshot() { snapshotCalls++; return hands.snapshot(); }, dispose: () => hands.dispose(),
        };
      },
    };
    let mockRequests = 0;
    const fetcher = async (_url, init) => {
      const body = JSON.parse(init.body); mockRequests++;
      if (mockRequests === 2) assert.deepEqual(body.messages.filter(m => m.role === "tool").map(m => m.tool_call_id), calls.map(c => c.id));
      assert.ok(mockRequests <= 2, "unexpected extra inference/repair");
      const message = mockRequests === 1 ? { role: "assistant", content: "", tool_calls: calls.map(c => ({ id: c.id,
        type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : { role: "assistant", content: "implemented" };
      return Response.json({ choices: [{ finish_reason: mockRequests === 1 ? "tool_calls" : "stop", message }],
        usage: { prompt_tokens: 0, completion_tokens: 0 } });
    };
    const task = { id: "task", goal: "Implement a checked fixture change", acceptance: ["independent exact file check"],
      dependencies: [], writeScope: ["src"], readScope: ["src"], input: null };
    const driver = new SwarmDriver(store, cfg, fetcher, backend), started = performance.now();
    const result = await runTasks(store, [task], driver, { signal });
    const elapsedMs = performance.now() - started;
    assert.equal(result.status, "PASS"); assert.equal(result.accepted, 1); assert.equal(result.attempts, 1);
    assert.equal(mockRequests, 2); assert.equal(driver.journal.usage(result.id).requests, 2);
    assert.equal(readFileSync(join(project, "src/a.txt"), "utf8"), "0\n", "user checkout changed");
    samples.push({ case: name, repetition, taskAndCallsHash: digest({ task, calls }), elapsedMs, snapshotCalls,
      readExecutions, peakReads: peak, simulatedReadServiceWindowMs: readStart === null ? null : readEnd - readStart,
      mockProviderRequests: mockRequests, independentlyAccepted: result.accepted });
  }
} finally { store.close(); rmSync(temp, { recursive: true, force: true }); }
const median = xs => { const a = [...xs].sort((a, b) => a - b), i = Math.floor(a.length / 2); return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2; };
const summary = Object.fromEntries(Object.keys(cases).map(name => {
  const s = samples.filter(s => s.case === name);
  return [name, { samples: s.length, medianMs: median(s.map(s => s.elapsedMs)),
    medianSnapshotCalls: median(s.map(s => s.snapshotCalls)), medianReadExecutions: median(s.map(s => s.readExecutions)),
    medianReadServiceWindowMs: name === "reads" ? median(s.map(s => s.simulatedReadServiceWindowMs)) : null }];
}));
process.stdout.write(JSON.stringify({ schema: 1, status: "OFFLINE_CHECKED_TOOL_WORKLOAD_NOT_LIVE_RND_SPEEDUP",
  generatedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  simulatedReadDelayMs: readDelayMs, liveLLMCalls: 0, sourceHashes, summary, samples }, null, 2) + "\n");
