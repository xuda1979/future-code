import test from "node:test";
import assert from "node:assert/strict";
import { canonical, digest, sha256 } from "../../src/harness/foundry/kernel.ts";
import { selectResearchFrontier } from "../../src/harness/foundry/researchFrontier.ts";
import { validateResearchStrategy, type ResearchStrategy, type StrategyObservation } from "../../src/harness/foundry/researchStrategy.ts";
import { compareResearchStrategies } from "../../src/harness/foundry/researchEvaluation.ts";
import { pinCommand } from "../../src/harness/foundry/commands.ts";
import { mathematicalFrontierProtocol } from "../../scripts/research-frontier-demo.mjs";
import { runResearchValidation } from "../../src/harness/foundry/researchValidation.ts";

const strategy = (): ResearchStrategy => ({ schema: 1, maxExperiments: 12, maxSnapshotBytes: 8192, stopOnRefutation: true,
  frontier: { maxParallel: 3, explorationWeight: 1, maxInconclusivePerLine: 2 },
  candidates: [
    { id: "screen", template: "screen", line: "first", purpose: "falsification" },
    { id: "proof", template: "proof", line: "first", purpose: "replication", after: [{ candidate: "screen", outcomes: ["SUPPORTED"] }] },
    { id: "alternative", template: "alternative", line: "second", purpose: "exploration" },
    { id: "third", template: "third", line: "third", purpose: "exploration" },
  ] });
function observed(candidate: string, outcome: "SUPPORTED" | "REFUTED" | "INCONCLUSIVE", key = candidate): StrategyObservation {
  return { candidate, key, assessment: { schema: 1, specHash: digest(candidate), resultHash: digest({ candidate, outcome }),
    outcome, estimates: [], assumptions: [] } };
}

test("frontier fills a diverse parallel batch without spending on a dependent proof before its screen", () => {
  const s = strategy();
  assert.deepEqual(selectResearchFrontier(s, [], 0).batch, ["screen", "alternative", "third"]);
  const pending = selectResearchFrontier(s, [], 1, { pending: ["screen"] });
  assert.deepEqual(pending.batch, ["alternative", "third"]);
  assert.equal(pending.states.proof, "WAITING"); assert.equal(pending.states.screen, "ASSIGNED");
  assert.deepEqual(selectResearchFrontier(s, [], 11).batch, ["screen"]);
  assert.equal(selectResearchFrontier(s, [], 12).reason, "EXPERIMENT_BUDGET_EXHAUSTED");
});

test("refuted and conflicted premises invalidate transitive strategy descendants; refutation-conditioned alternatives survive", () => {
  const s = strategy();
  s.candidates.push({ id: "synthesis", template: "synthesis", line: "synthesis", purpose: "exploration",
    after: [{ candidate: "proof", outcomes: ["SUPPORTED"] }] },
  { id: "counterexample-followup", template: "followup", line: "counterexample", purpose: "replication",
    after: [{ candidate: "screen", outcomes: ["REFUTED"] }] });
  const prior = [observed("proof", "SUPPORTED"), observed("screen", "REFUTED")];
  const result = selectResearchFrontier(s, prior, 2);
  assert.equal(result.states.proof, "INVALIDATED"); assert.equal(result.states.synthesis, "INVALIDATED");
  assert.ok(result.batch.includes("counterexample-followup"));
  s.stopOnRefutation = false;
  const conflict = selectResearchFrontier(s, [...prior, observed("screen", "SUPPORTED", "other")], 3);
  assert.equal(conflict.states["counterexample-followup"], "INVALIDATED");
  assert.equal(conflict.states.synthesis, "INVALIDATED");
});

test("exact evidence deduplication prevents replayed results from inflating bandit rewards", () => {
  const s = strategy();
  const one = observed("screen", "SUPPORTED");
  const first = selectResearchFrontier(s, [one], 1);
  const replay = selectResearchFrontier(s, [one, { ...one, key: "another-source" }, one], 1);
  assert.deepEqual(first.lines, replay.lines); assert.deepEqual(first.batch, replay.batch);
  assert.equal(first.lines.first.informative, 1);
  assert.throws(() => selectResearchFrontier(s, [one, observed("screen", "REFUTED")], 1), /replay drift/);
});

test("inconclusive runs cause a bounded strategy change and cheap falsification remains first", () => {
  const s = strategy(); s.candidates[1].after = undefined; s.candidates[1].purpose = "exploration";
  s.candidates.push({ id: "more", template: "more", line: "first", purpose: "exploration" });
  const result = selectResearchFrontier(s, [observed("screen", "INCONCLUSIVE"), observed("proof", "INCONCLUSIVE")], 2);
  assert.equal(result.states.more, "STALLED"); assert.ok(!result.batch.includes("more"));
  assert.ok(result.batch.includes("alternative"));
  const fresh = strategy(); fresh.candidates[2].purpose = "falsification";
  assert.equal(selectResearchFrontier(fresh, [], 0, { costs: { screen: 100, alternative: 1 } }).batch[0], "alternative");
});

test("frontier validates all bounds and supports hundreds of candidates without model-authored reward fields", () => {
  const s = strategy(); s.maxExperiments = 256;
  s.candidates = Array.from({ length: 256 }, (_, n) => ({ id: `c${n}`, template: `t${n}`, line: `line${n % 16}`, purpose: "exploration" }));
  validateResearchStrategy(s);
  assert.equal(new Set(selectResearchFrontier(s, [], 0).batch.map(id => s.candidates.find(c => c.id === id)!.line)).size, 3);
  for (const value of [0, 33, Infinity]) assert.throws(() => validateResearchStrategy({ ...s, frontier: { ...s.frontier!, maxParallel: value } }));
  assert.throws(() => validateResearchStrategy({ ...s, frontier: { ...s.frontier!, reward: 1 } } as any));
  assert.throws(() => selectResearchFrontier(s, [], 0, { pending: ["unknown"] }));
});

test("a multi-parent branch waits for missing evidence rather than treating it as refutation", () => {
  const s = strategy(); s.candidates[1].after!.push({ candidate: "alternative", outcomes: ["SUPPORTED"] });
  const result = selectResearchFrontier(s, [observed("screen", "SUPPORTED")], 1);
  assert.equal(result.states.proof, "WAITING");
  assert.ok(result.batch.includes("alternative"));
});

test("bandit allocation exploits informative lines and eventually explores unvisited alternatives", () => {
  const s = strategy(); s.frontier!.maxParallel = 1;
  s.candidates.forEach(c => { c.purpose = "exploration"; delete c.after; });
  assert.deepEqual(selectResearchFrontier(s, [observed("screen", "SUPPORTED")], 1).batch, ["proof"]);
  const evidence = [observed("screen", "SUPPORTED")];
  for (let i = 0; i < 7; i++) {
    const id = `visited${i}`; s.candidates.push({ id, template: id, line: "first", purpose: "exploration" });
    evidence.push(observed(id, "SUPPORTED"));
  }
  assert.deepEqual(selectResearchFrontier(s, evidence, 8).batch, ["alternative"]);
});

test("bounded mathematical search preserves counterexamples and never upgrades a finite search to a proof", async () => {
  const p = mathematicalFrontierProtocol();
  const report = await compareResearchStrategies(p, pinCommand(p.executor, process.cwd()), new AbortController().signal);
  assert.equal(report.allEvidenceValid, true); assert.equal(report.totalJobsSaved, 1);
  assert.equal(report.cases[0].arms.adaptive.jobs, 1); assert.equal(report.cases[0].arms["static-all"].jobs, 2);
  const negative = report.cases[0].arms.adaptive.records[0];
  assert.equal(negative.assessment.outcome, "REFUTED");
  assert.equal(report.cases[1].arms.adaptive.records[0].assessment.outcome, "INCONCLUSIVE");
  assert.equal(report.cases[1].arms.adaptive.records[1].assessment.outcome, "REFUTED");
  assert.ok(report.cases.every(c => c.sameRefutedLines));
});

test("the independent arithmetic oracle rejects forged factors and incomplete search coverage", async () => {
  const p = mathematicalFrontierProtocol(), spec = p.cases[0].experiments.screen, key = digest("oracle-adversary");
  const validators = { arithmetic: { ...p.validators.arithmetic, command: pinCommand(p.validators.arithmetic.command, process.cwd()) } };
  for (const data of [{ witness: { n: 40, value: 1681, divisor: 2 }, checked: 41 }, { witness: null, checked: 30 }]) {
    const observations = [{ unit: "search", replicate: "bounded", data }], raw = canonical(observations);
    const result = { schema: 2, specHash: digest(spec), identity: spec.identity,
      execution: { ...spec.execution, key, jobId: key }, observations };
    const context = { key, jobId: key, adapterHash: digest("executor"),
      artifacts: { evidence: { sha256: sha256(raw), bytes: Buffer.byteLength(raw) } } };
    await assert.rejects(runResearchValidation(spec, result, context, validators, new AbortController().signal,
      { legacyTimeoutMs: 2000, maxOutputBytes: 16384 }), /invalid exact counterexample|incomplete bounded search/);
  }
});
