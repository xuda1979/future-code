import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { FatalAttemptError } from "../../src/harness/foundry/errors.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { SessionJournal, type ThreadState } from "../../src/harness/foundry/swarm/session.ts";
import { LocalGitHands, localGitBackend, type Hands, type HandsBackend } from "../../src/harness/foundry/swarm/workspace.ts";
import type { Call } from "../../src/harness/foundry/swarm/context.ts";
import { fixture, reply, scripted, signal, task } from "./swarm-fixtures.ts";

const write = (id: string, content = "42\n"): Call => ({ id, name: "write_file", arguments: { path: "src/a.txt", content } });
const read = (id: string, start = 1): Call => ({ id, name: "read_file", arguments: { path: "src/a.txt", start } });
const edit = (id: string, oldText: string, newText: string): Call => ({ id, name: "edit_file", arguments: { path: "src/a.txt", oldText, newText } });
const wrapBackend = (wrap: (hands: LocalGitHands) => Hands): HandsBackend => ({ ...localGitBackend,
  open: (s, cfg, c, p, sig, restore) => wrap(new LocalGitHands(s, cfg, c, p, sig, restore)),
});
const state = (s: Parameters<Parameters<typeof fixture>[0]>[0], run: string): ThreadState =>
  s.readArtifact(s.db.prepare("SELECT state FROM agent_threads WHERE run=?").get(run)!.state) as unknown as ThreadState;
const initial = (): ThreadState => ({ history: [{ role: "user", content: "task" }], turns: 1, toolCalls: 0,
  patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 32768 });
const withJobs = (s: Parameters<NonNullable<Parameters<typeof fixture>[1]>>[0]) => {
  s.jobs = { exp: { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
    idempotentEnsure: true, pollMs: 10, staleMs: 1000, maxJobs: 8, maxConcurrent: 2 } };
  s.agents.coder.jobs = ["exp"]; s.agents.coder.tools.push("run_job");
};
const job = (id: string, seed: number): Call => ({ id, name: "run_job", arguments: { name: "exp", input: { seed } } });

test("independent reads overlap within four slots, deduplicate I/O and retain ordered owned results", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  let active = 0, peak = 0, executions = 0, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const backend = wrapBackend(h => ({ batchPolicy: h.batchPolicy,
    async tool(call) {
      if (call.name !== "read_file") return h.tool(call);
      executions++; active++; peak = Math.max(peak, active); if (active === 4) release();
      try {
        await Promise.race([gate, delay(1500).then(() => { throw new Error("reads were serialized"); })]);
        await delay(2 * (9 - (call.arguments.start as number)));
        return await h.tool(call);
      } finally { active--; }
    }, snapshot: () => h.snapshot(), dispose: () => h.dispose(),
  }));
  const calls = [...Array.from({ length: 8 }, (_, i) => read(`r${i}`, i + 1)), read("duplicate1"), read("duplicate2"), write("write")];
  const mock = scripted([() => reply("", calls), body => {
    assert.deepEqual(body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id), calls.map(c => c.id));
    return reply("done");
  }]);
  const d = new SwarmDriver(s, cfg, mock.fetcher, backend), result = await d.execute(c, signal());
  assert.equal(peak, 4); assert.equal(executions, 8);
  const t = state(s, run); assert.equal(t.toolCalls, 11); assert.equal(t.pendingBatch, undefined);
  for (const m of t.history.filter(m => m.role === "tool")) assert.ok(d.journal.ownsReceipt(c, m.receipt!));
  assert.ok((await d.verify(c, result, signal())).checks.every(c => c.verdict === "PASS"));
}));

test("concurrent initial reads see restored patches and share one complete worktree", async () => fixture(async (s, cfg, project) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  const first = new LocalGitHands(s, cfg, c, cfg.spec.agents.coder, signal());
  let patch: string;
  try { await first.tool(write("first")); patch = await first.snapshot(); } finally { await first.dispose(); }
  const restored = new LocalGitHands(s, cfg, c, cfg.spec.agents.coder, signal(), patch!);
  try {
    const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => restored.tool(read(`r${i}`))));
    assert.ok(replies.every(r => (r as any).content === "42\n"));
    const paths = execFileSync("git", ["-C", project, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    assert.equal(paths.match(/^worktree /gm)?.length, 2);
  } finally { await restored.dispose(); }
}));

test("ordered edits take one scoped snapshot and preserve ordinary error and check boundaries", async () => fixture(async (s, cfg, project) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  let snapshots = 0; const trace: string[] = [];
  const backend = wrapBackend(h => ({ batchPolicy: h.batchPolicy,
    tool: call => { trace.push(call.id); return h.tool(call); },
    snapshot: () => { snapshots++; return h.snapshot(); }, dispose: () => h.dispose(),
  }));
  const calls = [write("start", "10\n"), edit("bad", "absent", "never"), edit("finish", "10", "42"),
    { id: "check", name: "run_check", arguments: { name: "behavior" } }, read("after1"), read("after2")];
  const mock = scripted([() => reply("", calls), () => reply("done")]);
  const d = new SwarmDriver(s, cfg, mock.fetcher, backend), result = await d.execute(c, signal());
  assert.equal(snapshots, 2, "one write-group snapshot plus the explicit check snapshot");
  assert.deepEqual(trace, ["start", "bad", "finish", "check", "after1"]);
  const t = state(s, run), messages = t.history.filter(m => m.role === "tool");
  assert.deepEqual(messages.map(m => m.callId), calls.map(c => c.id));
  assert.match(JSON.stringify(s.readArtifact(messages[1]!.receipt!)), /exactly one match/);
  assert.match(JSON.stringify(s.readArtifact(messages[4]!.receipt!)), /42/);
  assert.ok((await d.verify(c, result, signal())).checks.every(c => c.verdict === "PASS"));
  assert.equal(readFileSync(join(project, "src/a.txt"), "utf8"), "0\n");
}));

test("interrupted edit batches restore the preceding snapshot and replay without double charging", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), lease = q.claim(run, "first")!, c = q.capsule(lease);
  const controller = new AbortController();
  const calls = [write("start", "10\n"), edit("step", "10", "20"), edit("finish", "20", "42")];
  const first = scripted([() => reply("", calls)]);
  const backend = wrapBackend(h => ({ batchPolicy: h.batchPolicy,
    async tool(call) { const r = await h.tool(call); controller.abort(); return r; },
    snapshot: () => h.snapshot(), dispose: () => h.dispose(),
  }));
  await assert.rejects(new SwarmDriver(s, cfg, first.fetcher, backend).execute(c, controller.signal));
  const interrupted = state(s, run);
  assert.equal(interrupted.patchHash, null); assert.equal(interrupted.toolCalls, 3);
  assert.deepEqual(interrupted.pendingBatch, calls.map(c => c.id));
  assert.equal(interrupted.history.filter(m => m.role === "tool").length, 0);
  q.fail(lease, "process restarted"); const next = q.capsule(q.claim(run, "replacement")!);
  const mock = scripted([body => {
    assert.deepEqual(body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id), calls.map(c => c.id));
    return reply("recovered");
  }]);
  const d = new SwarmDriver(s, cfg, mock.fetcher), result = await d.execute(next, signal());
  assert.equal(state(s, run).toolCalls, 3); assert.equal(mock.bodies.length, 1);
  assert.ok((await d.verify(next, result, signal())).checks.every(c => c.verdict === "PASS"));
}, s => { s.budget.maxToolCalls = 3; }));

test("batched deletions and explicitly written ignored files survive canonical snapshot and verification", async () => fixture(async (s, cfg, project) => {
  writeFileSync(join(project, ".git/info/exclude"), "*.tmp\n");
  const q = new Scheduler(s), run = q.start([{ ...task(), writeScope: ["src"] }]), c = q.capsule(q.claim(run, "w")!);
  const calls = [{ id: "delete", name: "delete_file", arguments: { path: "src/b.txt" } },
    { id: "ignored", name: "write_file", arguments: { path: "src/cache.tmp", content: "retained evidence\n" } }, write("final")];
  const d = new SwarmDriver(s, cfg, scripted([() => reply("", calls), () => reply("done")]).fetcher);
  const result = await d.execute(c, signal()), patch = state(s, run).patchHash!;
  assert.match(String(s.readArtifact(patch)), /src\/b\.txt/); assert.match(String(s.readArtifact(patch)), /src\/cache\.tmp/);
  assert.ok((await d.verify(c, result, signal())).checks.every(c => c.verdict === "PASS"));
  const restored = new LocalGitHands(s, cfg, c, cfg.spec.agents.coder, signal(), patch);
  try {
    assert.equal((await restored.tool({ id: "read", name: "read_file", arguments: { path: "src/cache.tmp" } }) as any).content, "retained evidence\n");
    await assert.rejects(restored.tool({ id: "missing", name: "read_file", arguments: { path: "src/b.txt" } }), /ENOENT/);
  } finally { await restored.dispose(); }
  assert.equal(readFileSync(join(project, "src/b.txt"), "utf8"), "0\n"); assert.equal(existsSync(join(project, "src/cache.tmp")), false);
}));

test("fatal write failures stop later effects and leave the entire group replayable", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  const trace: string[] = [], calls = [write("first", "10\n"), edit("fatal", "10", "20"), write("never")];
  const backend = wrapBackend(h => ({ batchPolicy: h.batchPolicy,
    async tool(call) { trace.push(call.id); const r = await h.tool(call); if (call.id === "fatal") throw new FatalAttemptError("backend interrupted"); return r; },
    snapshot: () => h.snapshot(), dispose: () => h.dispose(),
  }));
  await assert.rejects(new SwarmDriver(s, cfg, scripted([() => reply("", calls)]).fetcher, backend).execute(c, signal()), FatalAttemptError);
  assert.deepEqual(trace, ["first", "fatal"]);
  const t = state(s, run); assert.equal(t.patchHash, null);
  assert.deepEqual(t.pendingBatch, calls.map(c => c.id)); assert.equal(t.history.filter(m => m.role === "tool").length, 0);
  assert.equal(q.summary(run).accepted, 0);
}));

test("rejected duplicate reads cannot execute or borrow admission and batches respect exact tool ceilings", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  let executions = 0;
  const backend = wrapBackend(h => ({ batchPolicy: h.batchPolicy,
    tool: call => { executions++; return h.tool(call); }, snapshot: () => h.snapshot(), dispose: () => h.dispose(),
  }));
  const denied = ["denied1", "denied2"].map(id => ({ id, name: "read_file", arguments: { path: "checks/secret" } }));
  const mock = scripted([() => reply("", denied), body => {
    assert.equal(body.messages.filter((m: any) => m.role === "tool").length, 2); return reply("done");
  }]);
  await new SwarmDriver(s, cfg, mock.fetcher, backend).execute(c, signal());
  assert.equal(executions, 0); assert.equal(state(s, run).toolCalls, 2);
  const run2 = q.start([task("b")]), next = q.capsule(q.claim(run2, "other")!);
  await assert.rejects(new SwarmDriver(s, cfg, scripted([() => reply("", [read("1"), read("2"), read("3")])]).fetcher, backend).execute(next, signal()), /THREAD_TOOL_BUDGET_EXHAUSTED/);
  assert.equal(executions, 0); assert.equal(state(s, run2).toolCalls, 0);
}, s => { s.budget.maxToolCalls = 2; }));

test("remote batches preserve preceding workspace and check barriers", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  const trace: string[] = [];
  const backend = wrapBackend(h => ({ batchPolicy: h.batchPolicy,
    tool: call => { trace.push(call.id); return h.tool(call); }, snapshot: () => h.snapshot(), dispose: () => h.dispose(),
  }));
  const calls = [write("write"), { id: "check", name: "run_check", arguments: { name: "behavior" } }, job("job1", 1), job("job2", 2)];
  const rpc = async (_cmd: any, _cfg: any, request: any) => {
    assert.ok(state(s, run).patchHash, "remote effects must follow the preceding durable write");
    trace.push(`job${request.input.seed}`);
    return { schema: 1, key: request.key, jobId: `remote-${request.input.seed}`, status: "SUCCEEDED", result: { ok: true } };
  };
  const d = new SwarmDriver(s, cfg, scripted([() => reply("", calls), () => reply("done")]).fetcher, backend, rpc);
  const result = await d.execute(c, signal()); assert.deepEqual(trace, calls.map(c => c.id));
  assert.deepEqual(state(s, run).history.filter(m => m.role === "tool").map(m => m.callId), calls.map(c => c.id));
  assert.ok((await d.verify(c, result, signal())).checks.every(c => c.verdict === "PASS"));
}, withJobs));

test("legacy non-adjacent pending remote IDs retain their budget charge through read and write barriers", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  const j = new SessionJournal(s), t = j.open(c, initial());
  const calls = [read("read1"), read("read2"), write("write"), job("job1", 1), job("job2", 2)];
  t.state.history.push({ role: "assistant", content: "", calls });
  t.state.pendingBatch = ["job1", "job2"]; t.state.toolCalls = 2;
  j.checkpoint(t, "tool.batch.intent", { kind: "run_job", callIds: t.state.pendingBatch });
  let rpcCalls = 0;
  const rpc = async (_cmd: any, _cfg: any, r: any) => { rpcCalls++; return { schema: 1, key: r.key, jobId: `job-${rpcCalls}`, status: "SUCCEEDED", result: { ok: true } }; };
  const d = new SwarmDriver(s, cfg, scripted([() => reply("done")]).fetcher, undefined, rpc);
  const result = await d.execute(c, signal());
  assert.equal(rpcCalls, 2); assert.equal(state(s, run).toolCalls, 5); assert.equal(state(s, run).pendingBatch, undefined);
  assert.ok((await d.verify(c, result, signal())).checks.every(c => c.verdict === "PASS"));
}, s => { withJobs(s); s.budget.maxToolCalls = 5; }));

test("backends without batch capabilities retain single-call snapshots and serial I/O", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  let active = 0, peak = 0, snapshots = 0, reads = 0;
  const backend = wrapBackend(h => ({
    async tool(call) { active++; peak = Math.max(peak, active); if (call.name === "read_file") reads++; try { await delay(2); return await h.tool(call); } finally { active--; } },
    snapshot: () => { snapshots++; return h.snapshot(); }, dispose: () => h.dispose(),
  }));
  const calls = [read("r1"), read("r2"), write("w1", "10\n"), edit("w2", "10", "42")];
  const d = new SwarmDriver(s, cfg, scripted([() => reply("", calls), () => reply("done")]).fetcher, backend);
  const result = await d.execute(c, signal()); assert.equal(peak, 1); assert.equal(reads, 2); assert.equal(snapshots, 2);
  assert.ok((await d.verify(c, result, signal())).checks.every(c => c.verdict === "PASS"));
}));

test("a throwing host callback drains launched reads before disposal or retry", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  let active = 0, completed = 0;
  const backend = wrapBackend(h => ({ batchPolicy: h.batchPolicy,
    async tool(call) {
      active++;
      try { await h.ready(); await delay(call.id === "first" ? 1 : 40); return await h.tool(call); }
      finally { active--; completed++; }
    }, snapshot: () => h.snapshot(),
    async dispose() { assert.equal(active, 0, "disposal must wait for every launched read"); await h.dispose(); },
  }));
  const mock = scripted([() => reply("", [read("first"), read("second", 2)])]);
  await assert.rejects(new SwarmDriver(s, cfg, mock.fetcher, backend).execute(c, signal(), {
    progress() {}, activity(message) { if (/^(completed|failed):/.test(message)) throw new Error("host callback failed"); },
  }), /host callback failed/);
  assert.equal(completed, 2); assert.equal(state(s, run).history.filter(m => m.role === "tool").length, 0);
}));
