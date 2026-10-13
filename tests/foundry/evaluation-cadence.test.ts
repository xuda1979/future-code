import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { fixture, reply, scripted, signal, task } from "./swarm-fixtures.ts";
import { validateSwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { spec } from "./swarm-fixtures.ts";
import { checkpointReason } from "../../src/harness/foundry/swarm/evaluation.ts";
import type { ThreadState } from "../../src/harness/foundry/swarm/session.ts";

const supervised = (s: any) => {
  s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 3600000 };
};
const events = (s: any, run: string, kind: string) => s.db.prepare(
  "SELECT payload FROM agent_events WHERE run=? AND kind=? ORDER BY seq").all(run, kind)
  .map((r: any) => s.readArtifact(r.payload));

test("fast inspection turns obtain an evaluation before the wall-clock interval elapses", async () =>
  fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const mock = scripted([
      ...Array.from({ length: 4 }, (_, i) => () => reply("inspect", [
        { id: `read-${i}`, name: "read_file", arguments: { path: "src/a.txt" } }])),
      body => {
        const checks = events(s, run, "checkpoint.checked");
        assert.equal(checks.length, 1, "four unmeasured turns must trigger a real check");
        assert.equal(checks[0].reason, "turn-budget");
        assert.ok(JSON.stringify(body.messages).includes("checkpointCheck"));
        return reply("repair the measured failure", [
          { name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
      },
      () => reply("ready for independent verification"),
    ]);
    const d = new SwarmDriver(s, cfg, mock.fetcher), result = await d.execute(c, signal());
    assert.equal(mock.bodies.length, 6);
    assert.equal((await d.verify(c, result, signal())).checks.find(r => r.id === "behavior")?.verdict, "PASS");
  }, supervised));

test("a completed external experiment triggers evaluation before the next model decision", async () =>
  fixture(async (s, cfg) => {
    const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
    const mock = scripted([
      () => reply("experiment", [{ name: "run_job", arguments: { name: "trial", input: {} } }]),
      () => {
        assert.equal(events(s, run, "checkpoint.checked").length, 1,
          "new experiment evidence must not wait for the timer");
        assert.equal(events(s, run, "checkpoint.checked")[0].reason, "new-evidence");
        return reply("repair", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
      },
      () => reply("done"),
    ]);
    const d = new SwarmDriver(s, cfg, mock.fetcher, undefined, async (_cmd, _cfg, raw: any) =>
      ({ schema: 1, key: raw.key, jobId: raw.key, status: "SUCCEEDED", result: { score: 0.1 } }));
    await d.execute(c, signal());
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM research_jobs").get()!.n, 1);
  }, s => {
    supervised(s);
    s.jobs = { trial: { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
      idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 4, maxConcurrent: 2 } };
    s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = ["trial"];
  }));

test("passing micro-probes cannot replace outcome evaluation", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  const mock = scripted([
    ...Array.from({ length: 4 }, (_, i) => () => reply("probe", [{ id: `probe-${i}`, name: "run_probe",
      arguments: { name: "smoke", hypothesis: "runtime launches", falsifyWhen: "nonzero exit", negativeControl: "irrelevant to outcome" } }])),
    () => {
      assert.equal(events(s, run, "checkpoint.checked")[0]?.check, "behavior");
      return reply("done");
    },
  ]);
  await new SwarmDriver(s, cfg, mock.fetcher).execute(c, signal());
}, s => {
  supervised(s);
  s.checks.smoke = { argv: [process.execPath, "-e", "process.exit(0)"], replaySafe: true, probeTimeoutMs: 2000 };
  s.agents.coder.tools.push("run_probe"); s.agents.coder.probes = ["smoke"];
}));

test("the chosen evaluation check is distinct from an unrelated passing check", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  const mock = scripted([
    ...Array.from({ length: 4 }, (_, i) => () => reply("smoke", [{ id: `smoke-${i}`, name: "run_check", arguments: { name: "smoke" } }])),
    () => {
      const checks = events(s, run, "checkpoint.checked");
      assert.equal(checks.length, 1); assert.equal(checks[0].check, "behavior");
      return reply("done");
    },
  ]);
  await new SwarmDriver(s, cfg, mock.fetcher).execute(c, signal());
}, s => {
  supervised(s);
  s.checks.smoke = { argv: [process.execPath, "-e", "process.exit(0)"], replaySafe: true };
  s.agents.coder.checks = ["smoke", "behavior"]; s.agents.coder.checkpointCheck = "behavior";
}));

test("an explicit current evaluation is reused during unchanged read turns", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  const mock = scripted([
    () => reply("measure baseline", [{ name: "run_check", arguments: { name: "behavior" } }]),
    ...Array.from({ length: 5 }, (_, i) => () => reply("read", [{ id: `read-${i}`, name: "read_file", arguments: { path: "src/a.txt" } }])),
    () => reply("done"),
  ]);
  const d = new SwarmDriver(s, cfg, mock.fetcher), result = await d.execute(c, signal());
  assert.equal(events(s, run, "checkpoint.checked").length, 0);
  assert.equal((await d.verify(c, result, signal())).checks.find(r => r.id === "behavior")?.verdict, "FAIL",
    "an exploratory observation cannot certify the broken final source");
}, supervised));

test("healthy short tasks need no additional evaluation or model request", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  const mock = scripted([
    () => reply("edit", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("done"),
  ]);
  const d = new SwarmDriver(s, cfg, mock.fetcher), result = await d.execute(c, signal());
  assert.equal(mock.bodies.length, 2); assert.equal(events(s, run, "checkpoint.checked").length, 0);
  assert.equal((await d.verify(c, result, signal())).checks.find(r => r.id === "behavior")?.verdict, "PASS");
}, supervised));

test("operator evaluation selection and cadence are validated before initialization", () => {
  const s = spec("/tmp/project"); supervised(s);
  for (const invalid of [0, -1, 1.5, 1001, Infinity]) {
    s.supervision!.checkpointEveryTurns = invalid;
    assert.throws(() => validateSwarmSpec(s), /checkpointEveryTurns/);
  }
  s.supervision!.checkpointEveryTurns = 2;
  s.supervision!.checkpointAfterEvidence = false; s.agents.coder.checkpointCheck = "behavior";
  validateSwarmSpec(s);
  s.agents.coder.checkpointCheck = "missing";
  assert.throws(() => validateSwarmSpec(s), /checkpoint check/);
  s.agents.coder.checkpointCheck = "behavior";
  s.supervision!.checkpointAfterEvidence = "yes" as any;
  assert.throws(() => validateSwarmSpec(s), /checkpointAfterEvidence/);
});

test("micro-probe activity cannot replenish the wall-clock evaluation interval", () => {
  const s = spec("/tmp/project"); supervised(s);
  s.supervision!.checkpointEveryMs = 100; s.supervision!.checkpointEveryTurns = 1000;
  const state: ThreadState = { turns: 2, toolCalls: 2, patchHash: null, feedbackHash: null,
    pending: null, output: null, history: [], lastCheckAt: 200, evaluationStartedAt: 0 };
  assert.equal(checkpointReason(state, { spec: s } as any, s.agents.coder, 200), "interval");
});

test("a lost model checkpoint after an automatic evaluation replays without another check or request", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  const mock = scripted([
    ...Array.from({ length: 4 }, (_, i) => () => reply("inspect", [{ id: `read-${i}`, name: "read_file", arguments: { path: "src/a.txt" } }])),
    () => reply("repair", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("done"),
  ]);
  const old = new SwarmDriver(s, cfg, mock.fetcher), save = old.journal.checkpoint.bind(old.journal);
  old.journal.checkpoint = (t, kind, payload) => {
    if (kind === "model.reply" && t.state.turns === 5) throw new Error("injected lost model checkpoint");
    save(t, kind, payload);
  };
  await assert.rejects(old.execute(c, signal()), /injected lost model checkpoint/);
  const next = new SwarmDriver(s, cfg, mock.fetcher), result = await next.execute(c, signal());
  assert.equal(mock.bodies.length, 6); assert.equal(events(s, run, "checkpoint.checked").length, 1);
  assert.equal(events(s, run, "model.reply").length, 6);
  assert.equal((await next.verify(c, result, signal())).checks.find(r => r.id === "behavior")?.verdict, "PASS");
}, supervised));

test("automatic evaluation clears a due write policy using its diagnostic and retains transactional preflights", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  const current = () => s.readArtifact(s.db.prepare("SELECT state FROM agent_threads WHERE run=?").get(run)!.state) as any;
  let submissions = 0;
  const mock = scripted([
    () => reply("first change", [{ name: "write_file", arguments: { path: "src/a.txt", content: "1\n" } }]),
    () => reply("second change", [{ name: "write_file", arguments: { path: "src/a.txt", content: "2\n" } }]),
    () => {
      const checks = events(s, run, "checkpoint.checked");
      assert.equal(checks.length, 1); assert.equal(checks[0].check, "evaluate");
      assert.equal(checks[0].reason, "measurement-due");
      assert.equal(current().decisions.review, undefined);
      assert.equal(current().decisions.lastMeasurement.code, 1, "a negative measurement reopens the repair path");
      return reply("repair, measure, then fan out", [
        { name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } },
        { name: "run_check", arguments: { name: "evaluate" } },
        ...["a", "b"].map(id => ({ id, name: "run_job", arguments: { name: "trial", input: { seed: id } } })),
      ]);
    },
    () => reply("ready for acceptance"),
  ]);
  const d = new SwarmDriver(s, cfg, mock.fetcher, undefined, async (_cmd, _cfg, raw: any) => {
    submissions++;
    return { schema: 1, key: raw.key, jobId: raw.key, status: "SUCCEEDED", result: {} };
  });
  const result = await d.execute(c, signal());
  assert.equal(submissions, 2); assert.equal(mock.bodies.length, 4);
  const intents = s.db.prepare("SELECT payload FROM events WHERE run=? AND kind='job.intent'").all(run);
  assert.equal(intents.length, 2);
  for (const intent of intents) {
    const proof: any = s.readArtifact(JSON.parse(intent.payload as string).preflightReceipt);
    assert.equal(proof.observations[0].name, "evaluate");
    assert.ok(d.journal.ownsReceipt(c, proof.observations[0].receipt));
  }
  const verification = await d.verify(c, result, signal());
  assert.equal(verification.checks.find(r => r.id === "behavior")?.verdict, "PASS");
  assert.equal(verification.checks.some(r => r.id === "evaluate"), false, "exploratory diagnostics remain separate from acceptance");
}, s => {
  supervised(s);
  s.checks.evaluate = { ...s.checks.behavior };
  s.checks.evaluate.diagnosticPaths = ["src/b.txt"];
  s.agents.coder.diagnostics = ["evaluate"];
  s.agents.coder.checkpointCheck = "behavior";
  s.agents.coder.decisionPolicy = { maxUnmeasuredWriteTurns: 2, measurementChecks: ["evaluate"] };
  s.jobs = { trial: { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
    idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 4, maxConcurrent: 2, preflightChecks: ["evaluate"] } };
  s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = ["trial"];
}));

test("supervision may select a diagnostic without adding it to acceptance", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "worker")!);
  const mock = scripted([
    ...Array.from({ length: 4 }, (_, i) => () => reply("read", [{ id: `read-${i}`, name: "read_file", arguments: { path: "src/a.txt" } }])),
    () => {
      assert.equal(events(s, run, "checkpoint.checked")[0]?.check, "evaluate");
      return reply("repair", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    () => reply("done"),
  ]);
  const d = new SwarmDriver(s, cfg, mock.fetcher), result = await d.execute(c, signal());
  const checked = await d.verify(c, result, signal());
  assert.equal(checked.checks.find(r => r.id === "behavior")?.verdict, "PASS");
  assert.equal(checked.checks.some(r => r.id === "evaluate"), false);
}, s => {
  supervised(s); s.checks.evaluate = { ...s.checks.behavior };
  s.agents.coder.diagnostics = ["evaluate"]; s.agents.coder.checkpointCheck = "evaluate";
}));
