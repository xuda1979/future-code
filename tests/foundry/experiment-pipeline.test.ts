import { test } from "node:test";
import assert from "node:assert/strict";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { ResearchJobs, type JobRPC } from "../../src/harness/foundry/swarm/jobs.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { validateSwarmSpec, type SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { fixture, reply, scripted, signal, spec, task } from "./swarm-fixtures.ts";

const configure = (s: SwarmSpec) => {
  const stage = () => ({ adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
    idempotentEnsure: true as const, pollMs: 100, staleMs: 10000, maxJobs: 32, maxConcurrent: 8,
    experiment: { reuseIdentical: true } });
  s.jobs = { pilot: stage(), full: { ...stage(), experiment: { reuseIdentical: true, promotion: {
    from: "pilot", matchInput: ["candidate", "data", "evaluation", "seed"],
    metric: ["metrics", "score"], direction: "max", threshold: 0.9,
  } } } };
  s.agents.coder.jobs = ["pilot", "full"]; s.agents.coder.tools.push("run_job");
};
const input = { candidate: "candidate-a", data: "data-v1", evaluation: "eval-v1", seed: 0 };
const call = (id: string, name = "pilot", change = {}) => ({ id, name: "run_job", arguments: { name, input: { ...input, ...change } } });
const success = (r: any, result: any = { metrics: { score: 0.95 } }) =>
  ({ schema: 1, key: r.key, jobId: r.jobId ?? r.key, status: "SUCCEEDED", result });
const open = (s: any, cfg: any, rpc: JobRPC, id = "a") => {
  const q = new Scheduler(s), run = q.start([task(id)]), c = q.capsule(q.claim(run, "worker")!);
  const journal = new SessionJournal(s);
  const thread = journal.open(c, { turns: 0, toolCalls: 0, patchHash: null, pending: null,
    output: null, feedbackHash: null, contextLimit: 32768, history: [{ role: "user", content: "task" }] });
  const jobs = new ResearchJobs(journal, cfg, rpc);
  const submit = (value: ReturnType<typeof call>) => jobs.execute(c, cfg.spec.agents.coder, value, signal());
  return { c, run, jobs, journal, thread, submit };
};
const count = (s: any) => Number(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs").get().n);

test("concurrent and later duplicate model calls consume one external experiment and retain separate tool pairs", async () =>
  fixture(async (s, cfg) => {
    let rpcs = 0;
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const mock = scripted([
      body => {
        assert.match(JSON.stringify(body.messages), /Pipeline rules/);
        return reply("three copies", [call("first"), call("second"), call("third")]);
      },
      body => {
        const results = body.messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.parse(m.content));
        assert.equal(results.length, 3);
        assert.equal(new Set(results.map((r: any) => r.key)).size, 1);
        return reply("repeat after retirement", [call("fourth")]);
      },
      () => reply("repair", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
      () => reply("done"),
    ]);
    const d = new SwarmDriver(s, cfg, mock.fetcher, undefined, async (_cmd, _cfg, request: any) => {
      rpcs++; await new Promise(resolve => setTimeout(resolve, 10)); return success(request);
    });
    const result = await d.execute(c, signal());
    assert.equal(rpcs, 1); assert.equal(count(s), 1);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM experiment_job_calls").get()!.n, 4);
    assert.equal((await d.verify(c, result, signal())).checks.find(r => r.id === "behavior")?.verdict, "PASS");
  }, s => { configure(s); s.jobs!.pilot.maxJobs = 1; s.jobs!.pilot.maxConcurrent = 1; }));

test("input changes and intended replications retain distinct external identities", async () => fixture(async (s, cfg) => {
  let rpcs = 0;
  const t = open(s, cfg, async (_cmd, _cfg, r: any) => { rpcs++; return success(r); });
  const first: any = await t.submit(call("a"));
  assert.deepEqual(await t.submit(call("b")), first);
  for (const change of [{ seed: 1 }, { data: "data-v2" }, { evaluation: "eval-v2" }, { candidate: "candidate-b" }])
    assert.notEqual((await t.submit(call(`variant-${rpcs}`, "pilot", change)) as any).key, first.key);
  assert.equal(rpcs, 5); assert.equal(count(s), 5);
  await assert.rejects(t.submit(call("a", "pilot", { seed: 2 })), /replay input drift/);
}, configure));

test("coalesced experiment RPCs contribute one host timing observation", async () => fixture(async (s, cfg) => {
  let executions = 0, timings = 0;
  const t = open(s, cfg, async (_cmd, _cfg, r: any) => {
    executions++; await new Promise(resolve => setTimeout(resolve, 10)); return success(r);
  });
  const observe = (ms: number) => { assert.ok(Number.isFinite(ms) && ms >= 0); timings++; };
  await Promise.all(["a", "b", "c"].map(id => t.jobs.execute(t.c, cfg.spec.agents.coder, call(id), signal(), observe)));
  assert.equal(executions, 1); assert.equal(timings, 1); assert.equal(count(s), 1);
}, configure));

test("ordinary jobs without an experiment policy preserve intentional repeated executions", async () => fixture(async (s, cfg) => {
  let rpcs = 0;
  const t = open(s, cfg, async (_cmd, _cfg, r: any) => { rpcs++; return success(r); });
  await t.submit(call("a")); await t.submit(call("b"));
  assert.equal(rpcs, 2); assert.equal(count(s), 2);
}, s => { configure(s); delete s.jobs!.full; delete s.jobs!.pilot.experiment; s.agents.coder.jobs = ["pilot"]; }));

test("a completed experiment is reused by a fresh controller after interruption", async () => fixture(async (s, cfg) => {
  let rpcs = 0;
  const rpc: JobRPC = async (_cmd, _cfg, r: any) => { rpcs++; return success(r); };
  const old = open(s, cfg, rpc), result = await old.submit(call("old"));
  const next = new ResearchJobs(new SessionJournal(s), cfg, rpc);
  assert.deepEqual(await next.execute(old.c, cfg.spec.agents.coder, call("fresh"), signal()), result);
  assert.equal(rpcs, 1); assert.equal(count(s), 1);
}, configure));

test("source edits invalidate reuse and promotion while admitted jobs still reconcile their original source", async () => fixture(async (s, cfg) => {
  const operations: string[] = [];
  const t = open(s, cfg, async (_cmd, _cfg, r: any) => {
    operations.push(r.operation);
    if (operations.length === 2) return { schema: 1, key: r.key, jobId: r.key, status: "RUNNING" };
    return success(r);
  });
  await t.submit(call("pilot"));
  await assert.rejects(t.submit(call("admitted", "full")), DeferredAttemptError);
  t.thread.state.patchHash = s.artifact("changed-source");
  t.journal.checkpoint(t.thread, "fixture.edit", {});
  await assert.rejects(t.submit(call("new-full", "full")), /EXPERIMENT_PROMOTION_REQUIRED/);
  s.db.prepare("DELETE FROM experiment_stage_inputs").run();
  s.db.prepare("UPDATE research_jobs SET poll_at=0").run();
  const result: any = await t.submit(call("admitted", "full"));
  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(operations, ["ensure", "ensure", "inspect"]);
  await t.submit(call("new-pilot"));
  await t.submit(call("new-full", "full"));
  assert.equal(count(s), 4);
}, configure));

test("the latest matching reconciled metric gates an expensive stage and records its exact provenance", async () => fixture(async (s, cfg) => {
  const t = open(s, cfg, async (_cmd, _cfg, r: any) => success(r));
  await assert.rejects(t.submit(call("full", "full")), /EXPERIMENT_PROMOTION_REQUIRED/);
  assert.equal(count(s), 0);
  const pilot: any = await t.submit(call("pilot"));
  await t.submit(call("full", "full"));
  assert.equal(count(s), 2);
  const intents = s.db.prepare("SELECT payload FROM events WHERE kind='job.intent' AND run=?").all(t.run)
    .map(r => JSON.parse(String(r.payload)));
  const proof: any = s.readArtifact(intents[1].promotionReceipt);
  assert.equal(proof.jobKey, pilot.key); assert.equal(proof.resultHash, digest(pilot));
  assert.equal(proof.metric, 0.95); assert.equal(proof.trust, "COMPUTE_ALLOCATION_NOT_ACCEPTANCE");
  assert.ok(proof.sourceHash); assert.ok(proof.policyHash); assert.ok(proof.reconciliationHash);
}, configure));

test("missing, nonnumeric, low, failed, and unknown prerequisite outcomes cannot launch full work", async () => {
  for (const variant of ["missing", "string", "low", "failed", "unknown"]) await fixture(async (s, cfg) => {
    let rpcs = 0;
    const t = open(s, cfg, async (_cmd, _cfg, r: any) => {
      rpcs++;
      const result = variant === "missing" ? {} : { metrics: { score: variant === "string" ? "0.99" : variant === "low" ? 0.4 : 0.99 } };
      return { ...success(r, result), status: variant === "failed" ? "FAILED" : variant === "unknown" ? "UNKNOWN" : "SUCCEEDED" };
    });
    if (variant === "unknown") await assert.rejects(t.submit(call("pilot")), DeferredAttemptError);
    else await t.submit(call("pilot"));
    await assert.rejects(t.submit(call("full", "full")), /EXPERIMENT_PROMOTION_REQUIRED/);
    assert.equal(count(s), 1); assert.equal(rpcs, 1);
  }, configure);
});

test("candidate, dataset, evaluation protocol, and replicate identities must all match", async () => fixture(async (s, cfg) => {
  const t = open(s, cfg, async (_cmd, _cfg, r: any) => success(r));
  await t.submit(call("pilot"));
  for (const [field, value] of Object.entries({ candidate: "b", data: "b", evaluation: "b", seed: 1 }))
    await assert.rejects(t.submit(call(`full-${field}`, "full", { [field]: value })), /EXPERIMENT_PROMOTION_REQUIRED/);
  await assert.rejects(t.submit({ ...call("missing"), arguments: { name: "pilot", input: { candidate: "a" } } } as any), /identity missing/);
  assert.equal(count(s), 1, "invalid input rolls back its entire job intent");
}, configure));

test("a newer failed or running prerequisite cannot borrow an older passing metric", async () => {
  for (const status of ["FAILED", "RUNNING"]) await fixture(async (s, cfg) => {
    let rpcs = 0;
    const t = open(s, cfg, async (_cmd, _cfg, r: any) => ({ ...success(r), status: ++rpcs === 2 ? status : "SUCCEEDED" }));
    await t.submit(call("pilot"));
    const newer = call("new-pilot", "pilot", { budget: 2 });
    if (status === "RUNNING") await assert.rejects(t.submit(newer), DeferredAttemptError);
    else await t.submit(newer);
    await assert.rejects(t.submit(call("full", "full")), /EXPERIMENT_PROMOTION_REQUIRED/);
    assert.equal(rpcs, 2);
  }, configure);
});

test("minimization promotion accepts its threshold boundary", async () => fixture(async (s, cfg) => {
  const t = open(s, cfg, async (_cmd, _cfg, r: any) => success(r, { metrics: { loss: 0.1 } }));
  await t.submit(call("pilot")); await t.submit(call("full", "full")); assert.equal(count(s), 2);
}, s => {
  configure(s); s.jobs!.full.experiment!.promotion = { ...s.jobs!.full.experiment!.promotion!,
    direction: "min", metric: ["metrics", "loss"], threshold: 0.1 };
}));

test("results from another task or run cannot authorize promotion or acquire reused work", async () => fixture(async (s, cfg) => {
  let rpcs = 0;
  const rpc: JobRPC = async (_cmd, _cfg, r: any) => { rpcs++; return success(r); };
  const first = open(s, cfg, rpc); await first.submit(call("pilot"));
  for (const id of ["a", "b"]) {
    const other = open(s, cfg, rpc, id);
    await assert.rejects(other.submit(call("full", "full")), /EXPERIMENT_PROMOTION_REQUIRED/);
    await other.submit(call("pilot"));
  }
  assert.equal(rpcs, 3);
}, configure));

test("a stale reconciliation receipt cannot authorize promotion", async () => fixture(async (s, cfg) => {
  const t = open(s, cfg, async (_cmd, _cfg, r: any) => success(r));
  const pilot: any = await t.submit(call("pilot"));
  const row = s.db.prepare("SELECT reconciliation_hash FROM research_jobs WHERE key=?").get(pilot.key)!;
  const proof: any = s.readArtifact(String(row.reconciliation_hash));
  const changed = s.artifact({ ...proof, replyHash: "f".repeat(64) });
  s.db.prepare("UPDATE research_jobs SET reconciliation_hash=? WHERE key=?").run(changed, pilot.key);
  await assert.rejects(t.submit(call("full", "full")), /receipt binding changed/);
  assert.equal(count(s), 1);
}, configure));

test("cheap screening and reuse reduce adapter executions while independent acceptance still rejects broken source", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  let pilot = 0, full = 0;
  const mock = scripted([
    () => reply("screen", [call("a", "pilot"), call("b", "pilot", { candidate: "b" }), call("c", "pilot", { candidate: "c" })]),
    () => reply("promote", [call("full-a", "full"), call("full-b", "full", { candidate: "b" }), call("full-c", "full", { candidate: "c" })]),
    () => reply("repeat best", [call("again", "full", { candidate: "c" })]),
    () => reply("done"),
  ]);
  const d = new SwarmDriver(s, cfg, mock.fetcher, undefined, async (_cmd, _cfg, r: any) => {
    // Both stages deliberately use the same generic adapter. The job input's
    // budget distinguishes actual work; no domain logic enters the runtime.
    const row = s.db.prepare("SELECT template FROM research_jobs WHERE key=?").get(r.key)!;
    if (row.template === "pilot") pilot++; else full++;
    return success(r, { metrics: { score: r.input.candidate === "c" ? 0.95 : 0.5 } });
  });
  const result = await d.execute(c, signal());
  assert.equal(pilot, 3); assert.equal(full, 1);
  assert.equal(count(s), 4, "three pilot experiments and one promoted experiment; rejected/reused calls cost no jobs");
  assert.equal((await d.verify(c, result, signal())).checks.find(r => r.id === "behavior")?.verdict, "FAIL");
}, configure));

test("pipeline policies reject missing stages, cycles, missing capabilities, and malformed thresholds before pinning", () => {
  const valid = () => { const s = spec("/tmp/project"); configure(s); return s; };
  validateSwarmSpec(valid());
  for (const change of [
    (s: SwarmSpec) => { s.jobs!.full.experiment!.promotion!.from = "missing"; },
    (s: SwarmSpec) => { s.jobs!.pilot.experiment!.promotion = { ...s.jobs!.full.experiment!.promotion!, from: "full" }; },
    (s: SwarmSpec) => { s.agents.coder.jobs = ["full"]; },
    (s: SwarmSpec) => { s.jobs!.full.experiment!.promotion!.threshold = NaN; },
    (s: SwarmSpec) => { s.jobs!.full.experiment!.promotion!.metric = []; },
    (s: SwarmSpec) => { s.jobs!.full.experiment!.promotion!.matchInput = []; },
    (s: SwarmSpec) => { s.jobs!.full.experiment!.reuseIdentical = "yes" as any; },
    (s: SwarmSpec) => { s.jobs!.full.experiment = null as any; },
  ]) { const s = valid(); change(s); assert.throws(() => validateSwarmSpec(s)); }
});
