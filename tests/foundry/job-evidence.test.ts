import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { diagnosticContext, pruningCandidate, recordDiagnostic } from "../../src/harness/foundry/swarm/diagnostics.ts";
import { compactHistory, bytes, type Message } from "../../src/harness/foundry/swarm/context.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { ResearchJobs } from "../../src/harness/foundry/swarm/jobs.ts";
import { runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { executable } from "../../src/harness/foundry/swarm/config.ts";
import { fixture, reply, scripted, signal, task } from "./swarm-fixtures.ts";

test("terminal remote failures survive restart/retirement as owned observations, never pruning or acceptance", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "fixture")!);
  const journal = new SessionJournal(s);
  const t = journal.open(c, { history: [{ role: "user", content: "immutable task" }], turns: 1,
    toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 32768 });
  const call = { id: "experiment", name: "run_job", arguments: { name: "trial", input: { seed: 1 } } };
  for (const status of ["FAILED", "CANCELLED"]) {
    const result = { schema: 1, key: "a".repeat(64), jobId: "stable", status,
      result: { exitCode: 7, error: "invalid structured result 数学".repeat(100),
        data: { passed: true }, stdoutTail: "PASS".repeat(1000) } };
    const receipt = journal.receipt(c, result); t.state.lastJobReceipt = receipt;
    const failure = recordDiagnostic(t, journal, cfg, call, result, receipt, null, true)!;
    assert.equal(failure.kind, "JOB_FAILED");
    assert.equal((failure as any).job, "trial"); assert.equal((failure as any).status, status);
    assert.equal(failure.eligible, false); assert.equal(pruningCandidate(t.state, cfg), null);
    assert.match(failure.excerpt, /structured result/); assert.ok(Buffer.byteLength(failure.excerpt) <= 512);
    assert.ok(journal.ownsReceipt(c, failure.fixture));
    const exact: any = s.readArtifact(failure.fixture);
    assert.equal(exact.resultReceipt, receipt);
    assert.deepEqual((s.readArtifact(exact.callReceipt) as any).arguments, call.arguments);
    journal.checkpoint(t, "tool.result", { receipt, fixture: failure.fixture });
  }
  const reopened = await Store.open(s.root);
  try { assert.deepEqual(new SessionJournal(reopened).open(c, t.state).state.diagnostics, t.state.diagnostics); }
  finally { reopened.close(); }
  const history: Message[] = [...t.state.history];
  for (let i = 0; i < 20; i++) history.push({ role: "assistant", content: "old " + "x".repeat(200) });
  const projected = compactHistory(history, 1800, null, diagnosticContext(t.state));
  assert.ok(bytes(projected) <= 1800);
  assert.match(projected[1].content, /JOB_FAILED/); assert.match(projected[1].content, /CANCELLED/);
  t.state.patchHash = s.artifact("changed patch");
  assert.equal(diagnosticContext(t.state)!.failures[0].current, false);
  const unknown = { schema: 1, key: "a".repeat(64), jobId: "stable", status: "UNKNOWN" };
  recordDiagnostic(t, journal, cfg, call, unknown, journal.receipt(c, unknown), t.state.patchHash, true);
  assert.equal(t.state.diagnostics!.failures.length, 1, "unknown outcome cannot erase a known failure");
  const ok = { ...unknown, status: "SUCCEEDED", result: { exitCode: 0 } };
  recordDiagnostic(t, journal, cfg, call, ok, journal.receipt(c, ok), t.state.patchHash, true);
  assert.equal(t.state.diagnostics!.failures.length, 0);
}));

test("single and batched run_job paths retain failed results and still require independent verification", async () => {
  for (const batched of [false, true]) await fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const jobs = ["failed", ...(batched ? ["good"] : [])].map(id => ({ id, name: "run_job",
      arguments: { name: "trial", input: { fail: id === "failed" } } }));
    const mock = scripted([
      () => reply("", jobs),
      () => {
        const row = s.db.prepare("SELECT state FROM agent_threads WHERE run=? AND task=?").get(run, c.task.id)!;
        const state: any = s.readArtifact(row.state);
        const failure = state.diagnostics.failures.find((f: any) => f.kind === "JOB_FAILED");
        assert.ok(failure); assert.equal(failure.job, "trial");
        assert.match(failure.excerpt, /numeric check failed/);
        assert.equal(failure.eligible, false);
        const evidence: any = s.readArtifact(failure.fixture);
        assert.equal(evidence.snapshotBoundary, batched ? "tool-batch" : "single-call");
        return reply("claimed completion without repairing source");
      },
    ]);
    const d = new SwarmDriver(s, cfg, mock.fetcher, undefined, async (_command, _config, raw) => {
      const r: any = raw;
      return { schema: 1, key: r.key, jobId: r.key, status: r.input.fail ? "FAILED" : "SUCCEEDED",
        result: { exitCode: r.input.fail ? 7 : 0, stderrTail: r.input.fail ? "numeric check failed" : "",
          data: { passed: true, score: 1 } } };
    });
    const result = await d.execute(c, signal());
    assert.ok((await d.verify(c, result, signal())).checks.some(check => check.verdict === "FAIL"));
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE run=?").get(run)!.n, jobs.length);
  }, s => {
    s.jobs = { trial: { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
      idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 4, maxConcurrent: 2 } };
    s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = ["trial"];
  });
});

test("opt-in artifact reader retrieves cold evidence through the real pinned endpoint without resubmitting", async () => fixture(async (s, cfg, project) => {
  let resultReceipt: string;
  const mock = scripted([
    () => reply("", [{ name: "run_job", arguments: { name: "trial", input: { seed: 1 } } }]),
    () => {
      const row = s.db.prepare("SELECT result_hash FROM research_jobs").get()!;
      resultReceipt = String(row.result_hash);
      const result: any = s.readArtifact(resultReceipt);
      assert.deepEqual(result.result.data, { score: 0.87, samples: 12 });
      assert.ok(!result.result.stdoutTail.includes("HEADER_EVIDENCE"));
      assert.equal(s.db.prepare("SELECT status FROM tasks WHERE id='a'").get()!.status, "RUNNING");
      return reply("", [{ name: "read_job_artifact", arguments: { receipt: resultReceipt,
        artifact: "stdout", offset: 0, length: Buffer.byteLength("HEADER_EVIDENCE\n") } }]);
    },
    body => {
      const tool = body.messages.filter((m: any) => m.role === "tool").at(-1);
      const page = JSON.parse(tool.content);
      assert.equal(page.content, "HEADER_EVIDENCE\n");
      assert.equal(page.sourceReceipt, resultReceipt);
      assert.equal(page.trust, "OBSERVATION_NOT_ACCEPTANCE");
      return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    () => reply("ready for independent verification"),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS", JSON.stringify(s.db.prepare("SELECT error FROM tasks WHERE run=?").all(result.id)));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs").get()!.n, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='job.intent'").get()!.n, 1);
  const state: any = s.readArtifact(s.db.prepare("SELECT state FROM agent_threads WHERE run=?").get(result.id)!.state);
  assert.equal(state.toolCalls, 3); // run, read, edit; polling uses no model turn
}, s => {
  const template = join(dirname(s.project), "job-template.json");
  writeFileSync(template, JSON.stringify({ argv: [executable("python3"), "-c",
    "import os,json;from pathlib import Path;" +
    "Path(os.environ['FUTURE_JOB_RESULT_PATH']).write_text(json.dumps({'score':0.87,'samples':12}));" +
    "print('HEADER_EVIDENCE');print('x'*12000)"], timeoutMs: 3000, resultMaxBytes: 1024, maxLogBytes: 20000 }));
  s.jobs = { trial: { adapter: { argv: [executable("python3"), resolve("scripts/research-job-agent.py"),
    "--root", join(dirname(s.project), "job-spool"), "--config", template],
    files: [resolve("scripts/research-job-agent.py"), template] },
    idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 4, maxConcurrent: 2 } };
  s.agents.coder.tools.push("run_job", "read_job_artifact"); s.agents.coder.jobs = ["trial"];
}));

test("artifact reads enforce thread ownership, job capabilities and exact bounded reply binding", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([{ ...task(), readScope: ["src/a.txt"] },
    { ...task("b"), readScope: ["src/b.txt"] }]);
  const a = q.capsule(q.claim(run, "first")!), b = q.capsule(q.claim(run, "second")!);
  const journal = new SessionJournal(s), raw = Buffer.from("observed bytes");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  let rpcCalls = 0, change: any = {};
  const jobs = new ResearchJobs(journal, cfg, async (_command, _config, input) => {
    rpcCalls++;
    const r: any = input;
    if (r.operation === "read_artifact") return { schema: 1, key: r.key, jobId: r.jobId,
      artifact: r.artifact, sha256, offset: r.offset, bytes: raw.length,
      contentBase64: raw.toString("base64"), nextOffset: null, ...change };
    return { schema: 1, key: r.key, jobId: r.key, status: "FAILED", result: {
      exitCode: 1, artifacts: { stdout: { sha256, bytes: raw.length } } } };
  });
  const result = await jobs.execute(a, cfg.spec.agents.coder, { id: "trial", name: "run_job",
    arguments: { name: "trial", input: {} } }, signal());
  const receipt = journal.receipt(a, result);
  const call = { id: "read", name: "read_job_artifact", arguments: { receipt, artifact: "stdout", offset: 0, length: 8192 } };
  await assert.rejects(jobs.readArtifact(b, cfg.spec.agents.coder, call, signal()), /owned|this thread/);
  await assert.rejects(jobs.readArtifact(a, { ...cfg.spec.agents.coder, jobs: [] }, call, signal()), /capability/);
  await assert.rejects(jobs.readArtifact(a, cfg.spec.agents.coder, { ...call, arguments: { ...call.arguments, length: 8193 } }, signal()), /range/);
  assert.equal(rpcCalls, 1);
  const page: any = await jobs.readArtifact(a, cfg.spec.agents.coder, call, signal());
  assert.equal(page.content, raw.toString());
  for (const bad of [{ key: "b".repeat(64) }, { sha256: "c".repeat(64) }, { offset: 1 },
    { bytes: raw.length + 1 }, { contentBase64: "invalid base64" },
    { contentBase64: Buffer.alloc(raw.length, 120).toString("base64") }, { nextOffset: 1 }]) {
    change = bad;
    await assert.rejects(jobs.readArtifact(a, cfg.spec.agents.coder, call, signal()), /INVALID_JOB_ARTIFACT/);
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs").get()!.n, 1);
  const isolated = journal.receipt(a, { unrelated: true });
  await assert.rejects(jobs.readArtifact(a, cfg.spec.agents.coder, { ...call,
    arguments: { ...call.arguments, receipt: isolated } }, signal()), /terminal job/);
}, s => {
  s.jobs = { trial: { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
    idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 4, maxConcurrent: 2 } };
  s.agents.coder.tools.push("run_job", "read_job_artifact"); s.agents.coder.jobs = ["trial"];
}));
