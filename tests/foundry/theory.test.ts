import test from "node:test";
import assert from "node:assert/strict";
import { canonical, digest } from "../../src/harness/foundry/kernel.ts";
import { assessResearch, validateExperimentResult, validateResearchSpec, type ExperimentSpec } from "../../src/harness/foundry/research.ts";
import { selectResearchFrontier } from "../../src/harness/foundry/researchFrontier.ts";
import { runResearchValidation } from "../../src/harness/foundry/researchValidation.ts";
import { compareResearchStrategies } from "../../src/harness/foundry/researchEvaluation.ts";
import { theoryGraph, theoryTargetHash, validateTheoryTemplates, type TheoryGraph } from "../../src/harness/foundry/theory.ts";
import { pinCommand } from "../../src/harness/foundry/commands.ts";
import type { ResearchStrategy, StrategyObservation } from "../../src/harness/foundry/researchStrategy.ts";
import { theoreticalResearchExample, runTheoryDemo } from "../../scripts/theory-research-demo.mjs";
import { constructProof, proofResult } from "../../examples/theoretical-research/proof-executor.mjs";

function sample() {
  const p = theoreticalResearchExample(2), spec = p.specs.lemma0 as ExperimentSpec, key = digest("theory-test");
  const packet = proofResult(spec, { key, jobId: key });
  const context = { key, jobId: key, adapterHash: digest("executor"), artifacts: packet.artifacts };
  const implementationHash = digest("independent-oracle");
  const report = { schema: 1, validator: "kernel", implementationHash, specHash: digest(spec), resultHash: digest(packet.result),
    contextHash: digest(context), checks: spec.validation[0].checks.map(id => ({ id, verdict: "PASS" })), outcome: "SUPPORTED",
    theory: { targetHash: theoryTargetHash(spec), kind: "deduction", artifact: "proof", artifactHash: context.artifacts.proof.sha256, openObligations: [] } };
  return { p, spec, packet, context, implementationHash, report };
}

test("theory contracts distinguish deductions, counterexamples, bounded checks and unresolved arguments", () => {
  const s = sample(); validateResearchSpec(s.spec);
  const assess = (report = s.report) => assessResearch(s.spec, s.packet.result, s.context, [{ id: "kernel", implementationHash: s.implementationHash, report }]);
  assert.equal(assess().theory!.status, "ESTABLISHED");
  for (const kind of ["bounded-check", "heuristic"]) {
    const r: any = structuredClone(s.report); r.theory.kind = kind; r.outcome = "INCONCLUSIVE"; r.theory.openObligations = ["universal quantifier remains open"];
    assert.equal(assess(r).theory!.status, "OPEN");
    r.outcome = "SUPPORTED"; r.theory.openObligations = [];
    assert.throws(() => assess(r), /checked deduction/);
  }
  const negative: any = structuredClone(s.report); negative.theory.kind = "counterexample"; negative.outcome = "REFUTED";
  assert.equal(assess(negative).theory!.status, "REFUTED");
  for (const mutate of [
    (r: any) => r.theory.targetHash = digest("nearby easier theorem"),
    (r: any) => r.theory.artifactHash = digest("unsubmitted certificate"),
    (r: any) => r.theory.artifact = "nonexistent",
    (r: any) => r.theory.openObligations = ["missing lemma"],
    (r: any) => r.theory.kind = "reviewer-consensus",
    (r: any) => r.outcome = "REFUTED",
    (r: any) => delete r.theory,
    (r: any) => r.theory.accepted = true,
  ]) { const r = structuredClone(s.report); mutate(r); assert.throws(() => assess(r)); }
  const without = structuredClone(s.spec); delete without.theory;
  assert.throws(() => assessResearch(without, { ...s.packet.result, specHash: digest(without) }, s.context,
    [{ id: "kernel", implementationHash: s.implementationHash, report: { ...s.report, specHash: digest(without), resultHash: digest({ ...s.packet.result, specHash: digest(without) }) } }]), /frozen theory contract/);
});

test("contradictory checked theory oracles remain conflicted regardless of agreeing reviewer count", () => {
  const s = sample(); s.spec.validation = ["kernel", "countermodel", "another-kernel"].map(id => ({ id, checks: ["soundness"] }));
  s.packet.result.specHash = digest(s.spec);
  const reports = s.spec.validation.map(({ id }) => ({ id, implementationHash: s.implementationHash, report: { ...s.report,
    validator: id, specHash: digest(s.spec), resultHash: digest(s.packet.result), checks: [{ id: "soundness", verdict: "PASS" }],
    outcome: id === "countermodel" ? "REFUTED" : "SUPPORTED", theory: { ...s.report.theory, kind: id === "countermodel" ? "counterexample" : "deduction" } } }));
  const assessment = assessResearch(s.spec, s.packet.result, s.context, reports);
  assert.equal(assessment.outcome, "INCONCLUSIVE"); assert.equal(assessment.theory!.status, "CONFLICTED");
});

test("frozen proof dependencies reject unknown protocols, changed statements, widened assumptions and combined cycles", () => {
  const p = theoreticalResearchExample(2); validateTheoryTemplates(p.specs); theoryGraph(p.strategy, p.specs);
  for (const change of [
    (x: any) => x.theorem.theory.premises[0].template = "unknown",
    (x: any) => x.lemma0.theory.statement = canonical("OtherTheorem"),
    (x: any) => { x.lemma0.assumptions.push(canonical("ExtraAxiom")); x.theorem.theory.premises[0].specHash = digest(x.lemma0); },
  ]) { const specs = structuredClone(p.specs); change(specs); assert.throws(() => validateTheoryTemplates(specs)); }
  const strategy = structuredClone(p.strategy); strategy.candidates[0].after = [{ candidate: "theorem", outcomes: ["SUPPORTED"] }];
  assert.throws(() => theoryGraph(strategy, p.specs), /cyclic combined/);
  const spec = structuredClone(p.specs.lemma0); spec.theory.statement = ""; assert.throws(() => validateResearchSpec(spec));
  const core = structuredClone(p.specs.theorem), key = digest("context-test"), packet = proofResult(core, { key, jobId: key });
  assert.throws(() => validateExperimentResult(core, packet.result, { key, jobId: key, adapterHash: digest("executor"), artifacts: packet.artifacts }), /incomplete checked/);
});

function frontier() {
  const names = ["unrelated", "shared", "left", "right", "goal"];
  const strategy: ResearchStrategy = { schema: 1, maxExperiments: 8, maxSnapshotBytes: 8192, stopOnRefutation: true,
    frontier: { maxParallel: 2, explorationWeight: 1, maxInconclusivePerLine: 2 },
    candidates: names.map(id => ({ id, template: id, line: id, purpose: "exploration" })) };
  const graph: TheoryGraph = Object.fromEntries(names.map(id => [id, { specHash: digest(id), targetHash: digest({ target: id }),
    premises: id === "left" || id === "right" ? ["shared"] : id === "goal" ? ["left", "right"] : [] }]));
  // These are host-accepted evidence fixtures, never model verdicts.
  const observed = (id: string, outcome: any = "SUPPORTED"): StrategyObservation => ({ key: `${id}-${outcome}`, candidate: id,
    assessment: { schema: 1, specHash: graph[id].specHash, resultHash: digest({ id, outcome }), outcome, estimates: [], assumptions: [],
      theory: { targetHash: graph[id].targetHash, status: outcome === "SUPPORTED" ? "ESTABLISHED" : outcome === "REFUTED" ? "REFUTED" : "OPEN", certificates: [] } } });
  return { strategy, graph, observed };
}

test("shared lemma bottlenecks outrank unrelated exploration; diamond dependents are counted once", () => {
  const { strategy, graph, observed } = frontier();
  let f = selectResearchFrontier(strategy, [], 0, { theory: graph });
  assert.deepEqual(f.batch, ["shared", "unrelated"]); assert.equal(f.unlocks.shared, 3); assert.equal(f.proofStates.goal, "WAITING");
  const reservedGoal = selectResearchFrontier(strategy, [], 1, { theory: graph, pending: ["goal"] });
  assert.deepEqual(reservedGoal.batch, ["shared", "unrelated"]); assert.equal(reservedGoal.activeAssignments, 0);
  assert.equal(reservedGoal.unlocks.shared, 3);
  f = selectResearchFrontier(strategy, [observed("shared")], 1, { theory: graph, pending: ["unrelated"] });
  assert.deepEqual(f.batch, ["left"]); assert.equal(f.proofStates.shared, "ESTABLISHED");
  f = selectResearchFrontier(strategy, [observed("shared"), observed("left"), observed("right")], 3, { theory: graph });
  assert.ok(f.batch.includes("goal"));
  const open = selectResearchFrontier(strategy, [observed("shared", "INCONCLUSIVE")], 1, { theory: graph });
  assert.equal(open.proofStates.shared, "OPEN"); assert.equal(open.states.left, "WAITING"); assert.equal(open.states.goal, "WAITING");
  const refuted = selectResearchFrontier(strategy, [observed("shared", "REFUTED"), observed("left")], 2, { theory: graph });
  assert.equal(refuted.states.left, "INVALIDATED"); assert.equal(refuted.states.goal, "INVALIDATED"); assert.ok(refuted.batch.includes("unrelated"));
  const forged = observed("shared"); forged.assessment.theory!.status = "OPEN";
  assert.throws(() => selectResearchFrontier(strategy, [forged], 1, { theory: graph }), /exact deductive/);
  strategy.candidates[0].purpose = "falsification";
  assert.equal(selectResearchFrontier(strategy, [], 0, { theory: graph }).batch[0], "unrelated");
});

test("the independent proof kernel rejects fabricated axioms, invalid inference, and a neighboring target", async () => {
  const s = sample(), validators = { kernel: { ...s.p.validator, command: pinCommand(s.p.validator.command, process.cwd()) } };
  const options = { legacyTimeoutMs: 5000, maxOutputBytes: 32768 }, signal = AbortSignal.timeout(20000);
  const good = await runResearchValidation(s.spec, s.packet.result, s.context, validators, signal, options);
  assert.equal(good.assessment.theory!.status, "ESTABLISHED");
  const cached = good.assessment.validation!.map(v => ({ ...v, report: good.evidence.find(r => digest(r) === v.reportHash) }));
  assert.deepEqual(await runResearchValidation(s.spec, s.packet.result, s.context, validators, signal, { ...options, cached }), good);
  for (const mutate of [
    (c: any) => c.steps[0].index = 999,
    (c: any) => c.steps.at(-1).antecedent = 1,
    (c: any) => c.conclusion = 0,
    (c: any) => c.steps[0] = { rule: "premise", template: "invented-lemma" },
  ]) {
    const certificate = constructProof(s.spec); mutate(certificate);
    const raw = proofResult(s.spec, { key: s.context.key, jobId: s.context.jobId }, certificate);
    await assert.rejects(runResearchValidation(s.spec, raw.result, { ...s.context, artifacts: raw.artifacts }, validators, signal, options));
  }
  const spec = structuredClone(s.spec); spec.assumptions.push(canonical("ExtraAxiom"));
  const raw = proofResult(spec, { key: s.context.key, jobId: s.context.jobId });
  await assert.rejects(runResearchValidation(spec, raw.result, { ...s.context, artifacts: raw.artifacts }, validators, signal, { ...options, cached }), /binding mismatch/);
});

test("a 256-obligation theory frontier releases a 32-slot wave after one shared lemma", () => {
  const strategy: ResearchStrategy = { schema: 1, maxExperiments: 256, maxSnapshotBytes: 65536, stopOnRefutation: true,
    frontier: { maxParallel: 32, explorationWeight: 1, maxInconclusivePerLine: 3 },
    candidates: Array.from({ length: 256 }, (_, n) => ({ id: `lemma${n}`, template: `lemma${n}`, line: `line${n}`, purpose: "exploration" })) };
  const graph: TheoryGraph = Object.fromEntries(strategy.candidates.map((c, n) => [c.id, {
    specHash: digest(c.id), targetHash: digest({ statement: c.id }), premises: n ? ["lemma0"] : [],
  }]));
  const first = selectResearchFrontier(strategy, [], 0, { theory: graph });
  assert.deepEqual(first.batch, ["lemma0"]); assert.equal(first.unlocks.lemma0, 255);
  const accepted: StrategyObservation = { key: "checked-lemma", candidate: "lemma0", assessment: { schema: 1,
    specHash: graph.lemma0.specHash, resultHash: digest("proof"), outcome: "SUPPORTED", estimates: [], assumptions: [],
    theory: { targetHash: graph.lemma0.targetHash, status: "ESTABLISHED", certificates: [] } } };
  assert.equal(selectResearchFrontier(strategy, [accepted], 1, { theory: graph }).batch.length, 32);
});

test("offline parallel proof pipeline establishes eight independent lemmas and composes only afterwards", async () => {
  const report = await runTheoryDemo(8);
  assert.deepEqual(report.batches.map(b => b.length), [8, 1]);
  assert.equal(report.established, 9); assert.equal(report.theorem!.status, "ESTABLISHED");
  assert.equal(report.tokens, null); assert.equal(report.costUsd, null);
});

test("matched comparison arms retain the same exact proof prerequisites and checked targets", async () => {
  const p = theoreticalResearchExample(2);
  const protocol = { schema: 1 as const, name: "matched-theory", executor: p.executor, validators: { kernel: p.validator },
    maxArmMs: 20000, maxOutputBytes: 65536, cases: [{ id: "composition", strategy: p.strategy, experiments: p.specs }] };
  const result = await compareResearchStrategies(protocol, pinCommand(p.executor, process.cwd()), AbortSignal.timeout(30000));
  assert.equal(result.allEvidenceValid, true);
  for (const arm of Object.values(result.cases[0].arms) as any[]) {
    assert.equal(arm.jobs, 3); assert.equal(arm.records.at(-1).assessment.theory.status, "ESTABLISHED");
  }
});
