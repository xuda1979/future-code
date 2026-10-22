import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { FatalAttemptError } from "../../src/harness/foundry/errors.ts";
import { ResearchJobs, type JobReply, type JobRPC } from "../../src/harness/foundry/swarm/jobs.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import type { PinnedSwarm, SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { fixture, signal, task } from "./swarm-fixtures.ts";

function configure(spec: SwarmSpec): void {
  spec.jobs = { experiment: {
    adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
    idempotentEnsure: true, pollMs: 100, staleMs: 1000, reconcileAfterMs: 10000,
    maxJobs: 1, maxConcurrent: 1, experiment: { reuseIdentical: true },
  } };
  spec.agents.coder.tools.push("run_job"); spec.agents.coder.jobs = ["experiment"];
}
const call = (id: string) => ({ id, name: "run_job", arguments: { name: "experiment", input: { seed: 7 } } });
const reply = (key: string, status: JobReply["status"], jobId = "remote-1"): JobReply =>
  ({ schema: 1, key, jobId, status, ...(status === "SUCCEEDED" ? { result: { score: 0.9 } } : {}) });

/** Release the RPC explicitly: no wall-clock sleeps or assumed callback order. */
function pendingRPC() {
  const started = Promise.withResolvers<any>(), response = Promise.withResolvers<unknown>();
  const rpc: JobRPC = async (_command, _cfg, request) => { started.resolve(request); return response.promise; };
  return { rpc, started: started.promise, ...response };
}

async function controllers(store: Store, cfg: PinnedSwarm, run: (ctx: {
  start: (rpc: JobRPC, id: string) => Promise<unknown>;
  batch: (rpc: JobRPC) => Promise<PromiseSettledResult<unknown>[]>;
  peer: Store; runId: string; jobs: ResearchJobs;
}) => Promise<void>): Promise<void> {
  const scheduler = new Scheduler(store), runId = scheduler.start([task()]);
  const capsule = scheduler.capsule(scheduler.claim(runId, "worker")!);
  const journal = new SessionJournal(store);
  journal.open(capsule, { turns: 0, toolCalls: 0, patchHash: null, pending: null,
    output: null, feedbackHash: null, contextLimit: 32768, history: [{ role: "user", content: "task" }] });
  const jobs = new ResearchJobs(journal, cfg);
  const peer = await Store.open(store.root);
  try {
    await run({ peer, runId, jobs, batch: rpc => {
      const shared = new ResearchJobs(journal, cfg, rpc);
      return Promise.allSettled(["a", "b", "c"].map(id =>
        shared.execute(capsule, cfg.spec.agents.coder, call(id), signal())));
    }, start: (rpc, id) =>
      new ResearchJobs(new SessionJournal(id === "first" ? store : peer), cfg, rpc)
        .execute(capsule, cfg.spec.agents.coder, call(id), signal()) });
    assert.equal(scheduler.summary(runId).accepted, 0, "remote completion never accepts a task");
  } finally { peer.close(); }
}

for (const outcome of ["RUNNING", "transport-error"] as const) {
  test(`late ${outcome} preserves an operator-reconciled terminal receipt`, async () => fixture(async (s, cfg) =>
    controllers(s, cfg, async ({ start, jobs, runId }) => {
      const pending = pendingRPC();
      const result = start(pending.rpc, "first");
      const request = await pending.started;
      const terminal = jobs.reconcile(runId, request.key, reply(request.key, "SUCCEEDED"));
      const before = s.db.prepare("SELECT * FROM research_jobs").get()!;
      // Observe rejection immediately too, so the unfixed case cannot leak one.
      const settled = Promise.allSettled([result]);
      if (outcome === "transport-error") pending.reject(new Error("connection lost after reconciliation"));
      else pending.resolve(reply(request.key, outcome));
      const [observed] = await settled;
      assert.deepEqual(s.db.prepare("SELECT * FROM research_jobs").get(), before);
      assert.equal(observed.status, "fulfilled");
      if (observed.status === "fulfilled") assert.deepEqual(observed.value, terminal);
    }), configure));
}

test("a late nonterminal peer reply reuses the terminal result without another RPC", async () => fixture(async (s, cfg) =>
  controllers(s, cfg, async ({ start }) => {
    const pending = pendingRPC(), result = start(pending.rpc, "first");
    const request = await pending.started;
    const terminal = await start(async () => reply(request.key, "SUCCEEDED"), "second");
    const before = s.db.prepare("SELECT * FROM research_jobs").get()!;
    const settled = Promise.allSettled([result]); pending.resolve(reply(request.key, "RUNNING"));
    const [observed] = await settled;
    assert.deepEqual(s.db.prepare("SELECT * FROM research_jobs").get(), before);
    assert.equal(observed.status, "fulfilled");
    if (observed.status === "fulfilled") assert.deepEqual(observed.value, terminal);
  }), configure));

test("coalesced replies count one poll and keep its progress deadline", async () => fixture(async (s, cfg) =>
  controllers(s, cfg, async ({ batch }) => {
    let rpcs = 0;
    const rpc: JobRPC = async (_command, _cfg, request: any) => {
      rpcs++; return reply(request.key, "RUNNING");
    };
    const first = await batch(rpc);
    assert.ok(first.every(r => r.status === "rejected" && r.reason instanceof DeferredAttemptError));
    const before = s.db.prepare("SELECT * FROM research_jobs").get()!;
    assert.equal(before.idle_polls, 0, "one newly running observation is progress, not idle polls");
    s.db.prepare("UPDATE research_jobs SET poll_at=0").run();
    const next = await batch(rpc);
    assert.ok(next.every(r => r.status === "rejected" && r.reason instanceof DeferredAttemptError));
    const after = s.db.prepare("SELECT * FROM research_jobs").get()!;
    assert.equal(rpcs, 2); assert.equal(after.idle_polls, 1);
    assert.equal(after.progress_at, before.progress_at); assert.equal(after.stale_at, before.stale_at);
  }), configure));

test("one coalesced transport failure records one retry rather than one per alias", async () => fixture(async (s, cfg) =>
  controllers(s, cfg, async ({ batch }) => {
    let rpcs = 0;
    const outcomes = await batch(async () => { rpcs++; throw new Error("offline"); });
    assert.ok(outcomes.every(r => r.status === "rejected" && r.reason instanceof DeferredAttemptError));
    assert.equal(rpcs, 1); assert.equal(s.db.prepare("SELECT failures FROM research_jobs").get()!.failures, 1);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='job.reconciling'").get()!.n, 1);
  }), configure));

test("a coalesced caller can reconcile a reply after the RPC owner's deadline", async () => fixture(async (s, cfg) =>
  controllers(s, cfg, async ({ batch }) => {
    const outcomes = await batch(async (_command, _cfg, request: any, rpcSignal) =>
      new Promise(resolve => rpcSignal.addEventListener("abort", () => {
        // Model a transport that ignores cancellation and delivers its reply
        // just after the owner has recorded a timed-out, unknown outcome.
        queueMicrotask(() => resolve(reply(request.key, "SUCCEEDED")));
      }, { once: true })));
    assert.ok(outcomes.some(r => r.status === "rejected" && r.reason instanceof DeferredAttemptError));
    assert.ok(outcomes.some(r => r.status === "fulfilled"));
    assert.equal(s.db.prepare("SELECT status FROM research_jobs").get()!.status, "SUCCEEDED");
  }), s => { configure(s); s.budget.toolTimeoutMs = 500; }));

test("concurrent initial replies cannot replace a remote identity learned by another connection", async () => fixture(async (s, cfg) =>
  controllers(s, cfg, async ({ start }) => {
    const pending = pendingRPC(), result = start(pending.rpc, "first");
    const request = await pending.started;
    await assert.rejects(start(async () => reply(request.key, "RUNNING"), "second"), DeferredAttemptError);
    const before = s.db.prepare("SELECT * FROM research_jobs").get()!;
    const rejected = assert.rejects(result, FatalAttemptError);
    pending.resolve(reply(request.key, "RUNNING", "different-remote-job"));
    await rejected;
    assert.deepEqual(s.db.prepare("SELECT * FROM research_jobs").get(), before);
  }), configure));

for (const status of ["RUNNING", "QUEUED", "UNKNOWN"] as const) {
  test(`late ${status} merges progress against durable state without renewing a stale job`, async () => fixture(async (s, cfg) =>
    controllers(s, cfg, async ({ start, peer }) => {
      const pending = pendingRPC(), result = start(pending.rpc, "first");
      const request = await pending.started;
      await assert.rejects(start(async () => reply(request.key, "RUNNING"), "second"), DeferredAttemptError);
      // Make the newer observation stale while the old request remains pending.
      const progressAt = Date.now() - 2000, staleAt = progressAt + 1000;
      peer.db.prepare("UPDATE research_jobs SET progress_at=?,stale_at=?,idle_polls=3").run(progressAt, staleAt);
      const rejected = assert.rejects(result, (error: unknown) => {
        assert.ok(error instanceof DeferredAttemptError); assert.equal(error.kind, "remote-stalled"); return true;
      });
      pending.resolve(reply(request.key, status)); await rejected;
      const row = s.db.prepare("SELECT * FROM research_jobs").get()!;
      assert.equal(row.progress_at, progressAt); assert.equal(row.stale_at, staleAt);
      assert.equal(row.progress_rank, 2); assert.equal(row.idle_polls, 4);
    }), configure));
}

test("conflicting terminal replies still fail closed and leave the first receipt intact", async () => fixture(async (s, cfg) =>
  controllers(s, cfg, async ({ start }) => {
    const pending = pendingRPC(), result = start(pending.rpc, "first");
    const request = await pending.started;
    await start(async () => reply(request.key, "SUCCEEDED"), "second");
    const before = s.db.prepare("SELECT * FROM research_jobs").get()!;
    const rejected = assert.rejects(result, /concurrent job result drift/);
    pending.resolve(reply(request.key, "FAILED")); await rejected;
    assert.deepEqual(s.db.prepare("SELECT * FROM research_jobs").get(), before);
  }), configure));

test("duplicate terminal replies from independent connections remain idempotent", async () => fixture(async (s, cfg) =>
  controllers(s, cfg, async ({ start }) => {
    const pending = pendingRPC(), result = start(pending.rpc, "first");
    const request = await pending.started;
    const terminal = await start(async () => reply(request.key, "SUCCEEDED"), "second");
    const before = s.db.prepare("SELECT * FROM research_jobs").get()!;
    pending.resolve(reply(request.key, "SUCCEEDED"));
    assert.deepEqual(await result, terminal);
    assert.deepEqual(s.db.prepare("SELECT * FROM research_jobs").get(), before);
  }), configure));
