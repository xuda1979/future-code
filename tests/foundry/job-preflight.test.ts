import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { validateSwarmSpec, type SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { fixture, reply, scripted, signal, spec, task } from "./swarm-fixtures.ts";

const configure = (s: SwarmSpec) => {
  s.jobs = { trial: { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
    idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 4, maxConcurrent: 2,
    preflightChecks: ["behavior"] } };
  s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = ["trial"];
};
const job = (id = "experiment") => ({ id, name: "run_job", arguments: { name: "trial", input: { seed: id } } });
const check = () => ({ name: "run_check", arguments: { name: "behavior" } });
const write = (content: string) => ({ name: "write_file", arguments: { path: "src/a.txt", content } });
const errors = (body: any) => body.messages.filter((m: any) => m.role === "tool")
  .map((m: any) => JSON.parse(m.content)).filter((r: any) => r.error).map((r: any) => r.error).join(" ");

test("unmeasured and failing candidates cannot submit single or batched expensive jobs", async () => {
  for (const batched of [false, true]) await fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    let submissions = 0;
    const calls = batched ? [job("a"), job("b")] : [job()];
    const mock = scripted([
      () => reply("submit before measuring", calls),
      body => {
        assert.match(errors(body), /EVALUATION_REQUIRED/);
        assert.equal(submissions, 0); assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs").get()!.n, 0);
        return reply("measure", [check()]);
      },
      () => reply("submit failing candidate", calls),
      body => {
        assert.match(errors(body), /EVALUATION_REQUIRED/); assert.equal(submissions, 0);
        return reply("repair and measure", [write("42\n"), check()]);
      },
      () => reply("submit passing candidate", calls),
      () => reply("done"),
    ]);
    const d = new SwarmDriver(s, cfg, mock.fetcher, undefined, async (_cmd, _cfg, raw: any) => {
      submissions++;
      return { schema: 1, key: raw.key, jobId: raw.key, status: "SUCCEEDED", result: {} };
    });
    const result = await d.execute(c, signal());
    assert.equal(submissions, calls.length);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs").get()!.n, calls.length);
    assert.equal((await d.verify(c, result, signal())).checks.find(r => r.id === "behavior")?.verdict, "PASS");
  }, configure);
});

test("source edits invalidate a passing preflight receipt", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  let submissions = 0;
  const mock = scripted([
    () => reply("prepare", [write("42\n"), check()]),
    () => reply("changed candidate", [write("wrong\n"), job()]),
    body => {
      assert.match(errors(body), /EVALUATION_REQUIRED/); assert.equal(submissions, 0);
      return reply("repair", [write("42\n"), check(), job()]);
    },
    () => reply("done"),
  ]);
  await new SwarmDriver(s, cfg, mock.fetcher, undefined, async (_cmd, _cfg, raw: any) => {
    submissions++;
    return { schema: 1, key: raw.key, jobId: raw.key, status: "SUCCEEDED", result: {} };
  }).execute(c, signal());
  assert.equal(submissions, 1);
}, configure));

test("new experiment evidence requires re-evaluation before a dependent experiment", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  let submissions = 0;
  // Separate the dependent job with a host read barrier in the first turn.
  const mock = scripted([
    () => reply("prepare", [write("42\n"), check(), job("first"),
      { name: "read_file", arguments: { path: "src/a.txt" } }, job("second")]),
    body => { assert.match(errors(body), /EVALUATION_REQUIRED/); assert.equal(submissions, 1);
      return reply("re-evaluate", [check(), job("second")]); },
    () => reply("done"),
  ]);
  const driver = new SwarmDriver(s, cfg, mock.fetcher, undefined, async (_cmd, _cfg, raw: any) => {
    submissions++;
    return { schema: 1, key: raw.key, jobId: raw.key, status: "SUCCEEDED", result: {} };
  });
  await driver.execute(c, signal()); assert.equal(submissions, 2);
}, configure));

test("a source-mutating zero-exit check cannot authorize an experiment", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  const mock = scripted([
    () => reply("measure", [check(), job()]),
    body => { assert.match(errors(body), /EVALUATION_REQUIRED/); return reply("done"); },
  ]);
  let submissions = 0;
  await new SwarmDriver(s, cfg, mock.fetcher, undefined, async () => { submissions++; throw new Error("must not submit"); }).execute(c, signal());
  assert.equal(submissions, 0);
}, s => {
  configure(s);
  s.checks.behavior.argv = [process.execPath, "-e", "require('node:fs').writeFileSync('src/a.txt','42\\n')"];
}));

test("preflight evidence survives a process-equivalent restart without repeat checks", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  const first = scripted([
    () => reply("prepare", [write("42\n"), check()]),
    () => { throw new Error("injected process interruption"); },
  ]);
  const old = new SwarmDriver(s, cfg, first.fetcher);
  await assert.rejects(old.execute(c, signal()), /injected process interruption/);
  const next = scripted([() => reply("submit", [job()]), () => reply("done")]);
  let submissions = 0;
  const d = new SwarmDriver(s, cfg, next.fetcher, undefined, async (_cmd, _cfg, raw: any) => {
    submissions++; return { schema: 1, key: raw.key, jobId: raw.key, status: "SUCCEEDED", result: {} };
  });
  await d.execute(c, signal()); assert.equal(submissions, 1);
  const state: any = s.readArtifact(s.db.prepare("SELECT state FROM agent_threads WHERE run=?").get(run)!.state);
  assert.equal(state.evaluations.behavior.turn, 1); assert.equal(state.evaluations.behavior.passed, true);
  assert.equal(state.toolCalls, 3, "write, one check, one submission; no synthetic extra call");
}, configure));

test("existing remote identities reconcile even after preflight evidence becomes unavailable", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  const mock = scripted([() => reply("prepare", [write("42\n"), check(), job()]), () => reply("done")]);
  const operations: string[] = [];
  const d = new SwarmDriver(s, cfg, mock.fetcher, undefined, async (_cmd, _cfg, raw: any) => {
    operations.push(raw.operation);
    return { schema: 1, key: raw.key, jobId: raw.key, status: raw.operation === "ensure" ? "RUNNING" : "SUCCEEDED",
      ...(raw.operation === "inspect" ? { result: {} } : {}) };
  });
  await assert.rejects(d.execute(c, signal()), DeferredAttemptError);
  const state: any = s.readArtifact(s.db.prepare("SELECT state FROM agent_threads WHERE run=?").get(run)!.state);
  const t = d.journal.open(c, state); t.state.evaluations = {};
  d.journal.checkpoint(t, "fixture.evidence-unavailable", {});
  s.db.prepare("UPDATE research_jobs SET poll_at=0 WHERE run=?").run(run);
  await d.execute(c, signal());
  assert.deepEqual(operations, ["ensure", "inspect"]);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs").get()!.n, 1);
}, configure));

test("preflight configuration must name replay-safe checks available to every submitting profile", () => {
  const s = spec("/tmp/project"); configure(s);
  validateSwarmSpec(s);
  for (const names of [[], ["missing"], ["behavior", "behavior"]]) {
    s.jobs!.trial.preflightChecks = names;
    assert.throws(() => validateSwarmSpec(s), /preflight/);
  }
  s.jobs!.trial.preflightChecks = ["behavior"];
  s.agents.coder.tools = s.agents.coder.tools.filter(t => t !== "run_check");
  assert.throws(() => validateSwarmSpec(s), /preflight/);
});
