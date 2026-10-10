import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { ResearchJobs, nextRemotePollMs } from "../../src/harness/foundry/swarm/jobs.ts";
import { checkpointInputKey, shouldRunExploratoryCheckpoint } from "../../src/harness/foundry/swarm/checkpointPolicy.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { fixture, task, signal } from "./swarm-fixtures.ts";

test("remote polls preserve fixed cadence unless idle backoff is configured", () => {
  for (const idlePolls of [0, 1, 2, 3, 100]) {
    assert.equal(nextRemotePollMs({ pollMs: 100 }, idlePolls), 100);
  }
  const policy = { pollMs: 100, maxPollMs: 1600 };
  assert.equal(nextRemotePollMs(policy, 0), 100);
  assert.equal(nextRemotePollMs(policy, 1), 100);
  assert.equal(nextRemotePollMs(policy, 2), 200);
  assert.equal(nextRemotePollMs(policy, 3), 400);
  assert.equal(nextRemotePollMs(policy, 100), 1600);
  assert.equal(nextRemotePollMs({ pollMs: 100, maxPollMs: 500 }, 4), 500);
  assert.equal(nextRemotePollMs({ pollMs: 5000, maxPollMs: 60000 }, 20), 60000);
  assert.equal(nextRemotePollMs({ pollMs: 120000 }, 20), 120000);
  for (const idlePolls of [-1, 0.5, NaN, Infinity]) {
    assert.equal(nextRemotePollMs(policy, idlePolls), 100);
  }
});

test("only delayed roots gain long idle waits; runnable or leased work retains low latency", async () => fixture(async s => {
  const scheduler = new Scheduler(s);
  const run = scheduler.start([task("a")]);
  const now = Date.now();
  assert.equal(scheduler.suggestIdleWaitMs(run, 25, now), 25, "runnable work must start immediately");
  const lease = scheduler.claim(run, "w")!;
  assert.equal(scheduler.suggestIdleWaitMs(run, 25, now), 25, "running work may finish in another process");
  const wake = Date.now() + 20000;
  scheduler.defer(lease, new DeferredAttemptError("remote-job", wake, "remote compute running"));
  assert.equal(scheduler.suggestIdleWaitMs(run, 25, wake - 60000), 30000, "long waits retain a bounded rescan interval");
  assert.equal(scheduler.suggestIdleWaitMs(run, 25, wake - 15000), 15000, "known future wake avoids hot scanning");
  assert.equal(scheduler.suggestIdleWaitMs(run, 25, wake - 60), 60, "near-term wake is not delayed");
  assert.equal(scheduler.suggestIdleWaitMs(run, 25, wake - 1), 25, "short waits retain the fallback interval");
  assert.equal(scheduler.suggestIdleWaitMs(run, 25, wake + 1), 25, "ready again at wake");
}));

test("remote poll cadence is durable, milestone-aware, and cannot confer acceptance", async () => fixture(async (s, cfg) => {
  const scheduler = new Scheduler(s);
  const run = scheduler.start([task()]);
  const lease = scheduler.claim(run, "w")!;
  const capsule = scheduler.capsule(lease);
  const messages = ["step-1", "step-1", "step-1", "step-2", "step-2", "step-2", "end"];
  const ops: string[] = [];
  let n = 0;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_command, _cfg, request) => {
    const r = request as any;
    ops.push(r.operation);
    const next = messages[n++]!;
    return { schema: 1, key: r.key, jobId: "stable-remote-id",
      status: next === "end" ? "SUCCEEDED" : "RUNNING",
      ...(next === "end" ? { result: { quality: 0.75 } } : { progressToken: next }) };
  });
  const call = { id: "exp", name: "run_job", arguments: { name: "train", input: { seed: 1 } } };
  const inspect = () => s.db.prepare("SELECT idle_polls,poll_at,stale_at,progress_at,reconciliation_hash FROM research_jobs WHERE run=?").get(run)!;
  async function wait() {
    await assert.rejects(jobs.execute(capsule, cfg.spec.agents.coder, call, signal()), DeferredAttemptError);
    const row = inspect();
    s.db.prepare("UPDATE research_jobs SET poll_at=0 WHERE run=?").run(run);
    return row;
  }
  const first = await wait(); assert.equal(first.idle_polls, 0);
  const second = await wait(); assert.equal(second.idle_polls, 1);
  const third = await wait(); assert.equal(third.idle_polls, 2);
  assert.ok(third.poll_at - Date.now() >= 100, "idle backoff doubles the poll interval");
  assert.equal(third.stale_at, first.stale_at, "a repeated milestone must not renew liveness");
  const changed = await wait(); assert.equal(changed.idle_polls, 0);
  assert.ok(changed.progress_at >= first.progress_at, "new semantic progress resets cadence");
  const again = await wait(); assert.equal(again.idle_polls, 1);
  const still = await wait(); assert.equal(still.idle_polls, 2);
  const finished: any = await jobs.execute(capsule, cfg.spec.agents.coder, call, signal());
  assert.equal(finished.status, "SUCCEEDED");
  assert.equal(ops[0], "ensure"); assert.ok(ops.slice(1).every(op => op === "inspect"));
  assert.equal(scheduler.summary(run).accepted, 0, "remote success does not count as host verification");
  assert.ok(inspect().reconciliation_hash, "terminal result retains an attested receipt");
}, spec => {
  spec.jobs = { train: { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
    idempotentEnsure: true, pollMs: 100, maxPollMs: 800, staleMs: 5000, maxJobs: 2, maxConcurrent: 1 } };
  spec.agents.coder.jobs = ["train"]; spec.agents.coder.tools.push("run_job");
}));

test("exploratory checkpoints can skip unchanged inputs without affecting strict final verification", () => {
  const key = checkpointInputKey("patch-sha", 0);
  assert.equal(shouldRunExploratoryCheckpoint(undefined, key, "on-change"), true);
  assert.equal(shouldRunExploratoryCheckpoint(key, key, "on-change"), false);
  assert.equal(shouldRunExploratoryCheckpoint(key, checkpointInputKey("new-patch", 0), "on-change"), true);
  assert.equal(shouldRunExploratoryCheckpoint(key, checkpointInputKey("patch-sha", 1), "on-change"), true);
  assert.equal(shouldRunExploratoryCheckpoint(key, key, "periodic"), true);
  assert.equal(shouldRunExploratoryCheckpoint(key, key, undefined), false);
  assert.equal(shouldRunExploratoryCheckpoint(undefined, key, undefined), true);
  assert.equal(shouldRunExploratoryCheckpoint(key, checkpointInputKey("patch-sha", 0, "new-remote-evidence")), true);
});
