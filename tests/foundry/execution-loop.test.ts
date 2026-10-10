import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { ResearchJobs } from "../../src/harness/foundry/swarm/jobs.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { rebuildRequestAccounting, runRequestTotals, objectiveRequestTotals } from "../../src/harness/foundry/swarm/requestAccounting.ts";
import { installObjectives } from "../../src/harness/foundry/swarm/supervisor.ts";
import { fixture, task, signal } from "./swarm-fixtures.ts";

test("request counters preserve unknown spend, expiry, late replies and exact budget limits", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  const j = new SessionJournal(s), budget = { ...cfg.spec.budget, maxRequests: 3 };
  const a = await j.reserve(c, "pool", { input: 1 }, budget, signal());
  j.complete(a, null, null);
  const b = await j.reserve(c, "pool", { input: 2 }, budget, signal());
  j.complete(b, 0, { ok: true });
  const lost = await j.reserve(c, "pool", { input: 3 }, budget, signal());
  s.db.prepare("UPDATE agent_requests SET deadline=0 WHERE id=?").run(lost);
  await assert.rejects(j.reserve(c, "pool", { input: 4 }, budget, signal()), /RUN_REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(s.db.prepare("SELECT status FROM agent_requests WHERE id=?").get(lost)!.status, "ACTIVE",
    "budget failure rolls back expiry bookkeeping in the same transaction");
  // A recovery process expires the permit without refunding any request/byte.
  s.db.prepare("UPDATE agent_requests SET status='UNKNOWN' WHERE id=?").run(lost);
  j.complete(lost, 7, { late: true });
  const before = j.usage(run);
  assert.equal(before.requests, 3); assert.equal(before.knownTokens, 7); assert.equal(before.tokens, null);
  const exact = s.db.prepare("SELECT COUNT(*) AS n,SUM(bytes) AS bytes FROM agent_requests WHERE run=?").get(run)!;
  assert.equal(runRequestTotals(s, run).requests, exact.n); assert.equal(before.requestBytes, exact.bytes);
  assert.deepEqual(j.usage(run, c.task.id, c.fence), before);
  rebuildRequestAccounting(s);
  assert.deepEqual(new SessionJournal(s).usage(run), before);
  s.db.prepare("DELETE FROM agent_request_totals WHERE run=? AND task='' AND fence=0").run(run);
  assert.throws(() => runRequestTotals(s, run), /REQUEST_ACCOUNTING_MISSING/);
  rebuildRequestAccounting(s);
  const plan = s.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM agent_request_totals WHERE run=? AND task='' AND fence=0").all(run);
  assert.ok(plan.some(r => /SEARCH.*INDEX/.test(String(r.detail))), "budget lookup uses its primary-key index");
}));

test("objective ceilings count every revision once, including control-plane and unknown requests", async () => fixture(async (s, cfg) => {
  installObjectives(s);
  const q = new Scheduler(s), first = q.start([task()]), second = q.start([task()]);
  const c = q.capsule(q.claim(first, "one")!), next = q.capsule(q.claim(second, "two")!);
  s.db.prepare("INSERT INTO swarm_objectives(id,goal,plan,cfg,run,state,updated) VALUES('o','goal','p','cfg',?,'RUNNING',?)").run(second, Date.now());
  for (const [revision, run] of [[0, first], [1, second]] as const)
    s.db.prepare("INSERT INTO swarm_objective_revisions VALUES('o',?,'p',?,'r',?)").run(revision, run, Date.now());
  s.db.prepare("INSERT INTO swarm_objective_budgets VALUES('o',2,1000000)").run();
  const j = new SessionJournal(s);
  const id = await j.reserve(c, "pool", { work: true }, cfg.spec.budget, signal()); j.complete(id, null, null);
  const control = await j.reserveRun(second, "recovery-plan", "pool", { plan: true }, cfg.spec.budget, signal());
  j.complete(control, 3, { proposal: true });
  assert.equal(objectiveRequestTotals(s, "o").requests, 2);
  await assert.rejects(j.reserve(next, "pool", { more: true }, cfg.spec.budget, signal()), /OBJECTIVE_REQUEST_BUDGET_EXHAUSTED/);
}));

test("commit wakes a long idle wait, rollback does not, and another handle cannot lose a wake", async () => fixture(async s => {
  const before = s.observeChanges();
  assert.throws(() => s.transaction(() => { s.event("rolled-back", {}); throw new Error("rollback"); }));
  assert.equal(s.observeChanges().revision, before.revision);
  const other = await Store.open(s.root);
  try {
    const started = performance.now();
    other.transaction(() => other.event("work.available", {}));
    // Commit precedes registration: checking the observed generation must catch it.
    await s.waitForChange(before, 20000);
    assert.ok(performance.now() - started < 1500);
    const controller = new AbortController(), now = s.observeChanges();
    const wait = s.waitForChange(now, 20000, controller.signal); controller.abort(); await wait;
  } finally { other.close(); }
}));

test("cross-process SQLite commits wake supervision before its 20-second timeout", async () => fixture(async s => {
  const observed = s.observeChanges(), started = performance.now();
  const wait = s.waitForChange(observed, 20000);
  const module = new URL("../../src/harness/foundry/store.ts", import.meta.url).href;
  execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    "const {Store}=await import(process.argv[1]);const s=await Store.open(process.argv[2]);s.transaction(()=>s.event('external.ready',{}));s.close();",
    module, s.root], { stdio: "pipe", timeout: 5000 });
  await wait;
  assert.ok(performance.now() - started < 5000, "data_version poll must interrupt the long idle wait");
}));

const withJobs = (s: Parameters<NonNullable<Parameters<typeof fixture>[1]>>[0]) => {
  s.jobs = { exp: { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
    idempotentEnsure: true, pollMs: 20000, staleMs: 60000, maxJobs: 4, maxConcurrent: 1 } };
  s.agents.coder.jobs = ["exp"]; s.agents.coder.tools.push("run_job");
};
test("remote reconciliation wakes both result and capacity waiters without duplicate ensure", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task("a"), { ...task("b"), priority: -1 }]);
  const a = q.claim(run, "a")!, ca = q.capsule(a), ops: string[] = [];
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_cmd, _cfg, request) => {
    const r = request as any; ops.push(r.operation);
    return { schema: 1, key: r.key, jobId: "remote-" + r.key, status: "RUNNING", progressToken: "step-1" };
  });
  const call = { id: "one", name: "run_job", arguments: { name: "exp", input: {} } };
  let waiting: DeferredAttemptError | undefined;
  try { await jobs.execute(ca, cfg.spec.agents.coder, call, signal()); }
  catch (e) { assert.ok(e instanceof DeferredAttemptError); waiting = e; }
  q.defer(a, waiting!);
  const b = q.claim(run, "b")!, cb = q.capsule(b);
  let capacity: DeferredAttemptError | undefined;
  try { await jobs.execute(cb, cfg.spec.agents.coder, call, signal()); }
  catch (e) { assert.ok(e instanceof DeferredAttemptError); capacity = e; }
  assert.match(capacity!.message, /capacity busy/);
  const observed = s.observeChanges(), row = s.db.prepare("SELECT key,job_id FROM research_jobs WHERE run=?").get(run)!;
  jobs.reconcile(run, String(row.key), { schema: 1, key: String(row.key), jobId: String(row.job_id), status: "SUCCEEDED", result: { score: 1 } });
  // Reconciliation precedes deferral: even this ordering must not lose the wake.
  q.defer(b, capacity!);
  await s.waitForChange(observed, 20000);
  const waits = s.db.prepare("SELECT wake FROM task_waits WHERE run=?").all(run);
  assert.equal(waits.length, 2); assert.ok(waits.every(w => w.wake <= Date.now()));
  assert.deepEqual(ops, ["ensure"]); assert.equal(q.summary(run).accepted, 0);
}, withJobs));

test("a non-cooperating job RPC is bounded and retains an unresolved identity for recovery", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async () => new Promise(() => {}));
  const started = performance.now();
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder,
    { id: "hang", name: "run_job", arguments: { name: "exp", input: {} } }, signal()), DeferredAttemptError);
  assert.ok(performance.now() - started < 1500);
  const row = s.db.prepare("SELECT status,result_hash,failures FROM research_jobs WHERE run=?").get(run)!;
  assert.equal(row.status, "UNKNOWN"); assert.equal(row.result_hash, null); assert.equal(row.failures, 1);
  assert.equal(q.summary(run).accepted, 0);
}, s => { withJobs(s); s.budget.toolTimeoutMs = 30; }));
