import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assessResearch, validateExperimentResult, validateResearchSpec, type ExperimentSpec } from "../../src/harness/foundry/research.ts";
import { runPlanValidation, runResearchValidation, validateResearchConfiguration } from "../../src/harness/foundry/researchValidation.ts";
import { compareResearchStrategies } from "../../src/harness/foundry/researchEvaluation.ts";
import { digest, sha256 } from "../../src/harness/foundry/kernel.ts";
import { pinCommand } from "../../src/harness/foundry/commands.ts";
import { ResearchProgramme } from "../../src/harness/foundry/researchProgramme.ts";
import { selectResearchStrategy } from "../../src/harness/foundry/researchStrategy.ts";
import { ResearchJobs } from "../../src/harness/foundry/swarm/jobs.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { verifyResearch } from "../../src/harness/foundry/swarm/research.ts";
import { loadSwarm, runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { executable, validateSwarmSpec, validateSwarmTasks } from "../../src/harness/foundry/swarm/config.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { tableFixtureSpec, fixtureResult } from "../../adapters/research/table-fixture.mjs";
import { fixture, task, reply, scripted, signal } from "./swarm-fixtures.ts";

const clone = <T>(v: T): T => structuredClone(v);
function sample(kind = "new-unregistered-field") {
  const spec = tableFixtureSpec(kind) as ExperimentSpec;
  const key = digest("test-execution");
  const context = { key, jobId: key, adapterHash: digest("pinned-executor"), artifacts: {
    "raw-data": { sha256: sha256(JSON.stringify((spec.input as any).observations)), bytes: Buffer.byteLength(JSON.stringify((spec.input as any).observations)) } } };
  const result = fixtureResult(spec, { key, jobId: key }); return { spec, context, result };
}
function report(s: ReturnType<typeof sample>, id = "analysis", outcome = "SUPPORTED") {
  const implementationHash = digest(`pinned-${id}`);
  return { id, implementationHash, report: { schema: 1, validator: id, implementationHash, specHash: digest(s.spec),
    resultHash: digest(s.result), contextHash: digest(s.context), checks: s.spec.validation.find(v => v.id === id)!.checks.map(id => ({ id, verdict: "PASS" })), outcome } };
}
const runner = resolve("adapters/research/table-fixture.mjs"), analysis = resolve("adapters/research/paired-table-validator.mjs");
const command = () => ({ argv: [process.execPath, "--experimental-strip-types", analysis],
  files: [resolve("src/harness/foundry/kernel.ts"), resolve("src/harness/foundry/research.ts")] });
const validator = () => ({ command: command(), readOnly: true as const, timeoutMs: 2000, maxOutputBytes: 16384 });
const fixtureValidator = (args: string[] = []) => ({ ...validator(), command: {
  argv: [process.execPath, "--experimental-strip-types", resolve("tests/foundry/fixtures/scientific-validator.mjs"), ...args],
  files: [resolve("src/harness/foundry/kernel.ts")] } });

test("the same core accepts opaque protocols in arbitrary fields without a domain registry", () => {
  for (const kind of ["quantum-project", "biology-project", "materials-project", "previously-unknown-field"]) {
    const s = sample(kind); validateResearchSpec(s.spec); validateExperimentResult(s.spec, s.result, s.context);
    assert.equal(assessResearch(s.spec, s.result, s.context, [report(s)]).outcome, "SUPPORTED");
  }
});

test("execution substitution, partial replications and incomplete raw evidence fail before scientific interpretation", () => {
  const s = sample();
  for (const mutate of [
    (r: any) => r.execution.mode = "physical", (r: any) => r.execution.backend = "different-provider",
    (r: any) => r.execution.configurationHash = digest("other-configuration"),
    (r: any) => r.execution.key = digest("another-submission"), (r: any) => r.execution.jobId = "other-job",
    (r: any) => r.identity.environment = digest("other-environment"),
    (r: any) => r.observations.pop(), (r: any) => r.observations[1] = r.observations[0],
    (r: any) => r.observations[0].unit = "undeclared-control", (r: any) => r.observations[0].data.reading = NaN,
    (r: any) => r.outcome = "SUPPORTED",
  ]) { const result = clone(s.result); mutate(result); assert.throws(() => validateExperimentResult(s.spec, result, s.context)); }
  for (const meta of [{}, { bytes: 999999, sha256: digest("data") }, { bytes: 1, sha256: "invalid" },
    { bytes: 1, sha256: digest("data"), truncated: true }]) {
    assert.throws(() => validateExperimentResult(s.spec, s.result, { ...s.context, artifacts: { "raw-data": meta } }));
  }
  assert.throws(() => validateResearchSpec({ ...s.spec, units: [{ id: "primary", role: "primary", replicates: [] }] }));
});

test("all required validator checks and exact implementation/result/context bindings are mandatory", () => {
  const s = sample(), original = report(s);
  assert.throws(() => assessResearch(s.spec, s.result, s.context, []), /incomplete/);
  for (const change of [{ contextHash: digest("other-run") }, { resultHash: digest("other-result") },
    { specHash: digest("changed-protocol") }, { implementationHash: digest("other-validator") },
    { checks: [] }, { checks: original.report.checks.map(c => ({ ...c, verdict: "UNKNOWN" })) },
    { checks: original.report.checks.map(c => ({ ...c, verdict: "FAIL" })) },
    { checks: original.report.checks.map(c => ({ ...c, id: "easier-substitute" })) }]) {
    assert.throws(() => assessResearch(s.spec, s.result, s.context, [{ ...original, report: { ...original.report, ...change } }]));
  }
  assert.throws(() => validateResearchConfiguration({ spec: s.spec }), /independent/);
  assert.throws(() => validateResearchConfiguration({ spec: s.spec, validators: { analysis: { ...validator(), readOnly: false as any } } }), /read-only/);
});

test("independent disagreement remains explicit despite two agreeing validators", () => {
  const s = sample(); s.spec.validation = ["first", "second", "third"].map(id => ({ id, checks: ["method-check"] }));
  s.result.specHash = digest(s.spec);
  const assessment = assessResearch(s.spec, s.result, s.context, [report(s, "first"), report(s, "second", "REFUTED"), report(s, "third")]);
  assert.equal(assessment.conflicted, true); assert.equal(assessment.outcome, "INCONCLUSIVE"); assert.equal(assessment.validation!.length, 3);
  const decision = selectResearchStrategy({ schema: 1, maxExperiments: 2, maxSnapshotBytes: 4096, stopOnRefutation: false,
    candidates: [{ id: "first", template: "one", line: "same-hypothesis", purpose: "falsification" },
      { id: "next", template: "two", line: "same-hypothesis", purpose: "exploration" }] }, [{ key: "receipt", candidate: "first", assessment }], 1);
  assert.equal(decision.next, null); assert.deepEqual(decision.blockedLines, ["same-hypothesis"]);
});

test("separate validator subprocesses compute outcomes and cached reports retain exact bindings", async () => {
  const s = sample(), validators = { analysis: { ...validator(), command: pinCommand(command(), process.cwd()) } };
  const options = { legacyTimeoutMs: 2000, maxOutputBytes: 16384 };
  const first = await runResearchValidation(s.spec, s.result, s.context, validators, signal(), options);
  assert.equal(first.assessment.outcome, "SUPPORTED");
  const cached = first.assessment.validation!.map(v => ({ ...v, report: first.evidence.find(e => digest(e) === v.reportHash) }));
  const replay = await runResearchValidation(s.spec, s.result, s.context, validators, signal(), { ...options, cached });
  assert.deepEqual(replay, first);
  const changed = clone(s.result); changed.observations[0].data.reading = 0.1;
  await assert.rejects(runResearchValidation(s.spec, changed, s.context, validators, signal(), { ...options, cached }), /binding/);
  const wrong = { analysis: { ...validators.analysis, command: pinCommand({ argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }, process.cwd()), timeoutMs: 100 } };
  await assert.rejects(runResearchValidation(s.spec, s.result, s.context, wrong, signal(), options), /timed out|cancelled/);
});

test("schema-2 matched comparisons require separate validation and retain rejected reports", async () => {
  const s = sample(), executor = { argv: [process.execPath, "--experimental-strip-types", runner, "--evaluate"], files: [analysis] };
  const protocol: any = { schema: 1, name: "generic-comparison", executor, validators: { analysis: validator() }, maxArmMs: 10000, maxOutputBytes: 65536,
    cases: [{ id: "opaque-project", strategy: { schema: 1, maxExperiments: 1, maxSnapshotBytes: 4096, stopOnRefutation: true,
      candidates: [{ id: "trial", template: "trial", line: "hypothesis", purpose: "falsification" }] }, experiments: { trial: s.spec } }] };
  const pinned = pinCommand(executor, process.cwd());
  const valid = await compareResearchStrategies(protocol, pinned, signal());
  assert.equal(valid.allEvidenceValid, true); assert.ok(valid.validatorHashes!.analysis);
  for (const arm of Object.values(valid.cases[0].arms) as any[]) assert.equal(arm.records[0].assessment.validation.length, 1);
  protocol.validators.analysis = fixtureValidator(["--verdict", "UNKNOWN"]);
  const invalid = await compareResearchStrategies(protocol, pinned, signal());
  assert.equal(invalid.allEvidenceValid, false);
  for (const arm of Object.values(invalid.cases[0].arms) as any[]) {
    assert.equal(arm.validExperiments, 0); assert.equal(arm.records[0].validationEvidence[0].checks[0].verdict, "UNKNOWN");
  }
});

function configure(s: any) {
  const spec = tableFixtureSpec("operator-defined-field"), folder = dirname(s.project), path = join(folder, "experiment.json");
  writeFileSync(path, JSON.stringify(spec));
  const endpoint = resolve("scripts/research-job-agent.py"), template = join(folder, "template.json");
  writeFileSync(template, JSON.stringify({ argv: [process.execPath, "--experimental-strip-types", runner, "--spec", path],
    resultMaxBytes: 65536, timeoutMs: 5000, artifacts: { "raw-data": { maxBytes: 65536 } } }));
  s.jobs = { trial: { adapter: { argv: [executable("python3"), endpoint, "--root", join(folder, "spool"), "--config", template],
    files: [endpoint, template, runner, analysis, path, resolve("src/harness/foundry/kernel.ts")] },
    research: { spec, validators: { analysis: validator() } }, idempotentEnsure: true,
    pollMs: 100, staleMs: 10000, maxJobs: 4, maxConcurrent: 2 } };
  s.agents.coder.tools.push("run_job", "read_job_artifact"); s.agents.coder.jobs = ["trial"];
  s.researchProgramme = { id: "general-science", maxFindingsPerTask: 4, maxContextBytes: 24000 };
}

test("durable jobs capture raw files, expose owned pages and publish only independently checked findings", async () => fixture(async (s, cfg) => {
  const input = cfg.spec.jobs!.trial.research!.spec.input;
  const mock = scripted([
    () => reply("", [{ name: "run_job", arguments: { name: "trial", input } }]),
    () => {
      const row = s.db.prepare("SELECT result_hash FROM research_jobs").get()!;
      return reply("", [{ name: "read_job_artifact", arguments: { receipt: String(row.result_hash), artifact: "raw-data", offset: 0, length: 100 } }]);
    },
    body => {
      const page = JSON.parse(body.messages.filter((m: any) => m.role === "tool").at(-1).content);
      assert.ok(page.content.startsWith('[{"unit":"candidate"')); assert.equal(page.artifact, "raw-data");
      return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    () => reply("submit for independent verification"),
  ]);
  const result: any = await runSwarm(s, [{ ...task(), research: ["trial"] }], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS", JSON.stringify(s.db.prepare("SELECT error FROM tasks").all()));
  const row = s.db.prepare("SELECT assessment_hash FROM research_assessments").get()!;
  const assessment: any = s.readArtifact(String(row.assessment_hash)); assert.equal(assessment.validation.length, 1);
  const report: any = s.readArtifact(assessment.validation[0].reportHash);
  assert.equal(report.contextHash, assessment.contextHash); assert.equal(report.checks.length, 3);
  const p = new ResearchProgramme(s, cfg.spec.researchProgramme!), finding = (p.list() as any).findings[0];
  assert.equal(p.read({ id: finding.id, version: finding.version }).assessment.outcome, "SUPPORTED");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_plan_reports").get()!.n, 1);
}, s => {
  configure(s);
  (s.jobs!.trial.research!.spec as ExperimentSpec).planValidation = [{ id: "analysis", checks: ["analysis-parameters", "paired-design"] }];
  writeFileSync(join(dirname(s.project), "experiment.json"), JSON.stringify(s.jobs!.trial.research!.spec));
}));

test("disagreeing scientific validators publish a conflicted finding that cannot enter later task context", async () => fixture(async (s, cfg) => {
  const mock = scripted([
    () => reply("", [{ name: "run_job", arguments: { name: "trial", input: cfg.spec.jobs!.trial.research!.spec.input } }]),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("ready for independent checks"),
  ]);
  const result: any = await runSwarm(s, [{ ...task(), research: ["trial"] }], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS", JSON.stringify(s.db.prepare("SELECT error FROM tasks").all()));
  const p = new ResearchProgramme(s, cfg.spec.researchProgramme!), finding = (p.list() as any).findings[0];
  assert.equal(finding.state, "CONFLICTED");
  assert.throws(() => p.context([{ id: finding.id, version: finding.version }]), /conflicted/);
  const record = p.read({ id: finding.id, version: finding.version }, true);
  assert.equal(record.assessment.conflicted, true); assert.equal(record.assessment.validation!.length, 2);
}, s => {
  configure(s); const config = s.jobs!.trial.research!;
  (config.spec as ExperimentSpec).validation.push({ id: "crosscheck", checks: ["independent-method"] });
  config.validators!.crosscheck = fixtureValidator();
  writeFileSync(join(dirname(s.project), "experiment.json"), JSON.stringify(config.spec));
}));

test("unknown validator checks retain their report and raw evidence without scientific acceptance", async () => fixture(async (s, cfg) => {
  const mock = scripted([
    () => reply("", [{ name: "run_job", arguments: { name: "trial", input: cfg.spec.jobs!.trial.research!.spec.input } }]),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("ready for checks"),
  ]);
  const result: any = await runSwarm(s, [{ ...task(), research: ["trial"] }], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "FAIL");
  const event = s.db.prepare("SELECT * FROM events WHERE kind='research.validation.observed'").get()!;
  const report: any = s.readArtifact(JSON.parse(String(event.payload)).reportHash);
  assert.ok(report.checks.every((c: any) => c.verdict === "UNKNOWN"));
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_assessments").get()!.n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_knowledge").get()!.n, 0);
  assert.ok(s.db.prepare("SELECT result_hash FROM research_jobs").get()!.result_hash);
}, s => { configure(s); s.recipe.attempts = 1; s.jobs!.trial.research!.validators!.analysis = fixtureValidator(["--verdict", "UNKNOWN"]); }));

test("scientific replay reuses immutable reports and never submits a replacement experiment", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([{ ...task(), research: ["trial"] }]), c = q.capsule(q.claim(run, "test")!);
  const spec = cfg.spec.jobs!.trial.research!.spec as ExperimentSpec;
  let calls = 0;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_cmd, _cfg, request: any) => {
    calls++; const result = fixtureResult(spec, { key: request.key, jobId: request.key });
    return { schema: 1, key: request.key, jobId: request.key, status: "SUCCEEDED", result: { exitCode: 0, data: result,
      artifacts: { "raw-data": { bytes: 100, sha256: digest("trusted-adapter-fixture") } } } };
  });
  const call = { id: "first", name: "run_job", arguments: { name: "trial", input: spec.input } };
  await jobs.execute(c, cfg.spec.agents.coder, call, signal());
  const first = await verifyResearch(s, cfg, c, signal()); assert.equal(first.verdict, "PASS", first.detail);
  assert.deepEqual(await verifyResearch(s, cfg, c, signal()), first);
  await jobs.execute(c, cfg.spec.agents.coder, { ...call, id: "new-tool-id" }, signal());
  assert.equal(calls, 1); assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='research.assessed'").get()!.n, 1);
}, configure));

test("validator authority, time/output budgets, protected code and credential isolation are enforced", async () => fixture(async (_store, cfg, project) => {
  const candidate = clone(cfg.spec); candidate.agents.coder.keyEnv = "MODEL_SECRET";
  candidate.jobs!.trial.research!.validators!.analysis.command.envAllow = ["MODEL_SECRET"];
  assert.throws(() => validateSwarmSpec(candidate), /credentials/);
  const excessive = clone(cfg.spec); excessive.jobs!.trial.research!.validators!.analysis.timeoutMs = 6000;
  assert.throws(() => validateSwarmSpec(excessive), /budget/);
  assert.throws(() => validateSwarmTasks(cfg.spec, [{ ...task(), writeScope: ["validator.mjs"] }]));
  writeFileSync(join(project, "validator.mjs"), "// changed validator implementation\n");
  assert.throws(() => loadSwarm(_store), /implementation changed/);
}, s => {
  configure(s); const path = join(s.project, "validator.mjs"); writeFileSync(path, readFileSync(analysis));
  s.jobs!.trial.research!.validators!.analysis.command = { argv: [process.execPath, "--experimental-strip-types", path] };
}));


function configurePlan(s: any, verdict = "PASS") {
  configure(s);
  s.jobs.trial.research.spec.planValidation = [{ id: "design", checks: ["analysis-parameters", "paired-design"] }];
  s.jobs.trial.research.validators.design = fixtureValidator(["--verdict", verdict]);
  // The executor's frozen spec file must include the plan, too.
  writeFileSync(join(dirname(s.project), "experiment.json"), JSON.stringify(s.jobs.trial.research.spec));
}

test("plan contracts reject missing commands, undeclared checks and unbounded requirements", () => {
  const { spec } = sample(); spec.planValidation = [{ id: "design", checks: ["paired-design"] }];
  assert.throws(() => validateResearchConfiguration({ spec, validators: { analysis: validator() } }));
  for (const requirements of [[], [{ id: "design", checks: [] }], [{ id: "design", checks: ["a", "a"] }],
    Array.from({ length: 9 }, (_, i) => ({ id: `v${i}`, checks: ["a"] }))])
    assert.throws(() => validateResearchSpec({ ...spec, planValidation: requirements }));
});

test("independent plan checks reject invalid methods before execution and bind cached reports to the exact plan", async () => {
  const { spec } = sample(); spec.planValidation = [{ id: "analysis", checks: ["analysis-parameters", "paired-design"] }];
  const validators = { analysis: { ...validator(), command: pinCommand(command(), process.cwd()) } };
  const context = { key: digest("submission"), adapterHash: digest("adapter"), inputHash: digest(spec.input) };
  const cached: any[] = [];
  await runPlanValidation(spec, context, validators, signal(), { onReport: (id, implementationHash, _request, report) => cached.push({ id, implementationHash, report }) });
  assert.equal(cached.length, 1);
  await runPlanValidation(spec, context, validators, signal(), { cached, onReport: () => assert.fail("must replay") });
  await assert.rejects(runPlanValidation(spec, { ...context, key: digest("different-submission") }, validators, signal(), { cached }), /binding/);
  const changed = clone(spec); (changed.parameters as any).analysis.alpha = 1;
  await assert.rejects(runPlanValidation(changed, context, validators, signal()), /invalid paired analysis parameters/);
  await assert.rejects(runPlanValidation(spec, context, validators, signal(), { cached: [{ ...cached[0], report: { ...cached[0].report, phase: "result" } }] }), /binding/);
  const slow = { analysis: { ...validators.analysis, command: pinCommand({ argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }, process.cwd()), timeoutMs: 80 } };
  await assert.rejects(runPlanValidation(spec, context, slow, signal()), /timed out|cancelled/);
  const large = { analysis: { ...validators.analysis, command: pinCommand({ argv: [process.execPath, "-e", "console.log('x'.repeat(3000))"] }, process.cwd()), maxOutputBytes: 100 } };
  await assert.rejects(runPlanValidation(spec, context, large, signal()), /byte budget/);
});

test("interrupted plan validation replays completed reports and runs only missing read-only checks", async () => {
  const { spec } = sample(); spec.planValidation = ["first", "second"].map(id => ({ id, checks: ["design"] }));
  const pinned = { ...fixtureValidator(), command: pinCommand(fixtureValidator().command, process.cwd()) };
  const validators = { analysis: pinned, first: pinned, second: pinned };
  const context = { key: digest("interrupted"), adapterHash: digest("adapter"), inputHash: digest(spec.input) }, cached: any[] = [];
  await assert.rejects(runPlanValidation(spec, context, validators, signal(), { onReport: (id, implementationHash, _request, report) => {
    cached.push({ id, implementationHash, report }); throw new Error("host interrupted after durable report");
  } }), /interrupted/);
  const observed: string[] = [];
  await runPlanValidation(spec, context, validators, signal(), { cached, onReport: id => { observed.push(id); } });
  assert.deepEqual(observed, ["second"]);
});

for (const verdict of ["FAIL", "UNKNOWN"]) test(`${verdict} plan checks retain rejection and never submit or consume job quota`, async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "test")!);
  let rpc = 0;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async () => { rpc++; assert.fail("plan rejection must precede external RPC"); });
  const call = { id: "attempt", name: "run_job", arguments: { name: "trial", input: cfg.spec.jobs!.trial.research!.spec.input } };
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, call, signal()), /plan check failed or unknown/);
  // A new host object and tool id recover the same durable rejection.
  const restarted = new ResearchJobs(new SessionJournal(s), cfg, jobs.rpc);
  await assert.rejects(restarted.execute(c, cfg.spec.agents.coder, { ...call, id: "retry" }, signal()), /plan check failed or unknown/);
  assert.equal(rpc, 0); assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_jobs").get()!.n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='job.intent'").get()!.n, 0);
  const rows = s.db.prepare("SELECT * FROM research_plan_reports").all(); assert.equal(rows.length, 1);
  assert.equal((s.readArtifact(String(rows[0].report_hash)) as any).checks[0].verdict, verdict);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='research.plan.observed'").get()!.n, 1);
}, s => configurePlan(s, verdict)));

test("lost leases during plan validation cannot admit an external job", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "test")!);
  let rpc = 0;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async () => { rpc++; assert.fail(); });
  const pending = jobs.execute(c, cfg.spec.agents.coder, { id: "stale", name: "run_job", arguments: {
    name: "trial", input: cfg.spec.jobs!.trial.research!.spec.input } }, signal());
  s.db.prepare("UPDATE tasks SET fence=fence+1 WHERE run=? AND id=?").run(run, c.task.id);
  await assert.rejects(pending, /stale agent lease/);
  assert.equal(rpc, 0); assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_jobs").get()!.n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_plan_reports").get()!.n, 0);
}, configurePlan));

test("passing plan receipts survive host restart and do not replace independent result acceptance", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([{ ...task(), research: ["trial"] }]), c = q.capsule(q.claim(run, "test")!);
  const spec = cfg.spec.jobs!.trial.research!.spec as ExperimentSpec; let rpc = 0;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_cmd, _cfg, request: any) => {
    rpc++; return { schema: 1, key: request.key, jobId: request.key, status: "SUCCEEDED", result: {
      exitCode: 0, data: fixtureResult(spec, { key: request.key, jobId: request.key }),
      artifacts: { "raw-data": { bytes: 100, sha256: digest("fixture") } } } };
  });
  const call = { id: "first", name: "run_job", arguments: { name: "trial", input: spec.input } };
  const first = await jobs.execute(c, cfg.spec.agents.coder, call, signal());
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='research.assessed'").get()!.n, 0);
  const restarted = new ResearchJobs(new SessionJournal(s), cfg, jobs.rpc);
  assert.deepEqual(await restarted.execute(c, cfg.spec.agents.coder, { ...call, id: "after-restart" }, signal()), first);
  assert.equal(rpc, 1); assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_plan_reports").get()!.n, 1);
  const intent = s.db.prepare("SELECT payload FROM events WHERE kind='job.intent'").get()!;
  const receipts = JSON.parse(String(intent.payload)).planReceipts;
  assert.equal(receipts.length, 1); assert.equal((s.readArtifact(receipts[0]) as any).phase, "plan");
  const checked = await verifyResearch(s, cfg, c, signal()); assert.equal(checked.verdict, "PASS", checked.detail);
}, configurePlan));


test("adapter pin drift during plan validation blocks submission", async () => fixture(async (s, cfg, project) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "test")!); let rpc = 0;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async () => { rpc++; assert.fail(); });
  const pending = jobs.execute(c, cfg.spec.agents.coder, { id: "drift", name: "run_job", arguments: {
    name: "trial", input: cfg.spec.jobs!.trial.research!.spec.input } }, signal());
  writeFileSync(join(project, "adapter-manifest.json"), "changed after validation started");
  await assert.rejects(pending, /implementation changed/);
  assert.equal(rpc, 0); assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_jobs").get()!.n, 0);
}, s => {
  configurePlan(s); const file = join(s.project, "adapter-manifest.json"); writeFileSync(file, "frozen configuration");
  s.jobs!.trial.adapter.files!.push(file);
}));

test("local comparisons also reject a plan before invoking the experiment executor", async () => fixture(async (_s, _cfg, project) => {
  const { spec } = sample(); spec.planValidation = [{ id: "design", checks: ["review"] }];
  const marker = join(project, "executor-was-invoked");
  const executor = { argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'executed');process.exit(1)", marker] };
  const protocol: any = { schema: 1, name: "plan-gated-comparison", executor,
    validators: { analysis: validator(), design: fixtureValidator(["--verdict", "FAIL"]) }, maxArmMs: 10000, maxOutputBytes: 65536,
    cases: [{ id: "case", strategy: { schema: 1, maxExperiments: 1, maxSnapshotBytes: 4096, stopOnRefutation: true,
      candidates: [{ id: "trial", template: "trial", line: "hypothesis", purpose: "exploration" }] }, experiments: { trial: spec } }] };
  const report = await compareResearchStrategies(protocol, pinCommand(executor, process.cwd()), signal());
  assert.equal(report.allEvidenceValid, false);
  for (const arm of Object.values(report.cases[0].arms) as any[]) {
    assert.equal(arm.status, "INVALID_EVIDENCE"); assert.equal(arm.validExperiments, 0); assert.equal(arm.jobs, 0);
    assert.equal(arm.records[0].planEvidence[0].checks[0].verdict, "FAIL"); assert.equal(arm.records[0].resultHash, undefined);
  }
  assert.equal(existsSync(marker), false, "rejected plan must not start even a local executor");
}));
