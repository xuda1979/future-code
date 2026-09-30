import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { runHealth, formatHealth } from "../../src/harness/foundry/health.ts";
import type { Driver, Task, Recipe, Contract, Lease } from "../../src/harness/foundry/types.ts";
import { ResearchJobs, type JobRPC } from "../../src/harness/foundry/swarm/jobs.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { HttpBrain, isTransportFailure } from "../../src/harness/foundry/swarm/model.ts";
import { createApiRecoveryPlanner } from "../../src/harness/foundry/swarm/recovery.ts";
import { FatalAttemptError } from "../../src/harness/foundry/errors.ts";
import { superviseSwarm, objectiveStatus } from "../../src/harness/foundry/swarm/supervisor.ts";
import { runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { validateSwarmSpec, type SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { fixture as swarmFixture, task as swarmTask, scripted, reply, signal, spec } from "./swarm-fixtures.ts";

const c: Contract = { schema: 1, name: "resilience", workerId: "w", verifierId: "v", environmentId: "e", requiredChecks: ["behavior"], slos: [],
  limits: { parallelism: 8, attempts: 4, contextBytes: 50000, outputBytes: 50000, timeoutMs: 5000, tasks: 100 } };
const recipe: Recipe = { parallelism: 2, attempts: 1, contextBytes: 20000, timeoutMs: 1000 };
const task = (id = "a", deps: string[] = []): Task => ({ id, goal: id, acceptance: ["correct"], input: null, writeScope: [`src/${id}`], dependencies: deps });
const driver = (): Driver => ({ workerId: "w", verifierId: "v", async execute() { return { artifact: { ok: true }, measurement: { tokens: 0, costUsd: 0 } }; },
  async verify(_c, r) { return { artifactHash: digest(r.artifact), checks: [{ id: "behavior", verdict: "PASS" }], measurement: { tokens: 0, costUsd: 0 } }; } });
async function fixture(fn: (s: Store) => Promise<void>, changes: Partial<Recipe> = {}, contract: Contract = c) {
  const path = mkdtempSync(join(tmpdir(), "resilience-")); const s = await Store.open(path);
  try { s.initialize(contract, { ...recipe, ...changes }); await fn(s); }
  finally { s.close(); rmSync(path, { recursive: true, force: true }); }
}
function jobSpec(s: SwarmSpec) {
  s.jobs = { train: { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] }, idempotentEnsure: true, pollMs: 10, staleMs: 1000, maxJobs: 10, maxConcurrent: 2 } };
  s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = ["train"];
}
const jobCall = { id: "experiment-1", name: "run_job", arguments: { name: "train", input: { seed: 7 } } };

for (const count of [2, 12]) test(`${count} deferred episodes do not exhaust one implementation attempt`, async () => fixture(async s => {
  const d = driver(); let n = 0;
  d.execute = async () => { if (++n <= count) throw new DeferredAttemptError("checkpoint", Date.now() + 10, "durable work"); return { artifact: 42 }; };
  const result = await runTasks(s, [task()], d); assert.equal(result.status, "PASS"); assert.equal(result.attempts, count + 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status='FAIL'").get()!.n, 0);
}));
test("deferred task releases the only slot and dependency does not run before acceptance", async () => fixture(async s => {
  const order: string[] = []; let n = 0; const d = driver();
  d.execute = async c => { order.push(c.task.id); if (c.task.id === "a" && ++n === 1) throw new DeferredAttemptError("remote-job", Date.now() + 60, "training"); return { artifact: c.task.id }; };
  const result = await runTasks(s, [task("a"), task("b"), task("c", ["a"])], d);
  assert.equal(result.status, "PASS"); assert.deepEqual(order, ["a", "b", "a", "c"]);
}, { parallelism: 1 }));
test("continuation wakes survive reopening and reject stale ownership", async () => fixture(async s => {
  const q = new Scheduler(s); const id = q.start([task()]); const l = q.claim(id, "first")!;
  assert.equal(q.defer(l, new DeferredAttemptError("remote-job", Date.now() + 100, "waiting")), true);
  const other = await Store.open(s.root);
  try { const q2 = new Scheduler(other); assert.equal(q2.claim(id, "second"), null);
    await delay(110); const newer = q2.claim(id, "second")!; assert.ok(newer.fence > l.fence);
    assert.equal(q.defer(l, new DeferredAttemptError("checkpoint", Date.now(), "stale")), false);
  } finally { other.close(); }
}));
test("a real failure still exhausts the budget after many deferrals", async () => fixture(async s => {
  let n = 0; const d = driver(); d.execute = async () => { if (++n < 4) throw new DeferredAttemptError("provider", Date.now() + 10, "offline"); throw new Error("real failure"); };
  const result = await runTasks(s, [task(), task("b", ["a"])], d); assert.equal(result.status, "FAIL"); assert.equal(result.blocked, 1); assert.equal(n, 4);
}));
test("cancelled work remains resumable without consuming the failure budget", async () => fixture(async s => {
  const ctl = new AbortController(); const d = driver(); d.execute = async () => { setTimeout(() => ctl.abort(), 20); return new Promise(() => {}); };
  const paused = await runTasks(s, [task()], d, { signal: ctl.signal }); assert.equal(paused.status, "RUNNING");
  assert.equal(s.db.prepare("SELECT status FROM attempts").get()!.status, "DEFERRED");
  const done = await runTasks(s, [], driver(), { resumeRun: paused.id }); assert.equal(done.status, "PASS");
}));
test("heartbeats expose a silent worker without pretending it made progress", async () => fixture(async s => {
  const seen: any[] = []; const d = driver(); d.execute = async () => new Promise(() => {});
  const result = await runTasks(s, [task()], d, { reportEveryMs: 10, onProgress: r => seen.push(r) });
  assert.equal(result.status, "FAIL"); assert.ok(seen.length >= 4);
  assert.ok(seen.some(r => r.tasks.some((t: any) => t.stage === "execute" && t.activityAgeMs >= 10 && t.progressAgeMs === null)));
  assert.match(formatHealth(seen.at(-1)), /accepted=0/);
}, { timeoutMs: 90, noProgressMs: 55 }));
test("a chatty worker cannot defeat the no-progress deadline with activity", async () => fixture(async s => {
  const d = driver(); d.execute = async (_c, signal, control) => {
    const timer = setInterval(() => control?.activity?.("still-talking"), 5);
    signal.addEventListener("abort", () => clearInterval(timer), { once: true }); return new Promise(() => {});
  };
  const start = Date.now(); const result = await runTasks(s, [task()], d); assert.equal(result.status, "FAIL"); assert.ok(Date.now() - start < 500);
}, { noProgressMs: 45 }));
test("observer exceptions do not strand leased work", async () => fixture(async s => {
  const result = await runTasks(s, [task()], driver(), { onProgress() { throw new Error("UI offline"); } });
  assert.equal(result.status, "PASS"); assert.ok(s.events().some(e => e.kind === "observer.error"));
}));
test("snapshot reads permit independent writers but never overlapping writers", async () => fixture(async s => {
  const q = new Scheduler(s); const tasks = [task("a"), task("b"), { ...task("c"), writeScope: ["src/a/deeper"] }].map(t => ({ ...t, readScope: ["src"] }));
  const id = q.start(tasks); assert.equal(q.claimMany(id, "workers", 8).length, 2);
}, { parallelism: 8 }, { ...c, readIsolation: "snapshot" }));
test("shared mutable read scopes remain conservative", async () => fixture(async s => {
  const q = new Scheduler(s); const id = q.start([task("a"), task("b")].map(t => ({ ...t, readScope: ["src"] })));
  assert.equal(q.claimMany(id, "workers", 8).length, 1);
}, { parallelism: 8 }));

test("remote job resumes by immutable ID and never re-submits after polling failures", async () => swarmFixture(async (s, cfg) => {
  const q = new Scheduler(s); const run = q.start([swarmTask()]); let l = q.claim(run, "worker")!; const requests: any[] = []; let n = 0;
  const rpc: JobRPC = async (_cmd, _cfg, request) => { const r = request as any; requests.push(r); if (++n === 2) throw new Error("connection lost");
    return { schema: 1, key: r.key, jobId: "remote-007", status: n >= 3 ? "SUCCEEDED" : "RUNNING", ...(n >= 3 ? { result: { accuracy: 1 } } : { progressToken: "step-1" }) }; };
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, rpc);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(jobs.execute(q.capsule(l), cfg.spec.agents.coder, jobCall, signal()), e => {
      assert.ok(e instanceof DeferredAttemptError); q.defer(l, new DeferredAttemptError(e.kind as any, Date.now(), e.message)); return true;
    });
    s.db.prepare("UPDATE research_jobs SET poll_at=0").run(); l = q.claim(run, "worker")!;
  }
  const result: any = await jobs.execute(q.capsule(l), cfg.spec.agents.coder, jobCall, signal());
  assert.equal(result.status, "SUCCEEDED"); assert.deepEqual(requests.map(r => r.operation), ["ensure", "inspect", "inspect"]);
  assert.equal(new Set(requests.map(r => r.key)).size, 1); assert.equal(q.summary(run).accepted, 0, "remote exit is not acceptance");
  const terminal = s.db.prepare("SELECT reconciliation_hash,input_hash FROM research_jobs WHERE run=?").get(run)!;
  assert.match(terminal.reconciliation_hash, /^[a-f0-9]{64}$/);
  const attestation: any = s.readArtifact(terminal.reconciliation_hash);
  assert.equal(attestation.inputHash, terminal.input_hash); assert.equal(attestation.baseCommit, cfg.baseCommit);
  assert.equal(attestation.status, "SUCCEEDED");
}, jobSpec));
test("lost submit reply reconciles the SAME key without duplicate remote execution", async () => swarmFixture(async (s, cfg) => {
  const q = new Scheduler(s); const run = q.start([swarmTask()]); const l = q.claim(run, "w")!; const c = q.capsule(l);
  const remote = new Map<string, string>(); let started = 0; let requests = 0;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_cmd, _cfg, request) => {
    const r = request as any; if (!remote.has(r.key)) { remote.set(r.key, "job-1"); started++; }
    if (++requests === 1) throw new Error("reply lost after remote side effect");
    return { schema: 1, key: r.key, jobId: remote.get(r.key), status: "SUCCEEDED", result: 42 };
  });
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, jobCall, signal()), DeferredAttemptError);
  s.db.prepare("UPDATE research_jobs SET poll_at=0").run(); const result: any = await jobs.execute(c, cfg.spec.agents.coder, jobCall, signal());
  assert.equal(result.result, 42); assert.equal(started, 1); assert.equal(requests, 2);
}, jobSpec));
test("remote job input replay drift and mismatched identity fail closed", async () => swarmFixture(async (s, cfg) => {
  const q = new Scheduler(s); const run = q.start([swarmTask()]); const c = q.capsule(q.claim(run, "w")!); let wrong = false;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_cmd, _cfg, request) => ({ schema: 1, key: (request as any).key, jobId: wrong ? "different" : "first", status: "RUNNING" }));
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, jobCall, signal()), DeferredAttemptError);
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, { ...jobCall, arguments: { ...jobCall.arguments, input: { seed: 99 } } }, signal()), /drift/);
  wrong = true; s.db.prepare("UPDATE research_jobs SET poll_at=0").run(); await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, jobCall, signal()), FatalAttemptError);
}, jobSpec));
test("one model turn fans out independent remote experiments concurrently", async () => swarmFixture(async (s, cfg) => {
  const q = new Scheduler(s); const run = q.start([swarmTask()]); const capsule = q.capsule(q.claim(run, "batch-worker")!);
  let active = 0; let peak = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const operations: any[] = [];
  const rpc: JobRPC = async (_command, _cfg, request) => {
    const r = request as any; operations.push(r);
    active++; peak = Math.max(peak, active);
    if (active === 2) release();
    await Promise.race([
      gate,
      delay(500).then(() => { throw new Error("remote jobs were serialized"); }),
    ]);
    active--;
    return { schema: 1, key: r.key, jobId: `job-${r.key.slice(0, 8)}`,
      status: "SUCCEEDED", result: { seed: r.input.seed } };
  };
  const model = scripted([
    () => reply("", [
      { id: "exp-a", name: "run_job", arguments: { name: "train", input: { seed: 1 } } },
      { id: "exp-b", name: "run_job", arguments: { name: "train", input: { seed: 2 } } },
    ]),
    body => {
      const toolMessages = body.messages.filter((m: any) => m.role === "tool");
      assert.equal(toolMessages.length, 2);
      return reply("experiments completed");
    },
  ]);
  const driver = new SwarmDriver(s, cfg, model.fetcher, undefined, rpc);
  const result = await driver.execute(capsule, signal());
  assert.equal((result.artifact as any).summary, "experiments completed");
  assert.equal(peak, 2, "both experiment submissions must overlap");
  assert.equal(operations.length, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE run=?").get(run)!.n, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE run=? AND result_hash IS NOT NULL").get(run)!.n, 2);
}, jobSpec));

test("remote capacity waits before submitting another costly job", async () => swarmFixture(async (s, cfg) => {
  const q = new Scheduler(s); const run = q.start([swarmTask()]); const c = q.capsule(q.claim(run, "w")!); let calls = 0;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_cmd, _cfg, request) => { calls++; return { schema: 1, key: (request as any).key, jobId: "running", status: "RUNNING" }; });
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, jobCall, signal()), DeferredAttemptError);
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, { ...jobCall, id: "another-job" }, signal()), /capacity/);
  assert.equal(calls, 1); assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs").get()!.n, 1);
}, s => { jobSpec(s); s.jobs!.train.maxConcurrent = 1; }));
test("unchanged remote milestone becomes visibly stalled then requires reconciliation", async () => swarmFixture(async (s, cfg) => {
  const q = new Scheduler(s); const run = q.start([swarmTask()]); const c = q.capsule(q.claim(run, "w")!);
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_cmd, _cfg, request) => ({ schema: 1, key: (request as any).key, jobId: "train", status: "RUNNING", progressToken: "step-10" }));
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, jobCall, signal()), DeferredAttemptError);
  s.db.prepare("UPDATE research_jobs SET poll_at=0,progress_at=?").run(Date.now() - 300);
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, jobCall, signal()), e => {
    assert.ok(e instanceof DeferredAttemptError); assert.equal(e.kind, "remote-stalled"); return true;
  });
  s.db.prepare("UPDATE research_jobs SET poll_at=0,progress_at=?").run(Date.now() - 1500);
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, jobCall, signal()), e => {
    assert.ok(e instanceof FatalAttemptError); assert.match(e.message, /RECONCILIATION_REQUIRED/); return true;
  });
}, s => { jobSpec(s); s.jobs!.train.staleMs = 200; s.jobs!.train.reconcileAfterMs = 1000; }));
test("alternating old remote milestones cannot mask a stalled job", async () => swarmFixture(async (s, cfg) => {
  const q = new Scheduler(s); const run = q.start([swarmTask()]); const c = q.capsule(q.claim(run, "w")!);
  const tokens = ["A", "B", "A"];
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_cmd, _cfg, request) => ({
    schema: 1, key: (request as any).key, jobId: "train", status: "RUNNING", progressToken: tokens.shift(),
  }));
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, jobCall, signal()), DeferredAttemptError);
  s.db.prepare("UPDATE research_jobs SET poll_at=0").run();
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, jobCall, signal()), DeferredAttemptError);

  const staleAt = Date.now() - 300;
  s.db.prepare("UPDATE research_jobs SET poll_at=0,progress_at=?").run(staleAt);
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, jobCall, signal()), e => {
    assert.ok(e instanceof DeferredAttemptError); assert.equal(e.kind, "remote-stalled"); return true;
  });
  const row = s.db.prepare("SELECT progress_at FROM research_jobs WHERE run=?").get(run)!;
  assert.equal(row.progress_at, staleAt, "replayed milestone must not renew liveness");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_job_progress").get()!.n, 2);
}, s => { jobSpec(s); s.jobs!.train.staleMs = 200; s.jobs!.train.reconcileAfterMs = 1000; }));

test("operator reconciliation records a terminal remote outcome without resubmission", async () => swarmFixture(async (s, cfg) => {
  const q = new Scheduler(s); const run = q.start([swarmTask()]); const c = q.capsule(q.claim(run, "w")!);
  let rpcCalls = 0;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_cmd, _cfg, request) => {
    rpcCalls++; return { schema: 1, key: (request as any).key, jobId: "train", status: "RUNNING" };
  });
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, jobCall, signal()), DeferredAttemptError);
  const key = s.db.prepare("SELECT key FROM research_jobs WHERE run=?").get(run)!.key as string;
  const reconciled: any = jobs.reconcile(run, key, { schema: 1, key, jobId: "train", status: "FAILED" });
  assert.equal(reconciled.status, "FAILED");
  const replayed: any = await jobs.execute(c, cfg.spec.agents.coder, jobCall, signal());
  assert.equal(replayed.status, "FAILED"); assert.equal(rpcCalls, 1);
  assert.throws(() => jobs.reconcile(run, key, { schema: 1, key, jobId: "train", status: "CANCELLED" }), /already reconciled/);
}, jobSpec));
test("successful external job requires a bounded result and permitted template", async () => swarmFixture(async (s, cfg) => {
  const q = new Scheduler(s); const run = q.start([swarmTask()]); const c = q.capsule(q.claim(run, "w")!);
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_cmd, _cfg, request) => ({ schema: 1, key: (request as any).key, jobId: "train", status: "SUCCEEDED" }));
  await assert.rejects(jobs.execute(c, { ...cfg.spec.agents.coder, jobs: [] }, jobCall, signal()), /denied/);
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, jobCall, signal()), /INVALID_JOB_REPLY/);
}, jobSpec));
test("job and supervision configuration reject unsafe bounds/capabilities", () => {
  const s = spec("x"); jobSpec(s); s.jobs!.train.idempotentEnsure = false as any; assert.throws(() => validateSwarmSpec(s), /idempotent/);
  s.jobs!.train.idempotentEnsure = true; s.jobs!.train.maxConcurrent = 0; assert.throws(() => validateSwarmSpec(s), /concurrency/);
  const supervised = spec("x"); supervised.supervision = { reportEveryMs: 10, checkpointEveryMs: 1000, maxReplans: 257 };
  assert.throws(() => validateSwarmSpec(supervised), /maxReplans/);
  const reconcile = spec("x"); jobSpec(reconcile); reconcile.jobs!.train.reconcileAfterMs = reconcile.jobs!.train.staleMs - 1;
  assert.throws(() => validateSwarmSpec(reconcile), /reconciliation interval/);
  const insecure = spec("x"); insecure.agents.coder.url = "http://10.0.0.5:8000/v1/chat/completions"; insecure.agents.coder.allowHttp = true;
  insecure.agents.coder.keyEnv = "MODEL_API_KEY";
  assert.throws(() => validateSwarmSpec(insecure), /credentials require HTTPS/);
  insecure.agents.coder.keyEnv = undefined;
  assert.doesNotThrow(() => validateSwarmSpec(insecure));
  insecure.agents.coder.url = "http://127.0.0.1:8000/v1/chat/completions"; insecure.agents.coder.keyEnv = "MODEL_API_KEY";
  assert.doesNotThrow(() => validateSwarmSpec(insecure));
});
test("transient provider responses yield without resetting the run request ledger", async () => swarmFixture(async (s, cfg) => {
  const q = new Scheduler(s); const run = q.start([swarmTask()]); let l = q.claim(run, "w")!; const j = new SessionJournal(s);
  let n = 0; const brain = new HttpBrain(j, (async () => ++n <= 5 ? new Response(null, { status: 500 }) : reply()) as typeof fetch);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(brain.next(q.capsule(l), cfg.spec.agents.coder, [{ role: "user", content: "task" }], cfg.spec.budget, 32768, signal()), e => {
      assert.ok(e instanceof DeferredAttemptError); q.defer(l, new DeferredAttemptError("provider", Date.now(), e.message)); return true;
    });
    l = q.claim(run, "w")!;
  }
  const good = await brain.next(q.capsule(l), cfg.spec.agents.coder, [{ role: "user", content: "task" }], cfg.spec.budget, 32768, signal());
  assert.equal(good.turn.tokens, 15); assert.equal(j.usage(run).requests, 6); assert.equal(j.usage(run).unknownRequests, 5);
}, s => { s.recipe.attempts = 1; }));
test("provider concurrency waiters wake on local request completion", async () => swarmFixture(async (s, cfg) => {
  cfg.spec.budget.modelConcurrency = 1;
  const aTask = { ...swarmTask("a"), readScope: [] };
  const bTask = { ...swarmTask("b"), readScope: [] };
  const q = new Scheduler(s); const run = q.start([aTask, bTask]);
  const a = q.capsule(q.claim(run, "a")!); const b = q.capsule(q.claim(run, "b")!);
  const journal = new SessionJournal(s); const provider = "shared-test-pool";
  const first = await journal.reserve(a, provider, { request: "a" }, cfg.spec.budget, signal());
  const started = Date.now();
  const secondPromise = journal.reserve(b, provider, { request: "b" }, cfg.spec.budget, signal());
  await delay(20);
  journal.complete(first, 1, { ok: true });
  const second = await secondPromise;
  assert.ok(Date.now() - started < 200, "same-process permit should wake before cross-process fallback");
  journal.complete(second, 1, { ok: true });
}));

test("authentication errors are not retried as transient outages", async () => swarmFixture(async (s, cfg) => {
  const q = new Scheduler(s); const run = q.start([swarmTask()]); const c = q.capsule(q.claim(run, "w")!); const j = new SessionJournal(s);
  const brain = new HttpBrain(j, (async () => new Response(null, { status: 401 })) as typeof fetch);
  await assert.rejects(brain.next(c, cfg.spec.agents.coder, [{ role: "user", content: "task" }], cfg.spec.budget, 32768, signal()), FatalAttemptError);
  assert.equal(j.usage(run).requests, 1);
}));
test("transport classification excludes schema errors and handles bounded cause cycles", () => {
  assert.ok(isTransportFailure(new TypeError("fetch failed")));
  assert.ok(isTransportFailure({ cause: { code: "ECONNRESET" } }));
  assert.ok(!isTransportFailure(new SyntaxError("bad response JSON")));
  const cyclic: any = {}; cyclic.cause = cyclic; assert.equal(isTransportFailure(cyclic), false);
});
test("an objective finishes only after integration and resumes without another model request", async () => swarmFixture(async (s, cfg, project) => {
  const script = scripted([() => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]), () => reply()]);
  const statuses: string[] = [];
  const result: any = await superviseSwarm(s, { id: "research", goal: "Implement 42 and verify it", tasks: [swarmTask()] }, signal(), r => statuses.push(r.status), script.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(result.objective.state, "COMPLETE"); assert.ok(statuses.includes("VERIFYING"));
  assert.equal(readFileSync(join(project, "src/a.txt"), "utf8"), "0\n", "user checkout unchanged");
  const rerun: any = await superviseSwarm(s, { id: "research" }, signal(), undefined, script.fetcher);
  assert.equal(rerun.objective.run, result.objective.run); assert.equal(script.bodies.length, 2);
  await assert.rejects(superviseSwarm(s, { id: "research", goal: "silently changed objective" }, signal()), /goal changed/);
}));
test("bounded recovery planner versions the task graph and resumes the objective", async () => swarmFixture(async s => {
  const script = scripted([
    () => reply("finished without a patch"),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply(),
  ]);
  let plannerCalls = 0;
  const repaired = { ...swarmTask("repair"), goal: "Repair the failed objective with a smaller task", writeScope: ["src/a.txt"] };
  const result: any = await superviseSwarm(
    s,
    { id: "auto-recover", goal: "Implement 42 and verify it", tasks: [swarmTask()] },
    signal(),
    undefined,
    script.fetcher,
    async context => {
      plannerCalls++;
      assert.equal(context.revision, 1);
      assert.ok(context.failures.some(f => f.status === "FAIL"));
      return { reason: "Replace the failed broad attempt with a focused repair task", tasks: [repaired] };
    },
  );
  assert.equal(result.status, "PASS"); assert.equal(result.objective.state, "COMPLETE");
  assert.equal(plannerCalls, 1); assert.equal(script.bodies.length, 3);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM swarm_objective_revisions WHERE objective='auto-recover'").get()!.n, 2);
  assert.equal(s.db.prepare("SELECT state FROM swarm_recovery_attempts WHERE objective='auto-recover'").get()!.state, "PLANNED");
}, s => {
  s.recipe.attempts = 1;
  s.supervision = { reportEveryMs: 10, checkpointEveryMs: 1000, maxReplans: 1 };
}));
test("supervision uses the configured external API for bounded recovery by default", async () => swarmFixture(async s => {
  const repaired = { ...swarmTask("repair"), goal: "Repair the failed objective with a smaller task", writeScope: ["src/a.txt"] };
  const script = scripted([
    () => reply("finished without a patch"),
    body => {
      assert.ok(Array.isArray(body.tools));
      assert.equal(body.tool_choice?.function?.name, "propose_recovery_plan");
      return reply("", [{ name: "propose_recovery_plan", arguments: {
        decision: "replan", reason: "Replace the failed broad attempt with focused repair work", tasks: [repaired],
      } }]);
    },
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply(),
  ]);
  const result: any = await superviseSwarm(
    s,
    { id: "api-auto-recover", goal: "Implement 42 and verify it", tasks: [swarmTask()] },
    signal(),
    undefined,
    script.fetcher,
  );
  assert.equal(result.status, "PASS");
  assert.equal(result.objective.state, "COMPLETE");
  assert.equal(script.bodies.length, 4);
  const revisions = s.db.prepare(
    "SELECT COUNT(*) AS n FROM swarm_objective_revisions WHERE objective='api-auto-recover' AND revision>0"
  ).get()!.n;
  assert.equal(revisions, 1);
  const runs = s.db.prepare(
    "SELECT run FROM swarm_recovery_attempts WHERE objective='api-auto-recover'"
  ).get()!;
  const usage = new SessionJournal(s).usage(runs.run);
  assert.equal(usage.requests, 2, "failed worker call and recovery planner share the old run budget");
}, s => {
  s.recipe.attempts = 1;
  s.supervision = { reportEveryMs: 10, checkpointEveryMs: 1000, maxReplans: 1, recoveryAgent: "coder" };
}));

test("unfinished objectives keep replanning by default across multiple failed execution graphs", async () => swarmFixture(async s => {
  const repair1 = { ...swarmTask("repair1"), goal: "first alternative decomposition", writeScope: ["src/a.txt"] };
  const repair2 = { ...swarmTask("repair2"), goal: "second alternative decomposition", writeScope: ["src/a.txt"] };
  let recoveryCalls = 0;
  const script = scripted([
    () => reply("first graph produced no patch"),
    body => {
      recoveryCalls++;
      assert.equal(body.tool_choice?.function?.name, "propose_recovery_plan");
      return reply("", [{ name: "propose_recovery_plan", arguments: {
        decision: "replan", reason: "Try a smaller first recovery graph", tasks: [repair1],
      } }]);
    },
    () => reply("first recovery also produced no patch"),
    body => {
      recoveryCalls++;
      return reply("", [{ name: "propose_recovery_plan", arguments: {
        decision: "replan", reason: "Use a different second recovery graph", tasks: [repair2],
      } }]);
    },
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("complete"),
  ]);
  const result: any = await superviseSwarm(
    s, { id: "persistent-default", goal: "Do not stop until verified 42 exists", tasks: [swarmTask()] },
    signal(), undefined, script.fetcher,
  );
  assert.equal(result.status, "PASS");
  assert.equal(result.objective.state, "COMPLETE");
  assert.equal(recoveryCalls, 2);
  assert.equal(s.db.prepare(
    "SELECT COUNT(*) AS n FROM swarm_objective_revisions WHERE objective='persistent-default'"
  ).get()!.n, 3);
  assert.ok(result.objective.budget.usedRequests >= 6);
}, s => {
  s.recipe.attempts = 1;
  s.supervision = { reportEveryMs: 10, checkpointEveryMs: 1000 };
}));

test("deferred integration recovery resumes instead of dead-ending in NEEDS_ATTENTION", async () => swarmFixture(async s => {
  const script = scripted([
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "1\n" } }]),
    () => reply("first graph complete"),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("repair graph complete"),
  ]);
  let plannerCalls = 0;
  const repaired = { ...swarmTask("integration-repair"), goal: "repair the integration failure", writeScope: ["src/a.txt"] };
  const result: any = await superviseSwarm(
    s, { id: "integration-recovery", goal: "Pass the final integrated-tree check", tasks: [swarmTask()] },
    signal(), undefined, script.fetcher,
    async () => {
      plannerCalls++;
      if (plannerCalls === 1) throw new DeferredAttemptError("provider", Date.now() + 5, "temporary recovery outage");
      return { reason: "repair final integration with a focused task", tasks: [repaired] };
    },
  );
  assert.equal(result.status, "PASS");
  assert.equal(plannerCalls, 2);
  assert.equal(result.objective.state, "COMPLETE");
}, s => {
  s.recipe.attempts = 1;
  s.checks.behavior = { argv: [process.execPath, "-e", "process.exit(0)"], replaySafe: true };
  s.checks.integration = { argv: [process.execPath, "-e",
    "const fs=require('node:fs');if(fs.readFileSync('src/a.txt','utf8').trim()!=='42')process.exit(1)"], replaySafe: true };
  s.integrationChecks = ["integration"];
  s.supervision = { reportEveryMs: 10, checkpointEveryMs: 1000, recoveryBackoffMs: 100 };
}));

test("transient recovery failure is durably retried without consuming a new revision", async () => swarmFixture(async s => {
  const script = scripted([
    () => reply("finished without a patch"),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply(),
  ]);
  let plannerCalls = 0;
  const repaired = { ...swarmTask("repair"), goal: "Focused retry recovery", writeScope: ["src/a.txt"] };
  const result: any = await superviseSwarm(
    s,
    { id: "deferred-recovery", goal: "Implement 42 and verify it", tasks: [swarmTask()] },
    signal(),
    undefined,
    script.fetcher,
    async () => {
      plannerCalls++;
      if (plannerCalls === 1) throw new DeferredAttemptError("provider", Date.now() + 20, "temporary planner outage");
      return { reason: "Retry with focused repair", tasks: [repaired] };
    },
  );
  assert.equal(result.status, "PASS");
  assert.equal(plannerCalls, 2);
  assert.equal(s.db.prepare(
    "SELECT COUNT(*) AS n FROM swarm_objective_revisions WHERE objective='deferred-recovery' AND revision>0"
  ).get()!.n, 1);
  assert.equal(s.db.prepare(
    "SELECT state FROM swarm_recovery_attempts WHERE objective='deferred-recovery'"
  ).get()!.state, "PLANNED");
}, s => {
  s.recipe.attempts = 1;
  s.supervision = { reportEveryMs: 10, checkpointEveryMs: 1000, maxReplans: 1 };
}));


test("deferred recovery wakes at retry_at instead of waiting for the report cadence", async () => swarmFixture(async s => {
  const script = scripted([
    () => reply("finished without a patch"),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("repair complete"),
  ]);
  let plannerCalls = 0;
  const plannerAt: number[] = [];
  const repaired = { ...swarmTask("retry-repair"), goal: "Focused retry recovery", writeScope: ["src/a.txt"] };
  const result: any = await superviseSwarm(
    s,
    { id: "retry-at-wake", goal: "Implement 42 without sleeping until the next report", tasks: [swarmTask()] },
    signal(),
    undefined,
    script.fetcher,
    async () => {
      plannerCalls++; plannerAt.push(Date.now());
      if (plannerCalls === 1) throw new DeferredAttemptError("provider", Date.now() + 20, "temporary planner outage");
      return { reason: "Retry promptly with focused repair", tasks: [repaired] };
    },
  );
  assert.equal(result.status, "PASS");
  assert.equal(plannerCalls, 2);
  // Assert the WAKE INTERVAL (deferred planner call -> retry), not total
  // runtime: verification checks, git worktree integration, and the run
  // itself legitimately take time unrelated to wake scheduling. Waiting for
  // the reporting cadence would show >= reportEveryMs here (1000ms); waking
  // at retry_at (backoff 100ms + wake 20ms) stays well under half that.
  const wake = plannerAt[1]! - plannerAt[0]!;
  assert.ok(wake < 500, `recovery waited for reporting cadence: ${wake}ms`);
}, s => {
  s.recipe.attempts = 1;
  s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 1000, recoveryBackoffMs: 100 };
}));

test("recovery rejects cosmetic task renames that repeat a failed execution strategy", async () => swarmFixture(async s => {
  const ctl = new AbortController();
  const original = swarmTask();
  const cosmetic = { ...original, id: "renamed-repair" };
  const script = scripted([
    () => reply("first graph produced no patch"),
    () => reply("cosmetic replacement also produced no patch"),
  ]);
  const result: any = await superviseSwarm(
    s,
    { id: "strategy-novelty", goal: "Require a structurally or semantically different recovery plan", tasks: [original] },
    ctl.signal,
    r => {
      if (r.status === "NEEDS_ATTENTION") ctl.abort();
    },
    script.fetcher,
    async () => ({ reason: "Rename only the task ID without changing execution", tasks: [cosmetic] }),
  );
  assert.equal(result.status, "PAUSED");
  const recovery = s.db.prepare(
    "SELECT state,detail FROM swarm_recovery_attempts WHERE objective='strategy-novelty'"
  ).get()!;
  assert.equal(recovery.state, "FAILED");
  assert.match(String(recovery.detail), /repeats a previously failed execution strategy/);
  assert.equal(s.db.prepare(
    "SELECT COUNT(*) AS n FROM swarm_objective_revisions WHERE objective='strategy-novelty'"
  ).get()!.n, 1);
}, s => {
  s.recipe.attempts = 1;
  s.supervision = { reportEveryMs: 10, checkpointEveryMs: 1000, maxReplans: 1 };
}));

test("completed recovery API reply replays after crash without another external call", async () => swarmFixture(async (s, cfg) => {
  const root = swarmTask(); const run = new Scheduler(s).start([root]);
  const context = { objectiveId: "replay-recovery", goal: "repair safely", runId: run,
    reason: "failed", revision: 1, tasks: [root], failures: [{ id: root.id, status: "FAIL", error: "x" }] };
  let calls = 0;
  const first = createApiRecoveryPlanner(s, cfg, (async () => {
    calls++;
    return reply("", [{ name: "propose_recovery_plan", arguments: {
      decision: "decline", reason: "No safe structural change", tasks: [],
    } }]);
  }) as typeof fetch);
  assert.equal(await first(context, signal()), null);
  const replayed = createApiRecoveryPlanner(s, cfg, (async () => {
    throw new Error("completed recovery reply must be replayed");
  }) as typeof fetch);
  assert.equal(await replayed(context, signal()), null);
  assert.equal(calls, 1);
  assert.equal(new SessionJournal(s).usage(run).requests, 1);
  assert.equal(s.db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE run=? AND kind='objective.recovery.model.replayed'"
  ).get(run)!.n, 1);
}));

test("prepared recovery is adopted after a supervisor crash without another planner call", async () => swarmFixture(async s => {
  const ctl = new AbortController();
  await superviseSwarm(
    s,
    { id: "prepared-recovery", goal: "Implement 42 and verify it", tasks: [swarmTask()] },
    ctl.signal,
    r => { if (r.status === "NEEDS_ATTENTION") ctl.abort(); },
    (async () => new Response(null, { status: 401 })) as typeof fetch,
  );
  const old: any = objectiveStatus(s, "prepared-recovery");
  const repaired = { ...swarmTask("repair"), goal: "Focused recovery task", writeScope: ["src/a.txt"] };
  const plan = s.artifact(JSON.parse(JSON.stringify([repaired])));
  const newRun = "reserved-recovery-run";
  const now = Date.now();
  s.db.prepare("INSERT INTO swarm_objective_revisions VALUES(?,?,?,?,?,?)")
    .run("prepared-recovery", 1, plan, newRun, "prepared before crash", now);
  s.db.prepare(`INSERT INTO swarm_recovery_attempts
    (objective,run,revision,state,detail,new_run,retry_at,created,updated)
    VALUES(?,?,?,?,?,?,NULL,?,?)`)
    .run("prepared-recovery", old.run, 1, "PREPARED", "prepared before crash", newRun, now, now);
  const sourceRecipe = s.db.prepare("SELECT recipe FROM runs WHERE id=?").get(old.run)!.recipe as string;
  new Scheduler(s).start([repaired], sourceRecipe, now, newRun); // crash after run creation, before objective binding
  s.db.prepare("UPDATE swarm_objectives SET owner=NULL,lease=NULL,state='NEEDS_ATTENTION' WHERE id='prepared-recovery'").run();
  const script = scripted([
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply(),
  ]);
  const result: any = await superviseSwarm(
    s, { id: "prepared-recovery" }, signal(), undefined, script.fetcher,
  );
  assert.equal(result.status, "PASS"); assert.equal(result.objective.run, newRun);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE id=?").get(newRun)!.n, 1);
  assert.equal(s.db.prepare("SELECT state FROM swarm_recovery_attempts WHERE objective='prepared-recovery'").get()!.state, "PLANNED");
}, s => {
  s.recipe.attempts = 1;
  // This fixture injects PREPARED manually to model the crash window. Disable
  // ordinary replanning so the setup does not race the default recovery planner.
  // PREPARED adoption remains allowed even when new automatic replans are off.
  s.supervision = { reportEveryMs: 10, checkpointEveryMs: 1000, maxReplans: 0 };
}));
test("unresolved remote outcome suppresses autonomous replacement planning", async () => swarmFixture(async (s, cfg) => {
  const first = new AbortController();
  await superviseSwarm(
    s,
    { id: "remote-reconcile", goal: "Finish without duplicating external compute", tasks: [swarmTask()] },
    first.signal,
    r => { if (r.status === "NEEDS_ATTENTION") first.abort(); },
    (async () => new Response(null, { status: 401 })) as typeof fetch,
  );
  const old: any = objectiveStatus(s, "remote-reconcile");
  new ResearchJobs(new SessionJournal(s), cfg);
  const now = Date.now();
  s.db.prepare(`INSERT INTO research_jobs
    (key,run,task,template,input_hash,created,progress_at,poll_at,failures,job_id,status,result_hash,updated)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("unresolved-job", old.run, "a", "train", "binding", now, now, now, 0, "remote-1", "UNKNOWN", null, now);
  s.db.prepare("UPDATE swarm_objectives SET owner=NULL,lease=NULL,state='NEEDS_ATTENTION' WHERE id='remote-reconcile'").run();
  let plannerCalls = 0; let blockedReason = ""; const second = new AbortController();
  const result: any = await superviseSwarm(
    s, { id: "remote-reconcile" }, second.signal,
    r => {
      if (r.status === "NEEDS_ATTENTION") {
        blockedReason = String((objectiveStatus(s, "remote-reconcile") as any).reason ?? "");
        second.abort();
      }
    },
    undefined,
    async () => { plannerCalls++; return { reason: "unsafe replacement", tasks: [{ ...swarmTask("replacement") }] }; },
  );
  assert.equal(result.status, "PAUSED"); assert.equal(plannerCalls, 0);
  assert.match(blockedReason, /Remote outcome requires reconciliation/);
}, s => {
  jobSpec(s); s.recipe.attempts = 1;
  s.supervision = { reportEveryMs: 10, checkpointEveryMs: 1000, maxReplans: 1 };
}));
test("explicitly disabled recovery leaves permanent failure visible and honors operator pause", async () => swarmFixture(async s => {
  let requests = 0; const ctl = new AbortController(); const phases: string[] = [];
  const result: any = await superviseSwarm(s, { id: "needs-config", goal: "Correct implementation", tasks: [swarmTask()] }, ctl.signal,
    r => { phases.push(r.status); if (r.status === "NEEDS_ATTENTION") ctl.abort(); },
    (async () => { requests++; return new Response(null, { status: 401 }); }) as typeof fetch);
  assert.equal(result.status, "PAUSED"); assert.ok(phases.includes("NEEDS_ATTENTION")); assert.equal(requests, 1);
  assert.equal((objectiveStatus(s, "needs-config") as any).state, "PAUSED");
}, s => {
  s.supervision = { reportEveryMs: 10, checkpointEveryMs: 1000, maxReplans: 0 };
}));
test("two objective supervisors cannot both own the same work", async () => swarmFixture(async s => {
  const ctl = new AbortController(); let observed!: () => void; const started = new Promise<void>(r => observed = r);
  const p = superviseSwarm(s, { id: "owned", goal: "work", tasks: [swarmTask()] }, ctl.signal, () => observed(), (async (_u, init) => {
    return new Promise((_, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); });
  }) as typeof fetch);
  await started;
  await assert.rejects(superviseSwarm(s, { id: "owned" }, signal()), /already supervised/);
  ctl.abort(); await p;
}));
test("expired objective owner is replaced without changing its run or budget", async () => swarmFixture(async s => {
  const ctl = new AbortController();
  await superviseSwarm(s, { id: "restart", goal: "work", tasks: [swarmTask()] }, ctl.signal, () => ctl.abort());
  const previous: any = objectiveStatus(s, "restart");
  s.db.prepare("UPDATE swarm_objectives SET owner='dead-process',lease=0 WHERE id='restart'").run();
  const script = scripted([() => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]), () => reply()]);
  const result: any = await superviseSwarm(s, { id: "restart" }, signal(), undefined, script.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(result.objective.run, previous.run);
}));
