import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { initializeDiscovery, runDiscovery, discoverySnapshot } from "../../src/harness/foundry/discoveryRuntime.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import type { DiscoverySpec } from "../../src/harness/foundry/discovery.ts";
const root = resolve(import.meta.dirname, "../..");
function protocol(extra = {}): DiscoverySpec {
  return { schema: 1, name: "polynomial-fixture", task: { specification: "Compute n*n+n+41 for integer n.",
    interface: { format: "JavaScript expression", ...extra }, checks: ["oracle"],
    objective: { metric: "programBytes", direction: "min" }, axes: [{ metric: "programBytes", boundaries: [12, 20] }] },
    search: { families: 2, rounds: 3, migrationInterval: 2, contextCandidates: 3,
      contextBytes: 20000, candidateBytes: 2048, outputBytes: 16000, parallelism: 2, timeoutMs: 10000 },
    proposer: { argv: ["$RUNTIME", "./tests/foundry/discovery-fixtures/proposer.mjs"] },
    evaluator: { argv: ["$RUNTIME", "./tests/foundry/discovery-fixtures/evaluator.mjs"] } };
}
async function fixture(fn: (s: Store, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "discovery-test-")); const s = await Store.open(join(dir, "state"));
  try { await fn(s, dir); } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
}
test("real scheduler runs ideation, protected parallel families, rejection repair and durable archive", async () => fixture(async (s, dir) => {
  const log = join(dir, "calls.jsonl"); initializeDiscovery(s, protocol({ log }), root);
  const result = await runDiscovery(s);
  assert.equal(result.phase, "COMPLETE"); assert.equal(result.completedRounds, 3);
  assert.equal(result.evaluated, 6); assert.equal(result.rejected, 2); assert.equal(result.elites.length, 2);
  assert.equal(result.best!.report.metrics.programBytes, 11); // Independent byte count of x=>x*x+x+41.
  assert.equal(result.best!.proposal.candidate.claimedCost, -1e99); // Ignored by evaluator and archive.
  assert.equal(result.tokens, null); assert.equal(result.costUsd, null);
  const tasks = s.db.prepare("SELECT spec FROM tasks WHERE id='expanded' ORDER BY run").all().map(r => JSON.parse(r.spec));
  const round3 = tasks.find(t => t.input.round === 3).input;
  assert.match(round3.previous.feedback, /Counterexample/);
  assert.equal(round3.parent.family, "expanded");
  assert.ok(round3.alternatives.some((a: any) => a.family === "factored"));
  const calls = readFileSync(log, "utf8"), again = await runDiscovery(s);
  assert.deepEqual(again, result); assert.equal(readFileSync(log, "utf8"), calls);
  assert.throws(() => initializeDiscovery(s, protocol(), root), /already initialized/);
}));
test("pause and reopen reuse accepted tasks; no extra trials or duplicate runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-resume-")); let s = await Store.open(join(dir, "state"));
  const abort = new AbortController(); let timer: ReturnType<typeof setInterval> | undefined;
  try {
    initializeDiscovery(s, protocol({ delayMs: 500 }), root);
    timer = setInterval(() => {
      if (s.db.prepare("SELECT 1 FROM tasks WHERE id='expanded' AND status='PASS'").get()) abort.abort();
    }, 10);
    const paused = await runDiscovery(s, abort.signal); clearInterval(timer);
    assert.equal(paused.phase, "SEARCHING"); assert.equal(paused.evaluated, 1);
    const accepted = s.db.prepare("SELECT run,id,fence,artifact,evidence FROM tasks WHERE id='expanded' AND status='PASS'").get();
    s.close(); s = await Store.open(join(dir, "state"));
    assert.equal(discoverySnapshot(s).evaluated, 1);
    const done = await runDiscovery(s); assert.equal(done.phase, "COMPLETE"); assert.equal(done.evaluated, 6);
    assert.deepEqual(s.db.prepare("SELECT run,id,fence,artifact,evidence FROM tasks WHERE run=? AND id=?").get(accepted!.run, accepted!.id), accepted);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 4);
  } finally { if (timer) clearInterval(timer); s.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("two controllers deduplicate stable rounds and share existing scheduler leases", async () => fixture(async (s, dir) => {
  initializeDiscovery(s, protocol({ delayMs: 40 }), root);
  const other = await Store.open(join(dir, "state"));
  try {
    const [a, b] = await Promise.all([runDiscovery(s), runDiscovery(other)]);
    assert.equal(a.phase, "COMPLETE"); assert.deepEqual(b, a);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 4);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, 7);
  } finally { other.close(); }
}));
test("one expired lease from a dead process recovers within the frozen replay budget", async () => fixture(async s => {
  initializeDiscovery(s, protocol(), root);
  const abort = new AbortController();
  const staged = await runDiscovery(s, abort.signal, () => abort.abort());
  const scheduler = new Scheduler(s), id = staged.rounds[0].runId;
  const dead = scheduler.claim(id, "dead-controller", Date.now() - 20000)!;
  assert.equal(dead.fence, 1);
  const result = await runDiscovery(s); assert.equal(result.phase, "COMPLETE");
  const attempts = s.db.prepare("SELECT fence,status FROM attempts WHERE run=? ORDER BY fence").all(id);
  assert.deepEqual(attempts.map(a => [a.fence, a.status]), [[1, "EXPIRED"], [2, "PASS"]]);
}));
test("stale evaluator replies block search instead of becoming rejection feedback", async () => fixture(async s => {
  initializeDiscovery(s, protocol({ stale: true }), root);
  const result = await runDiscovery(s); assert.equal(result.phase, "BLOCKED"); assert.equal(result.best, null);
  assert.equal(result.evaluated, 0); assert.equal(result.rounds.length, 2);
  assert.match(result.rounds[1].errors[0].error!, /binding/);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, 3, "completed malformed replies are never retried");
}));
test("missing or tampered accepted evidence cannot be reused after restart", async () => fixture(async s => {
  initializeDiscovery(s, protocol(), root); await runDiscovery(s);
  const row = s.db.prepare("SELECT artifact FROM tasks WHERE id='expanded' LIMIT 1").get()!;
  writeFileSync(join(s.root, "artifacts", `${row.artifact}.json`), '{}');
  assert.throws(() => discoverySnapshot(s), /integrity/);
  await assert.rejects(runDiscovery(s), /integrity/);
}));
test("actual encoded context is checked before a trial is admitted", async () => fixture(async s => {
  const p = protocol(); p.search.contextBytes = 2048;
  p.task.specification += "x".repeat(2500);
  initializeDiscovery(s, p, root);
  await assert.rejects(runDiscovery(s), /CONTEXT_OVERFLOW/);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 0);
}));
test("CLI requires execution opt-in, then runs and reopens a finite discovery search", () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-cli-"));
  try {
    const file = join(dir, "spec.json"); writeFileSync(file, JSON.stringify(protocol()));
    const cli = (args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "src/harness/foundry/cli.ts", ...args, "--root", join(dir, "state")],
      { cwd: root, encoding: "utf8", timeout: 20000 });
    const init = cli(["discovery-init", "--spec", file]); assert.equal(init.status, 0, init.stderr);
    assert.notEqual(cli(["discovery-run"]).status, 0);
    const run = cli(["discovery-run", "--allow-exec"]); assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).phase, "COMPLETE");
    assert.deepEqual(JSON.parse(cli(["discovery-status"]).stdout), JSON.parse(run.stdout));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("external API adapter executes a fresh bounded model request for each search session", async () => fixture(async s => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body); requests.push(parsed);
    const input = JSON.parse(parsed.messages[1].content);
    const value = input.phase === "ideate" ? { families: [{ id: "expanded", approach: "Direct expansion" }, { id: "factored", approach: "Factorization" }] } :
      { candidate: { source: "x=>x*x+x+41" }, notes: [] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const old = { url: process.env.DISCOVERY_API_URL, model: process.env.DISCOVERY_MODEL };
  try {
    process.env.DISCOVERY_API_URL = `http://127.0.0.1:${(server.address() as any).port}/v1/chat/completions`;
    process.env.DISCOVERY_MODEL = "local-fixture";
    const p = protocol(); p.proposer = { argv: ["$RUNTIME", "./examples/discovery-search/api-proposer.mjs"], envAllow: ["DISCOVERY_API_URL", "DISCOVERY_MODEL"] };
    initializeDiscovery(s, p, root); const result = await runDiscovery(s);
    assert.equal(result.phase, "COMPLETE"); assert.equal(requests.length, 7);
    for (const r of requests) {
      assert.equal(r.messages.length, 2); assert.equal(r.messages[0].role, "system");
      assert.ok(Buffer.byteLength(JSON.stringify(r)) <= p.search.contextBytes);
      assert.equal(Object.hasOwn(JSON.parse(r.messages[1].content), "evaluator"), false);
    }
  } finally {
    if (old.url === undefined) delete process.env.DISCOVERY_API_URL; else process.env.DISCOVERY_API_URL = old.url;
    if (old.model === undefined) delete process.env.DISCOVERY_MODEL; else process.env.DISCOVERY_MODEL = old.model;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}));
