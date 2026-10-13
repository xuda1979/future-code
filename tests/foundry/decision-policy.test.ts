import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { runHealth, formatHealth } from "../../src/harness/foundry/health.ts";
import { reflectRun } from "../../src/harness/foundry/rndReflection.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { ResearchJobs } from "../../src/harness/foundry/swarm/jobs.ts";
import { SessionJournal, type ThreadState } from "../../src/harness/foundry/swarm/session.ts";
import { recordDiagnostic, diagnosticContext } from "../../src/harness/foundry/swarm/diagnostics.ts";
import { jobPreflight, admitDecisionCall } from "../../src/harness/foundry/swarm/decisions.ts";
import { compactHistory } from "../../src/harness/foundry/swarm/context.ts";
import { executable, validateSwarmSpec, type SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { runSwarm, integrateSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { fixture, reply, scripted, signal, spec, task } from "./swarm-fixtures.ts";

const write = (n: string, id = "write") => ({ id, name: "write_file", arguments: { path: "src/a.txt", content: n + "\n" } });
const measure = { id: "measure", name: "run_check", arguments: { name: "evaluate" } };
const job = (id: string) => ({ id, name: "run_job", arguments: { name: "trial", input: { seed: id } } });
const initial = (contextLimit = 32768): ThreadState => ({ history: [{ role: "user", content: "task" }],
  turns: 1, toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit });
const state = (s: Store, run: string): ThreadState => s.readArtifact(s.db.prepare(
  "SELECT state FROM agent_threads WHERE run=? AND task='a'").get(run)!.state) as unknown as ThreadState;
function measurements(s: SwarmSpec): void {
  s.checks.evaluate = { ...s.checks.behavior };
  s.checks.unrelated = { argv: [process.execPath, "-e", "process.exit(0)"], replaySafe: true };
  s.agents.coder.diagnostics = ["evaluate", "unrelated"];
  s.agents.coder.decisionPolicy = { maxUnmeasuredWriteTurns: 2, measurementChecks: ["evaluate"] };
}
function preflight(s: SwarmSpec): void {
  measurements(s); delete s.agents.coder.decisionPolicy;
  s.jobs = { trial: { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
    idempotentEnsure: true, pollMs: 10, staleMs: 10000, maxJobs: 8, maxConcurrent: 4, preflightChecks: ["evaluate"] } };
  s.agents.coder.jobs = ["trial"]; s.agents.coder.tools.push("run_job");
}

test("decision measurements and job prerequisites are bounded operator capabilities", () => {
  const s = spec("/tmp/project"); preflight(s); measurements(s); validateSwarmSpec(s);
  for (const maxUnmeasuredWriteTurns of [0, 1, 33, 2.5]) assert.throws(() => validateSwarmSpec({ ...s,
    agents: { coder: { ...s.agents.coder, decisionPolicy: { maxUnmeasuredWriteTurns, measurementChecks: ["evaluate"] } } } }), /write-turn/);
  for (const measurementChecks of [[], ["missing"], ["evaluate", "evaluate"]]) assert.throws(() => validateSwarmSpec({ ...s,
    agents: { coder: { ...s.agents.coder, decisionPolicy: { maxUnmeasuredWriteTurns: 2, measurementChecks } } } }), /measurements/);
  assert.throws(() => validateSwarmSpec({ ...s, checks: { ...s.checks, evaluate: { ...s.checks.evaluate, replaySafe: false } } }), /replay-safe/);
  const denied = structuredClone(s); denied.agents.coder.diagnostics = ["unrelated"];
  delete denied.agents.coder.decisionPolicy;
  assert.throws(() => validateSwarmSpec(denied), /submitting agent/);
  for (const preflightChecks of [[], ["missing"], ["evaluate", "evaluate"]]) assert.throws(() => validateSwarmSpec({ ...s,
    jobs: { trial: { ...s.jobs!.trial, preflightChecks } } }), /preflight/);
});

test("healthy short tasks keep two requests, no forced measurement and full independent acceptance", async () => {
  for (const enabled of [false, true]) await fixture(async (s) => {
    const mock = scripted([() => reply("", [write("42")]), () => reply("ready")]);
    const r: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
    assert.equal(r.status, "PASS"); assert.equal(mock.bodies.length, 2);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='decision.review'").get()!.n, 0);
    assert.ok(!(state(s, r.id).decisions?.measurements.evaluate));
    assert.ok((await integrateSwarm(s, r.id, signal())).checksHash);
  }, s => { if (enabled) measurements(s); });
});

test("review happens without a failing check; unrelated passes and notes cannot authorize more edits", async () => fixture(async s => {
  const mock = scripted([
    () => reply("", [write("1")]), () => reply("", [write("2")]),
    body => {
      assert.match(JSON.stringify(body), /decisionReview/);
      const run = String(s.db.prepare("SELECT id FROM runs").get()!.id);
      assert.match(formatHealth(runHealth(s, run)), /MEASUREMENT a: 2/);
      assert.equal(state(s, run).diagnostics, undefined);
      return reply("", [write("99"), { id: "irrelevant", name: "run_check", arguments: { name: "unrelated" } },
        { id: "note", name: "save_progress", arguments: { summary: "I think this is correct", nextAction: "write again", receipts: [] } }]);
    },
    body => {
      assert.match(JSON.stringify(body), /DECISION_MEASUREMENT_REQUIRED/);
      const run = String(s.db.prepare("SELECT id FROM runs").get()!.id);
      assert.equal(state(s, run).decisions?.writeTurns, 2);
      // A completed negative result is useful evidence and permits a repair.
      return reply("", [measure, write("42")]);
    }, () => reply("ready"),
  ]);
  const r: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(r.status, "PASS"); assert.equal(mock.bodies.length, 5);
  assert.equal(state(s, r.id).decisions?.lastMeasurement?.code, 1);
  assert.equal(state(s, r.id).decisions?.reviews, 1);
  assert.equal(runHealth(s, r.id).decisionReviews, undefined);
  assert.ok((reflectRun(s, "objective", r.id).reflection as any).findings.some((f: any) => f.code === "measurement_overdue"));
  assert.ok((await integrateSwarm(s, r.id, signal())).checksHash);
}, s => { measurements(s); s.agents.coder.tools.push("save_progress"); }));

test("batch writes count once per model turn, and denied batches produce no effects", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  const mock = scripted([
    () => reply("", [write("1", "one"), write("2", "two")]),
    () => reply("", [write("3", "three"), write("4", "four")]),
    () => reply("", [write("99", "denied-one"), write("100", "denied-two")]),
    () => reply("", [measure, write("42")]), () => reply("ready"),
  ]);
  const d = new SwarmDriver(s, cfg, mock.fetcher), result = await d.execute(c, signal());
  assert.equal(state(s, run).decisions?.reviews, 1);
  const events: any[] = d.journal.page(run, "a", 0, 100);
  const blocked: any = events.filter(e => e.kind === "tool.batch.result").map(e => s.readArtifact(e.payloadHash))
    .find((e: any) => e.results.some((r: any) => r.callId === "denied-one"));
  assert.equal(blocked.executions, 0);
  assert.ok(blocked.results.every((r: any) => /DECISION_MEASUREMENT_REQUIRED/.test((s.readArtifact(r.receipt) as any).error)));
  assert.ok((await d.verify(c, result, signal())).checks.every(c => c.verdict === "PASS"));
}, measurements));

test("completed named observations bind source, feedback, child/job evidence and owned receipts", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([{ ...task(), readScope: ["src/a.txt"] }, { ...task("b"), readScope: ["src/b.txt"] }]);
  const c = q.capsule(q.claim(run, "a")!), other = q.capsule(q.claim(run, "b")!);
  const journal = new SessionJournal(s), t = journal.open(c, initial());
  const record = (result: any = { code: 0, stdout: "measured", stderr: "" }, before = t.state.patchHash) =>
    recordDiagnostic(t, journal, cfg, measure, result, journal.receipt(c, result), before, true);
  record(); assert.ok(jobPreflight(journal, t.state, c, ["evaluate"]));
  assert.throws(() => jobPreflight(journal, t.state, c, ["behavior"]), /JOB_PREFLIGHT_REQUIRED/);
  for (const field of ["patchHash", "feedbackHash", "lastJobReceipt", "lastSpawnReceipt"] as const) {
    t.state[field] = s.artifact(field);
    assert.throws(() => jobPreflight(journal, t.state, c, ["evaluate"]), /JOB_PREFLIGHT_REQUIRED/);
    record(); assert.ok(jobPreflight(journal, t.state, c, ["evaluate"]));
  }
  for (const unknown of [{ code: null }, { error: "deadline exceeded" }, { code: 0, error: "unknown" }]) {
    record(unknown); assert.throws(() => jobPreflight(journal, t.state, c, ["evaluate"]), /JOB_PREFLIGHT_REQUIRED/); record();
  }
  record({ code: 1, stderr: "counterexample", stdout: "" });
  assert.throws(() => jobPreflight(journal, t.state, c, ["evaluate"]), /JOB_PREFLIGHT_REQUIRED/);
  record(); t.state.decisions!.measurements.evaluate.receipt = journal.receipt(other, { code: 0, stdout: "foreign", stderr: "" });
  assert.throws(() => jobPreflight(journal, t.state, c, ["evaluate"]), /JOB_PREFLIGHT_REQUIRED/);
  record(); const before = t.state.patchHash; t.state.patchHash = s.artifact("mutated source"); record({ code: 0 }, before);
  assert.throws(() => jobPreflight(journal, t.state, c, ["evaluate"]), /JOB_PREFLIGHT_REQUIRED/);
}, preflight));

test("repeated identical measurements and context retirement do not erase an overdue decision", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  const journal = new SessionJournal(s), t = journal.open(c, initial());
  const result = { code: 0, stdout: "same result", stderr: "" }, receipt = journal.receipt(c, result);
  recordDiagnostic(t, journal, cfg, measure, result, receipt, null, true);
  for (const n of [1, 2]) {
    t.state.turns++; const before = t.state.patchHash; t.state.patchHash = s.artifact("patch " + n);
    recordDiagnostic(t, journal, cfg, { id: "w", ...write(String(n)) }, {}, journal.receipt(c, {}), before, true);
  }
  t.state.patchHash = null; // Same previously measured source: no new discriminator.
  recordDiagnostic(t, journal, cfg, measure, result, receipt, null, true);
  assert.ok(t.state.decisions?.review);
  t.state.turns++; assert.throws(() => admitDecisionCall(t.state, { ...write("42") }), /DECISION_MEASUREMENT_REQUIRED/);
  const history = [t.state.history[0], ...Array.from({ length: 20 }, () => ({ role: "user" as const, content: "old theory ".repeat(100) })),
    { role: "user" as const, content: "recent" }];
  const compacted = compactHistory(history, 4000, null, diagnosticContext(t.state));
  assert.match(compacted[1].content, /decisionReview/);
  assert.match(compacted[1].content, /OBSERVATION_NOT_ACCEPTANCE/);
}, measurements));

test("job gate eliminates premature fan-out before any intent, preserving requests and final quality", async t => {
  const counts: number[] = [];
  for (const enabled of [false, true]) await fixture(async (s, cfg) => {
    let submissions = 0;
    const mock = scripted([
      () => reply("", [write("42"), job("early-1"), job("early-2"), job("early-3")]),
      () => { assert.equal(submissions, enabled ? 0 : 3); return reply("", [measure, job("informed")]); },
      () => reply("ready"),
    ]);
    const d = new SwarmDriver(s, cfg, mock.fetcher, undefined, async (_command, _cfg, raw) => {
      const r: any = raw; submissions++;
      return { schema: 1, key: r.key, jobId: r.key, status: "SUCCEEDED", result: { exitCode: 0 } };
    });
    const r = await runTasks(s, [task()], d, { signal: signal() });
    assert.equal(r.status, "PASS"); assert.equal(mock.bodies.length, 3);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs").get()!.n, enabled ? 1 : 4, JSON.stringify(state(s, r.id).history.slice(-5)));
    if (enabled) {
      const event: any = s.db.prepare("SELECT payload FROM events WHERE kind='job.intent'").get()!;
      const proof: any = s.readArtifact(JSON.parse(event.payload).preflightReceipt);
      assert.equal(proof.observations[0].name, "evaluate"); assert.equal(proof.trust, "OBSERVATION_NOT_ACCEPTANCE");
    }
    assert.ok((await integrateSwarm(s, r.id, signal())).checksHash); counts.push(submissions);
  }, s => { preflight(s); if (!enabled) delete s.jobs!.trial.preflightChecks; });
  assert.deepEqual(counts, [4, 1]); t.diagnostic("Offline workload: premature jobs 3 -> 0; total jobs 4 -> 1; model requests 3 in both; independent task/integration gates passed.");
});

test("lost measurement checkpoint replays safely; restart cannot manufacture job support or duplicate work", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  let submissions = 0;
  const rpc = async (_command: any, _cfg: any, raw: any) => {
    submissions++; return { schema: 1, key: raw.key, jobId: raw.key, status: "SUCCEEDED", result: {} };
  };
  const mock = scripted([() => reply("", [write("42"), measure, job("trial")]), () => reply("ready")]);
  const d = new SwarmDriver(s, cfg, mock.fetcher, undefined, rpc), checkpoint = d.journal.checkpoint.bind(d.journal);
  d.journal.checkpoint = (t, kind, payload) => {
    if (kind === "tool.result" && (payload as any).callId === "measure") throw new Error("lost measurement checkpoint");
    checkpoint(t, kind, payload);
  };
  await assert.rejects(d.execute(c, signal()), /lost measurement/);
  assert.equal(submissions, 0); assert.equal(state(s, run).decisions, undefined);
  const other = await Store.open(s.root);
  try {
    const resumed = new SwarmDriver(other, cfg, mock.fetcher, undefined, rpc), result = await resumed.execute(c, signal());
    assert.equal(submissions, 1); assert.equal(mock.bodies.length, 2);
    assert.ok((await resumed.verify(c, result, signal())).checks.every(c => c.verdict === "PASS"));
    assert.equal(other.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='job.intent'").get()!.n, 1);
  } finally { other.close(); }
}, preflight));

test("existing job reconciliation survives stale preflight; new identities and replay drift remain blocked", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  const ops: string[] = [], pending = job("long");
  const rpc = async (_command: any, _cfg: any, raw: any) => {
    ops.push(raw.operation); return { schema: 1, key: raw.key, jobId: raw.key,
      status: raw.operation === "ensure" ? "RUNNING" : "SUCCEEDED", ...(raw.operation === "inspect" ? { result: {} } : {}) };
  };
  const mock = scripted([() => reply("", [write("42"), measure, pending])]);
  const d = new SwarmDriver(s, cfg, mock.fetcher, undefined, rpc);
  await assert.rejects(d.execute(c, signal()), DeferredAttemptError);
  const t = d.journal.open(c, initial()); t.state.feedbackHash = s.artifact("new feedback");
  d.journal.checkpoint(t, "test.new-evidence", {});
  s.db.prepare("UPDATE research_jobs SET poll_at=0").run();
  const jobs = new ResearchJobs(d.journal, cfg, rpc);
  assert.equal((await jobs.execute(c, cfg.spec.agents.coder, pending, signal()) as any).status, "SUCCEEDED");
  assert.deepEqual(ops, ["ensure", "inspect"]);
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, job("new"), signal()), /JOB_PREFLIGHT_REQUIRED/);
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, { ...pending, arguments: { name: "trial", input: { seed: "different" } } }, signal()), /replay input drift/);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs").get()!.n, 1);
}, preflight));

test("remote workers receive exploratory check capabilities but cannot authorize acceptance", async () => fixture(async (s) => {
  const mock = scripted([() => reply("", [write("42"), measure]), () => reply("ready")]);
  const r: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(r.status, "PASS"); assert.equal(state(s, r.id).decisions?.lastMeasurement?.code, 0);
  assert.ok((await integrateSwarm(s, r.id, signal())).checksHash);
}, s => {
  measurements(s); const parent = dirname(s.project), template = join(parent, "worker-template.json");
  writeFileSync(template, JSON.stringify({ checks: { evaluate: { argv: s.checks.evaluate.argv } } }));
  const repo = join(parent, "worker-repo"); execFileSync("git", ["clone", "-q", s.project, repo]);
  const endpoint = resolve("scripts/swarm-worker-agent.py");
  s.workers = { remote: { adapter: { argv: [executable("python3"), endpoint, "--root", join(parent, "workers"), "--repo", repo,
    "--config", template], files: [endpoint, template] }, maxConcurrent: 1, maxRpcBytes: 2 * 1024 * 1024 } };
}));
