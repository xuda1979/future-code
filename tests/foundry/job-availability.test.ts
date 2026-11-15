import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { ResearchJobs } from "../../src/harness/foundry/swarm/jobs.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { fixture, signal, task } from "./swarm-fixtures.ts";

test("live job status preserves distinct execution and goal observations across restart without accepting them", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  const journal = new SessionJournal(s);
  journal.open(c, { history: [{ role: "user", content: "immutable task" }], turns: 1,
    toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 32768 });
  const supervision = { attempts: 2, restarts: 1, phase: "RUNNING", lastSequence: 17,
    goal: { name: "heldout_score", value: 0.2, baseline: 0.2, delta: 0, status: "UNCHANGED",
      trust: "OBSERVATION_NOT_ACCEPTANCE" } };
  const jobs = new ResearchJobs(journal, cfg, async (_cmd, _cfg, raw) => {
    const r: any = raw;
    return { schema: 1, key: r.key, jobId: r.key, status: "RUNNING", progressToken: "17",
      result: { supervision } };
  });
  const call = { id: "experiment", name: "run_job", arguments: { name: "trial", input: { seed: 7 } } };
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, call, signal()), DeferredAttemptError);
  const row = s.db.prepare("SELECT * FROM research_jobs WHERE run=?").get(run)!;
  assert.equal(row.result_hash, null, "nonterminal telemetry cannot become a terminal receipt");
  assert.equal(s.db.prepare("SELECT status FROM tasks WHERE run=?").get(run)!.status, "RUNNING");
  const projected: any = jobs.list(run);
  assert.deepEqual(projected.items[0].observation.supervision, supervision);
  assert.equal(projected.items[0].observation.trust, "OBSERVATION_NOT_ACCEPTANCE");
  assert.ok(row.observation_hash);
  const readArtifact = s.readArtifact;
  s.readArtifact = () => { throw new Error("status must not read cold evidence"); };
  try { assert.deepEqual(jobs.list(run), projected); }
  finally { s.readArtifact = readArtifact; }
  const reopened = await Store.open(s.root);
  try {
    const persisted: any = new ResearchJobs(new SessionJournal(reopened), cfg).list(run);
    assert.deepEqual(persisted.items[0].observation, projected.items[0].observation);
  } finally { reopened.close(); }
  // Lost connectivity makes the process state UNKNOWN. The last observation
  // stays explicitly historical, and never renews the semantic deadline.
  const progressAt = row.progress_at;
  s.db.prepare("UPDATE research_jobs SET poll_at=0 WHERE key=?").run(row.key);
  const failed = new ResearchJobs(journal, cfg, async () => { throw new Error("transport offline"); });
  await assert.rejects(failed.execute(c, cfg.spec.agents.coder, call, signal()), DeferredAttemptError);
  const unknown: any = failed.list(run);
  assert.equal(unknown.items[0].status, "UNKNOWN");
  assert.equal(unknown.items[0].progress_at, progressAt);
  assert.equal(unknown.items[0].observation.remoteStatus, "RUNNING");
  assert.equal(unknown.items[0].observation.current, false);
  assert.equal(unknown.items[0].result_hash, null);
}, s => {
  s.jobs = { trial: { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
    idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 3, maxConcurrent: 1 } };
  s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = ["trial"];
}));

test("same-millisecond concurrent status replies cannot replace a newer summary with stale telemetry", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  const journal = new SessionJournal(s);
  journal.open(c, { history: [{ role: "user", content: "immutable task" }], turns: 1,
    toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 32768 });
  const call = { id: "experiment", name: "run_job", arguments: { name: "trial", input: { seed: 7 } } };
  const response = (key: string, attempts: number) => ({ schema: 1, key, jobId: key, status: "RUNNING",
    progressToken: "17", result: { supervision: { attempts, lastSequence: 17 } } });
  const dateNow = Date.now, fixedNow = dateNow();
  Date.now = () => fixedNow;
  try {
    const jobs = new ResearchJobs(journal, cfg, async (_cmd, _cfg, r: any) => response(r.key, 1));
    await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, call, signal()), DeferredAttemptError);
    s.db.prepare("UPDATE research_jobs SET poll_at=0").run();
    const newer = Promise.withResolvers<unknown>(), older = Promise.withResolvers<unknown>();
    const newStarted = Promise.withResolvers<string>(), oldStarted = Promise.withResolvers<string>();
    const fresh = new ResearchJobs(journal, cfg, async (_cmd, _cfg, r: any) => {
      newStarted.resolve(r.key); return newer.promise;
    });
    const stale = new ResearchJobs(journal, cfg, async (_cmd, _cfg, r: any) => {
      oldStarted.resolve(r.key); return older.promise;
    });
    const first = fresh.execute(c, cfg.spec.agents.coder, call, signal());
    const a = await newStarted.promise;
    const second = stale.execute(c, cfg.spec.agents.coder, call, signal());
    const b = await oldStarted.promise;
    const rejectedFirst = assert.rejects(first, DeferredAttemptError);
    const rejectedSecond = assert.rejects(second, DeferredAttemptError);
    newer.resolve(response(a, 3)); await rejectedFirst;
    older.resolve(response(b, 2)); await rejectedSecond;
    assert.equal((jobs.list(run) as any).items[0].observation.supervision.attempts, 3);
    // Oversized telemetry remains only in cold evidence, even with a generous
    // adapter output budget. Ordinary status stays a small DB projection.
    s.db.prepare("UPDATE research_jobs SET poll_at=0").run();
    const large = new ResearchJobs(journal, cfg, async (_cmd, _cfg, r: any) => ({ ...response(r.key, 4),
      result: { supervision: { transcript: "x".repeat(9000) } } }));
    await assert.rejects(large.execute(c, cfg.spec.agents.coder, call, signal()), DeferredAttemptError);
    const small: any = jobs.list(run);
    assert.equal(small.items[0].observation.supervision, undefined);
    assert.ok(JSON.stringify(small).length < 2000);
  } finally { Date.now = dateNow; }
}, s => {
  s.jobs = { trial: { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
    idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 3, maxConcurrent: 1 } };
  s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = ["trial"];
}));
