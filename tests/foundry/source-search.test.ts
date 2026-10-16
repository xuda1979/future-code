import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { executable, type SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { LocalGitHands, localGitBackend } from "../../src/harness/foundry/swarm/workspace.ts";
import { remoteWorkerFleetBackend } from "../../src/harness/foundry/swarm/workerFleet.ts";
import { validateToolProposal } from "../../src/harness/foundry/swarm/toolAdmission.ts";
import { nextToolBatch } from "../../src/harness/foundry/swarm/toolBatches.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { readSearchFile, searchSource } from "../../src/harness/foundry/swarm/sourceSearch.ts";
import { integrateSwarm, runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import type { Call } from "../../src/harness/foundry/swarm/context.ts";
import type { ThreadState } from "../../src/harness/foundry/swarm/session.ts";
import { fixture, reply, scripted, signal, task } from "./swarm-fixtures.ts";

const endpoint = resolve("scripts/swarm-worker-agent.py");
const search = (query: string, extra: Record<string, any> = {}, id = "search"): Call =>
  ({ id, name: "search_files", arguments: { query, ...extra } });
function commit(project: string): void {
  execFileSync("git", ["-C", project, "add", "."]);
  execFileSync("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "search corpus"]);
}
function configure(s: SwarmSpec, remote: boolean): void {
  s.agents.coder.tools.push("search_files");
  if (!remote) return;
  const parent = dirname(s.project), repo = join(parent, "worker-repo"), root = join(parent, "worker-root"), config = join(parent, "worker.json");
  execFileSync("git", ["clone", "-q", s.project, repo]); mkdirSync(root);
  writeFileSync(config, JSON.stringify({ checks: Object.fromEntries(Object.entries(s.checks).map(([name, check]) => [name, { argv: check.argv }])) }));
  s.workers = { worker: { adapter: { argv: [executable("python3"), endpoint, "--root", root, "--repo", repo, "--config", config],
    files: [endpoint, config] }, maxConcurrent: 1, maxRpcBytes: 2 * 1024 * 1024 } };
}

for (const remote of [false, true]) {
  const backend = remote ? remoteWorkerFleetBackend : localGitBackend, label = remote ? "remote" : "local";
  test(`${label} source search finds literal UTF-8 lines, pages without gaps, and respects read scopes`, async () => fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const hands = backend.open(s, cfg, c, cfg.spec.agents.coder, signal(), null);
    try {
      const found: any[] = []; let cursor: any;
      do {
        const r: any = await hands.tool(search("[x].*量子", { limit: 1, ...(cursor ? { cursor } : {}) }));
        assert.ok(!r.error, JSON.stringify(r)); assert.ok(Buffer.byteLength(JSON.stringify(r)) <= cfg.spec.budget.maxToolOutputBytes);
        found.push(...r.matches); cursor = r.nextCursor;
      } while (cursor);
      assert.deepEqual(found.map(m => [m.path, m.line]), [["src/a.txt", 2], ["src/a.txt", 4], ["src/b.txt", 1]]);
      assert.ok(found.every(m => m.text.includes("[x].*量子")));
      const narrowed: any = await hands.tool(search("[x].*量子", { path: "src/b.txt" }));
      assert.deepEqual(narrowed.matches.map((m: any) => m.path), ["src/b.txt"]);
      assert.equal((await hands.tool(search("SECRET")) as any).matches.length, 0);
      assert.equal((await hands.tool(search("missing")) as any).nextCursor, null);
      const literalPath: any = await hands.tool(search("needle", { path: "src/[literal].txt" }));
      assert.deepEqual(literalPath.matches.map((m: any) => m.path), ["src/[literal].txt"]);
      const longLine: any = await hands.tool(search("needle", { path: "src/long.txt" }));
      assert.equal(longLine.matches[0].truncated, true); assert.ok(longLine.matches[0].text.includes("needle"));
      assert.ok(!longLine.matches[0].text.includes("\ufffd"));
    } finally { await hands.dispose(); }
  }, s => {
    mkdirSync(join(s.project, "checks")); writeFileSync(join(s.project, "checks/secret.txt"), "SECRET [x].*量子\n");
    writeFileSync(join(s.project, "src/a.txt"), "0\nfirst [x].*量子\nnot xZZ\nsecond [x].*量子\n");
    writeFileSync(join(s.project, "src/b.txt"), "🙂 [x].*量子\n");
    writeFileSync(join(s.project, "src/[literal].txt"), "needle\n");
    writeFileSync(join(s.project, "src/long.txt"), "🙂".repeat(1000) + "needle" + "文".repeat(1000)); commit(s.project); configure(s, remote);
  }));

  test(`${label} source search skips binary, invalid UTF-8, oversized and symlink files explicitly`, async () => fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const hands = backend.open(s, cfg, c, cfg.spec.agents.coder, signal(), null);
    try {
      const r: any = await hands.tool(search("SECRET"));
      assert.ok(!r.error, JSON.stringify(r)); assert.deepEqual(r.matches, []); assert.equal(r.nextCursor, null);
      assert.equal(r.skippedFiles, 4); assert.equal(r.scannedFiles, 6);
      assert.ok(r.bytesRead <= 8 * 1024 * 1024);
    } finally { await hands.dispose(); }
  }, s => {
    writeFileSync(join(s.project, "src/binary"), Buffer.from("SECRET\0"));
    writeFileSync(join(s.project, "src/invalid"), Buffer.from([0xff, ...Buffer.from("SECRET")]));
    writeFileSync(join(s.project, "src/large"), "SECRET".repeat(12000));
    writeFileSync(join(dirname(s.project), "outside"), "SECRET\n"); symlinkSync(join(dirname(s.project), "outside"), join(s.project, "src/link"));
    commit(s.project); configure(s, remote);
  }));

  test(`${label} source search bounds no-match scans and includes current private untracked edits`, async () => fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([{ ...task(), writeScope: ["src"] }]), c = q.capsule(q.claim(run, "worker")!);
    const hands = backend.open(s, cfg, c, cfg.spec.agents.coder, signal(), null);
    try {
      const first: any = await hands.tool(search("needle"));
      assert.deepEqual(first.matches, []); assert.equal(first.scannedFiles, 256); assert.ok(first.nextCursor);
      const last: any = await hands.tool(search("needle", { cursor: first.nextCursor }));
      assert.equal(last.nextCursor, null); assert.deepEqual(last.matches.map((m: any) => m.path), ["src/zzz.txt"]);
      await hands.tool({ id: "new", name: "write_file", arguments: { path: "src/new.txt", content: "needle in current patch\n" } });
      assert.equal((await hands.tool(search("needle", { path: "src/new.txt" })) as any).matches[0].line, 1);
      await hands.tool({ id: "edit", name: "edit_file", arguments: { path: "src/new.txt", oldText: "needle", newText: "changed" } });
      assert.deepEqual((await hands.tool(search("needle", { path: "src/new.txt" })) as any).matches, []);
      await hands.tool({ id: "create", name: "run_check", arguments: { name: "create" } });
      assert.equal((await hands.tool(search("needle", { path: "src/untracked.txt" })) as any).matches[0].line, 1);
      assert.deepEqual((await hands.tool(search("needle", { path: "src/ignored.tmp" })) as any).matches, []);
    } finally { await hands.dispose(); }
  }, s => {
    for (let i = 0; i < 270; i++) writeFileSync(join(s.project, `src/noise-${String(i).padStart(3, "0")}.txt`), "unrelated\n");
    writeFileSync(join(s.project, "src/zzz.txt"), "needle\n"); writeFileSync(join(s.project, ".gitignore"), "*.tmp\n"); commit(s.project);
    s.checks.create = { argv: [process.execPath, "-e", "const fs=require('node:fs');fs.writeFileSync('src/untracked.txt','needle');fs.writeFileSync('src/ignored.tmp','needle')"], replaySafe: true };
    s.agents.coder.diagnostics = ["create"]; configure(s, remote);
  }));

  test(`${label} search joins read batches, returns owned receipts, and still requires task and integration checks`, async () => fixture(async (s, cfg, project) => {
    const calls = [search("0", {}, "find"), search("0", {}, "duplicate"),
      { id: "read", name: "read_file", arguments: { path: "src/a.txt" } },
      { id: "write", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }];
    const mock = scripted([body => {
      assert.ok(body.tools.some((t: any) => t.function.name === "search_files")); return reply("", calls);
    }, () => reply("done")]);
    const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
    assert.equal(result.status, "PASS"); const integration = await integrateSwarm(s, result.id, signal()); assert.ok(integration.commit);
    const thread = s.readArtifact(s.db.prepare("SELECT state FROM agent_threads WHERE run=?").get(result.id)!.state) as unknown as ThreadState;
    const tools = thread.history.filter(m => m.role === "tool");
    assert.deepEqual(tools.map(m => m.callId), calls.map(c => c.id)); assert.equal(thread.toolCalls, 4);
    const q = new Scheduler(s), c = { runId: result.id, task: task() } as any;
    const driver = new SwarmDriver(s, cfg, mock.fetcher, backend);
    assert.ok(tools.every(m => driver.journal.ownsReceipt(c, m.receipt!)));
    assert.deepEqual((s.readArtifact(tools[0].receipt!) as any).matches.map((m: any) => m.path), ["src/a.txt", "src/b.txt"]);
    assert.equal(readFileSync(join(project, "src/a.txt"), "utf8"), "0\n");
    if (remote) assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='worker.batch'").get()!.n, 2);
    else assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='tool.batch.result'").get()!.n, 1);
    assert.equal(q.summary(result.id).status, "PASS");
  }, s => configure(s, remote)));
}

test("source search admission rejects scope escapes and malformed queries/cursors before backend execution", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!), p = cfg.spec.agents.coder;
  for (const call of [search(""), search("a\nb"), search("\ud83d"), search("x", { regex: true }), search("x", { limit: 0 }),
    search("x", { path: "checks" }), search("x", { path: "../src" }),
    search("x", { cursor: { path: "checks/secret", line: 1 } }), search("x", { cursor: { path: "src/a.txt", line: 0 } })]) {
    assert.throws(() => validateToolProposal(c, cfg, p, call));
  }
  validateToolProposal(c, cfg, p, search("[literal].*", { path: "src" }));
  assert.throws(() => validateToolProposal(c, cfg, { ...p, tools: ["read_file"] }, search("x")), /not allowed/);
  const hands = new LocalGitHands(s, cfg, c, p, signal());
  const calls = [search("x"), { id: "r", name: "read_file", arguments: { path: "src/a.txt" } },
    { id: "barrier", name: "run_check", arguments: { name: "behavior" } }];
  assert.deepEqual(nextToolBatch(calls, hands)?.calls.map(c => c.id), ["search", "r"]);
}, s => configure(s, false)));

test("source search bounds bytes read and response size, with resumable locations rather than silent truncation", async () => {
  const files = Array.from({ length: 12 }, (_, i) => `src/f${String(i).padStart(2, "0")}`);
  const data = Buffer.alloc(1024 * 1024, "x"); let reads = 0;
  const first: any = await searchSource({ query: "absent" }, files, ["src"], 1024 * 1024,
    async () => { reads++; return data; }, signal(), 5000);
  assert.ok(reads > 0 && reads <= 8); assert.equal(first.bytesRead, reads * 1024 * 1024);
  assert.ok(first.bytesRead <= 8 * 1024 * 1024); assert.deepEqual(first.nextCursor, { path: files[reads], line: 1 });
  const growthFiles = Array.from({ length: 100 }, (_, i) => `src/g${i}`);
  const grew: any = await searchSource({ query: "x" }, growthFiles, ["src"], 4096,
    async () => Buffer.alloc(4097), signal(), 5000);
  assert.ok(grew.skippedFiles > 0); assert.equal(grew.bytesRead, grew.skippedFiles * 4097);
  assert.ok(grew.bytesRead <= 4096 * 64); assert.ok(grew.nextCursor);
  const corpus = Array.from({ length: 20 }, () => "xxneedleyyyyyyyy").join("\n");
  const found: number[] = []; let cursor: any, pages = 0;
  do {
    const page: any = await searchSource({ query: "needle", limit: 100, ...(cursor ? { cursor } : {}) }, ["src/file"], ["src"], 1024,
      async () => Buffer.from(corpus), signal(), 5000);
    pages++; assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1024); assert.ok(page.matches.length > 0);
    found.push(...page.matches.map((m: any) => m.line)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(found, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(pages > 1);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(searchSource({ query: "x" }, ["src/file"], ["src"], 4096, async () => data, cancelled.signal, 5000));
  const expired: any = await searchSource({ query: "x" }, ["src/file"], ["src"], 4096, async () => data, signal(), 0);
  assert.equal(expired.scannedFiles, 0); assert.ok(expired.nextCursor);
});

test("source search limits the underlying file read", async () => fixture(async (_s, _cfg, project) => {
  assert.equal(readSearchFile(join(project, "src/a.txt"), 0).length, 1);
  assert.equal(readSearchFile(join(project, "src/a.txt"), 1).length, 2);
}));

test("worker Git inventory rejects a truncated successful subprocess result", () => {
  const code = `import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("worker", ${JSON.stringify(endpoint)})
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
worker.run = lambda *a, **kw: {"code": 0, "stdout": "partial-list", "stderr": "output limit", "truncated": True}
try:
    worker.git(Path("."), ["ls-files"])
except ValueError:
    pass
else:
    raise AssertionError("truncated inventory was accepted")
`;
  execFileSync(executable("python3"), ["-c", code]);
});
