import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { generalizationFeedback } from "../../src/harness/foundry/generalization.ts";
import { assessResearch, validateResearchSpec, type ExperimentSpec } from "../../src/harness/foundry/research.ts";
import { tableFixtureSpec, fixtureResult } from "../../adapters/research/table-fixture.mjs";
import { ResearchJobs } from "../../src/harness/foundry/swarm/jobs.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { verifyResearch } from "../../src/harness/foundry/swarm/research.ts";
import { integrateSwarm, runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { fixture, task, reply, scripted, signal } from "./swarm-fixtures.ts";

function sample() {
  const spec = tableFixtureSpec("unregistered-project") as ExperimentSpec;
  spec.acceptance = "supported-hypothesis";
  spec.generalization = {
    schema: 1, validator: "analysis", candidateHash: digest("candidate"), exposureHash: digest("all-adaptive-inputs"),
    scoringHash: digest("frozen-scorer-and-runtime"), maxDevelopmentGap: 0.2,
    suites: ["development", "external"].map(id => ({ id, role: id as "development" | "external", manifestHash: digest(id),
      minimumGroups: 30, minimumSources: 1, minimumSuccessRate: 0.8,
      slices: [{ id: "required", minimumGroups: 30 }] })),
  };
  const evidence: any = { candidateHash: spec.generalization.candidateHash, exposureHash: spec.generalization.exposureHash,
    scoringHash: spec.generalization.scoringHash, suites: spec.generalization.suites.map(s => ({ id: s.id, manifestHash: s.manifestHash,
      disjointFromExposure: "PASS", groups: Array.from({ length: 30 }, (_, i) => ({ id: digest([s.id, i]),
        source: s.id, slices: ["required"], verdict: "PASS" })) })) };
  return { spec, evidence };
}
function assess(s: ReturnType<typeof sample>, mutate?: (report: any) => void) {
  const key = digest("execution"), context = { key, jobId: key, adapterHash: digest("adapter"),
    artifacts: { "raw-data": { sha256: digest("raw"), bytes: 100 } } };
  const result = fixtureResult(s.spec, { key, jobId: key });
  const reports = s.spec.validation.map(v => {
    const implementationHash = digest(["independent-validator", v.id]);
    const report: any = { schema: 1, validator: v.id, implementationHash, specHash: digest(s.spec), resultHash: digest(result),
      contextHash: digest(context), checks: v.checks.map(id => ({ id, verdict: "PASS" })), outcome: "SUPPORTED",
      ...(v.id === (s.spec.generalization?.validator ?? "analysis") ? { generalization: s.evidence } : {}) };
    mutate?.(report); return { id: v.id, implementationHash, report };
  });
  return assessResearch(s.spec, result, context, reports);
}
const codes = (a: ReturnType<typeof assess>) => a.generalization!.diagnostics.map(d => d.code);

test("a perfect small development suite cannot hide poor external generalization", () => {
  const s = sample(); s.evidence.suites[0].groups.length = 18;
  s.evidence.suites[1].groups.forEach((g: any, i: number) => g.verdict = i < 3 ? "PASS" : "FAIL");
  const a = assess(s);
  assert.equal(a.outcome, "REFUTED");
  assert.ok(codes(a).includes("INSUFFICIENT_GROUPS"));
  assert.ok(codes(a).includes("PERFORMANCE_BELOW_TARGET"));
  assert.ok(codes(a).includes("DISTRIBUTION_GAP"));
  assert.equal(a.generalization!.suites[0].groups, 18);
  assert.equal(a.generalization!.suites[1].passed, 3);
});

test("a frozen external contract passes only with enough independent measured coverage", () => {
  const a = assess(sample()); assert.equal(a.outcome, "SUPPORTED");
  assert.deepEqual(a.generalization!.diagnostics, []);
  const external = a.generalization!.suites[1];
  // Independently derived Wilson interval for 30/30, z = 1.959963984540054.
  assert.ok(Math.abs(external.lower - 0.8864866068260312) < 1e-12);
  assert.equal(external.upper, 1);
});

test("small perfect suites, missing suites and unknown trials remain inconclusive", () => {
  for (const change of [
    (s: any) => s.evidence.suites.forEach((r: any) => r.groups.length = 18),
    (s: any) => s.evidence.suites.pop(),
    (s: any) => s.evidence.suites.forEach((r: any) => r.groups = []),
    (s: any) => s.evidence.suites[1].groups[0].verdict = "UNKNOWN",
    (s: any) => s.evidence.suites[1].disjointFromExposure = "UNKNOWN",
    (s: any) => s.spec.generalization.suites[1].minimumSuccessRate = 0.99,
  ]) { const s = sample(); change(s); assert.equal(assess(s).outcome, "INCONCLUSIVE"); }
  const s = sample();
  const a = assess(s, r => delete r.generalization);
  assert.equal(a.outcome, "INCONCLUSIVE"); assert.deepEqual(codes(a), ["MISSING_EVALUATION"]);
});

test("required slices and source diversity cannot be hidden by a pooled score", () => {
  const s = sample(); s.spec.generalization!.suites[1].minimumSources = 2;
  s.evidence.suites[1].groups[0].slices = [];
  const a = assess(s);
  assert.equal(a.outcome, "INCONCLUSIVE");
  assert.ok(codes(a).includes("INSUFFICIENT_SOURCES"));
  assert.ok(codes(a).includes("INSUFFICIENT_SLICE_GROUPS"));
  const weak = sample(); weak.spec.generalization!.suites[1].slices.push({ id: "rare", minimumGroups: 5 });
  weak.evidence.suites[1].groups.forEach((g: any, i: number) => {
    if (i < 5) { g.slices.push("rare"); g.verdict = "FAIL"; }
  });
  assert.equal(assess(weak).outcome, "REFUTED");
  assert.ok(assess(weak).generalization!.diagnostics.some(d => d.code === "PERFORMANCE_BELOW_TARGET" && d.slice === "rare"));
});

test("duplicate families, cross-suite leakage, stale identities and malformed counts are rejected", () => {
  for (const change of [
    (s: any) => s.evidence.suites[1].groups[1].id = s.evidence.suites[1].groups[0].id,
    (s: any) => s.evidence.suites[1].groups[0].id = s.evidence.suites[0].groups[0].id,
    (s: any) => s.evidence.candidateHash = digest("wrong-candidate"),
    (s: any) => s.evidence.exposureHash = digest("wrong-exposure"),
    (s: any) => s.evidence.scoringHash = digest("wrong-scorer"),
    (s: any) => s.evidence.suites[1].manifestHash = digest("wrong-data"),
    (s: any) => s.evidence.suites[1].disjointFromExposure = "FAIL",
    (s: any) => s.evidence.suites[1].groups[0].verdict = "SUCCESS",
    (s: any) => s.evidence.suites[1].groups[0].slices = ["undeclared"],
    (s: any) => s.evidence.suites[1].groups[0].independentCount = 1000,
    (s: any) => s.evidence.suites.push(s.evidence.suites[1]),
  ]) { const s = sample(); change(s); assert.throws(() => assess(s)); }
});

test("only the designated validator may supply evaluation and semantic conflicts remain explicit", () => {
  const s = sample(); s.spec.validation.push({ id: "crosscheck", checks: ["independent-method"] });
  assert.equal(assess(s).outcome, "SUPPORTED");
  assert.throws(() => assess(s, r => { if (r.validator === "crosscheck") r.generalization = s.evidence; }), /undeclared generalization/);
  const a = assess(s, r => { if (r.validator === "crosscheck") r.outcome = "REFUTED"; });
  assert.equal(a.conflicted, true); assert.equal(a.outcome, "INCONCLUSIVE");
  assert.equal(a.generalization!.outcome, "SUPPORTED");
});

test("invalid or vacuous frozen evaluation contracts fail at admission", () => {
  for (const change of [
    (s: any) => s.spec.generalization.validator = "unconfigured",
    (s: any) => s.spec.generalization.maxDevelopmentGap = NaN,
    (s: any) => s.spec.generalization.suites[1].minimumGroups = 0,
    (s: any) => s.spec.generalization.suites[1].minimumSources = 0,
    (s: any) => s.spec.generalization.suites[1].minimumSuccessRate = 1.1,
    (s: any) => s.spec.generalization.suites[1].slices = [],
    (s: any) => s.spec.generalization.suites[1].role = "development",
    (s: any) => s.spec.generalization.suites[1].manifestHash = s.spec.generalization.suites[0].manifestHash,
  ]) { const s = sample(); change(s); assert.throws(() => validateResearchSpec(s.spec)); }
});

test("long coverage identities preserve severe diagnostics and next actions in bounded feedback", () => {
  const s = sample();
  s.spec.generalization!.suites.forEach((r, i) => {
    r.id = `${i}${"x".repeat(127)}`; s.evidence.suites[i].id = r.id;
    r.slices = Array.from({ length: 16 }, (_, j) => ({ id: `${j}`.padEnd(128, "y"), minimumGroups: 30 }));
    s.evidence.suites[i].groups.forEach((g: any) => { g.slices = []; if (i === 1) g.verdict = "FAIL"; });
  });
  const a = assess(s), feedback = generalizationFeedback(a.generalization!);
  assert.ok(Buffer.byteLength(JSON.stringify(feedback)) <= 3072);
  assert.ok(feedback.diagnosticsOmitted > 0);
  assert.equal(feedback.diagnostics[0].code, "PERFORMANCE_BELOW_TARGET");
  assert.equal(feedback.nextExperiments.length, 3);
  assert.ok(a.generalization!.diagnostics.length > feedback.diagnostics.length);
});

test("unconfigured projects retain their outcome and cannot inject evaluation evidence", () => {
  const s = sample(); delete s.spec.generalization;
  const a = assess(s, r => delete r.generalization);
  assert.equal(a.outcome, "SUPPORTED"); assert.equal(a.generalization, undefined);
  assert.throws(() => assess(s), /undeclared generalization/);
});

function configure(s: any, acceptance = "supported-hypothesis", weak = true) {
  const example = sample(); example.spec.acceptance = acceptance as ExperimentSpec["acceptance"];
  if (weak) example.evidence.suites[1].groups.forEach((g: any) => g.verdict = "FAIL");
  const root = dirname(s.project), evidenceFile = join(root, "evaluation.json"), specFile = join(root, "experiment.json");
  writeFileSync(evidenceFile, JSON.stringify(example.evidence)); writeFileSync(specFile, JSON.stringify(example.spec));
  const executor = join(root, "job-fixture.mjs"), module = resolve("adapters/research/table-fixture.mjs");
  writeFileSync(executor, `import {readFileSync} from 'node:fs';\nimport {fixtureResult} from ${JSON.stringify(module)};\n` +
    `const r=JSON.parse(readFileSync(0,'utf8')),s=JSON.parse(readFileSync(process.argv[2],'utf8'));\n` +
    `console.log(JSON.stringify({schema:1,key:r.key,jobId:r.key,status:'SUCCEEDED',result:{exitCode:0,\n` +
    `data:fixtureResult(s,{key:r.key,jobId:r.key}),artifacts:{'raw-data':{bytes:100,sha256:'${digest("fixture")}'}}}}));\n`);
  s.jobs = { trial: { adapter: { argv: [process.execPath, "--experimental-strip-types", executor, specFile], files: [module, specFile] },
    research: { spec: example.spec, validators: { analysis: { readOnly: true, timeoutMs: 2000, maxOutputBytes: 65536,
      command: { argv: [process.execPath, "--experimental-strip-types", resolve("tests/foundry/fixtures/generalization-validator.mjs"), evidenceFile],
        files: [resolve("src/harness/foundry/kernel.ts"), evidenceFile] } } } },
    idempotentEnsure: true, pollMs: 10, staleMs: 10000, maxJobs: 4, maxConcurrent: 1 } };
  s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = ["trial"];
}

for (const acceptance of ["valid-result", "supported-hypothesis"]) test(`negative external evidence survives restart under ${acceptance}`, async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([{ ...task(), research: ["trial"] }]), c = q.capsule(q.claim(run, "test")!);
  const spec = cfg.spec.jobs!.trial.research!.spec as ExperimentSpec; let calls = 0;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_cmd, _cfg, request: any) => {
    calls++;
    return { schema: 1, key: request.key, jobId: request.key, status: "SUCCEEDED", result: { exitCode: 0,
      data: fixtureResult(spec, { key: request.key, jobId: request.key }),
      artifacts: { "raw-data": { bytes: 100, sha256: digest("fixture") } } } };
  });
  await jobs.execute(c, cfg.spec.agents.coder, { id: "trial", name: "run_job", arguments: { name: "trial", input: spec.input } }, signal());
  const first = await verifyResearch(s, cfg, c, signal());
  assert.equal(first.verdict, acceptance === "valid-result" ? "PASS" : "FAIL", first.detail);
  const row = s.db.prepare("SELECT assessment_hash FROM research_assessments").get()!;
  const assessment: any = s.readArtifact(String(row.assessment_hash));
  assert.equal(assessment.outcome, "REFUTED"); assert.equal(assessment.generalization.suites[1].passed, 0);
  const journal = new SessionJournal(s);
  assert.match(JSON.stringify(journal.recall(c, String(row.assessment_hash))), /PERFORMANCE_BELOW_TARGET/);
  assert.throws(() => journal.recall({ ...c, task: { ...c.task, id: "another-task" } }, String(row.assessment_hash)), /not owned/);
  if (acceptance === "supported-hypothesis") {
    assert.match(first.detail!, /PERFORMANCE_BELOW_TARGET/); assert.match(first.detail!, /budget-matched/);
    assert.ok(first.detail!.includes(String(row.assessment_hash)));
  }
  const reopened = await Store.open(s.root);
  try {
    assert.deepEqual(await verifyResearch(reopened, cfg, c, signal()), first);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='research.assessed'").get()!.n, 1);
  } finally { reopened.close(); }
  assert.equal(calls, 1, "verification and restart must not submit a replacement experiment");
}, s => configure(s, acceptance)));

test("independent evaluation diagnostics reach the next worker repair turn", async () => fixture(async (s, cfg) => {
  let sawRepair = false;
  const mock = scripted([
    body => {
      assert.match(JSON.stringify(body.messages), /family-level separation/);
      return reply("", [{ name: "run_job", arguments: { name: "trial", input: cfg.spec.jobs!.trial.research!.spec.input } }]);
    },
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("ready"),
    body => {
      const text = JSON.stringify(body.messages);
      assert.match(text, /repairRequired/); assert.match(text, /PERFORMANCE_BELOW_TARGET/);
      assert.match(text, /coverage|workload/); sawRepair = true;
      return reply("The broader capability is still unsupported; preserve the measured failure.");
    },
  ]);
  const result: any = await runSwarm(s, [{ ...task(), research: ["trial"] }], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "FAIL"); assert.ok(sawRepair);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_jobs").get()!.n, 1);
}, s => { configure(s); s.recipe.attempts = 2; }));

test("a sufficiently covered independent result completes verification and integration", async () => fixture(async (s, cfg) => {
  const mock = scripted([
    () => reply("", [{ name: "run_job", arguments: { name: "trial", input: cfg.spec.jobs!.trial.research!.spec.input } }]),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("Ready for independent checking"),
  ]);
  const result: any = await runSwarm(s, [{ ...task(), research: ["trial"] }], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS");
  const row = s.db.prepare("SELECT assessment_hash FROM research_assessments").get()!;
  assert.equal((s.readArtifact(String(row.assessment_hash)) as any).generalization.outcome, "SUPPORTED");
  const integration = await integrateSwarm(s, result.id, signal());
  assert.equal(integration.branch, `refs/heads/swarm/${result.id}`);
  assert.equal(mock.bodies.length, 3);
}, s => {
  configure(s, "supported-hypothesis", false);
  s.researchProgramme = { id: "evaluation-findings", maxFindingsPerTask: 4, maxContextBytes: 30000 };
}));
