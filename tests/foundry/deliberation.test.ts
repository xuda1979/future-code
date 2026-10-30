import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { researchDeliberation, researchDossier, type DeliberationSample } from "../../src/harness/foundry/deliberation.ts";
import { validateResearchStrategy, type ResearchStrategy, type StrategyObservation } from "../../src/harness/foundry/researchStrategy.ts";

const strategy = (): ResearchStrategy => ({ schema: 1, maxExperiments: 12, maxSnapshotBytes: 8192, stopOnRefutation: true,
  candidates: Array.from({ length: 4 }, (_, n) => ({ id: `c${n}`, template: `t${n}`, line: `line${n}`, purpose: "falsification" })),
  frontier: { maxParallel: 4, explorationWeight: 1, maxInconclusivePerLine: 8 },
  deliberation: { familiarObservations: 2, stagnationWindow: 2, maxUninformative: 4,
    maxResearchMs: 1000, highImpact: false, reuseProgrammeFindings: true } });
const observation = (id: string, outcome: "SUPPORTED" | "REFUTED" | "INCONCLUSIVE" = "SUPPORTED"): StrategyObservation => ({
  candidate: id, key: digest(id), assessment: { schema: 1, specHash: digest(id), resultHash: digest({ id, outcome }),
    outcome, estimates: [], assumptions: [] } });
const samples = (count: number, outcome: "SUPPORTED" | "INCONCLUSIVE" = "INCONCLUSIVE"): DeliberationSample[] =>
  Array.from({ length: count }, (_, n) => ({ key: `job${n}`, observation: observation(`c${n}`, outcome), completedAt: n, elapsedMs: 100 }));

test("gears allocate bounded width using checked familiarity, branching and operator impact", () => {
  const s = strategy(), familiar = [observation("c0"), observation("c1")];
  assert.equal(researchDeliberation(s, [], [], 3).gear, 3);
  assert.equal(researchDeliberation(s, [], [], 2).maxParallel, 2);
  assert.equal(researchDeliberation(s, familiar, [], 1).maxParallel, 1);
  s.deliberation!.highImpact = true;
  assert.equal(researchDeliberation(s, familiar, [], 1).reason, "OPERATOR_HIGH_IMPACT");
  s.frontier!.maxParallel = 2;
  assert.equal(researchDeliberation(s, [], [], 4).maxParallel, 2);
});

test("stagnation first escalates, then stops only new research without claiming success", () => {
  const s = strategy(), trace = samples(4);
  const escalated = researchDeliberation(s, trace.map(x => x.observation), trace.slice(0, 2), 1);
  assert.equal(escalated.gear, 3); assert.equal(escalated.stop, null);
  const stopped = researchDeliberation(s, trace.map(x => x.observation), trace, 1);
  assert.equal(stopped.stop, "MARGINAL_EVIDENCE_EXHAUSTED");
  assert.equal(stopped.trust, "ALLOCATION_HEURISTIC_NOT_ACCEPTANCE");
  const novel = { key: "new", observation: observation("new", "REFUTED"), elapsedMs: 50, completedAt: 5 };
  assert.equal(researchDeliberation(s, [novel.observation], [...trace, novel], 1).stop, null);
});

test("receipt replay cannot manufacture novelty or consume the time budget twice", () => {
  const s = strategy(), one = samples(1, "SUPPORTED")[0];
  const single = researchDeliberation(s, [one.observation], [one], 1);
  assert.deepEqual(researchDeliberation(s, [one.observation, one.observation], [one, one], 1), single);
  const repeated = { ...one, key: "different-job", completedAt: 1,
    observation: { ...one.observation, key: "different-receipt", assessment: { ...one.observation.assessment, resultHash: digest("different-raw-result") } } };
  const result = researchDeliberation(s, [one.observation, repeated.observation], [one, repeated], 1);
  assert.equal(result.informativeProtocols, 1); assert.equal(result.trailingUninformative, 1);
  assert.throws(() => researchDeliberation(s, [], [one, { ...one, elapsedMs: 1 }], 1), /replay drift/);
});

test("known cost exhaustion stops admission and unknown duration stays explicitly unknown", () => {
  const s = strategy(), trace = [{ ...samples(1)[0], elapsedMs: 1000 }];
  assert.equal(researchDeliberation(s, [], trace, 1).stop, "RESEARCH_TIME_BUDGET_EXHAUSTED");
  trace[0].elapsedMs = null;
  const result = researchDeliberation(s, [], trace, 1);
  assert.equal(result.unknownDurations, 1); assert.equal(result.measuredMs, 0); assert.equal(result.stop, null);
  assert.throws(() => researchDeliberation(s, [], [{ ...trace[0], elapsedMs: NaN }], 1), /timing/);
  const failed = researchDeliberation(s, [], [{ ...trace[0], observation: null, elapsedMs: 1000 }], 1);
  assert.equal(failed.stop, "RESEARCH_TIME_BUDGET_EXHAUSTED"); assert.equal(failed.informativeProtocols, 0);
});

test("compact dossiers retain refutations and contradictions with exact receipt references", () => {
  const positive = Array.from({ length: 12 }, (_, n) => observation(`positive${n}`));
  const negative = observation("counterexample", "REFUTED"), conflict = observation("contradiction"); conflict.assessment.conflicted = true;
  const dossier = researchDossier([...positive, negative, conflict, negative]);
  assert.equal(dossier.total, 14); assert.equal(dossier.omitted, 6); assert.equal(dossier.records.length, 8);
  assert.ok(dossier.records.some(r => r.sourceKey === negative.key && r.receipt === digest(negative.assessment)));
  assert.ok(dossier.records.some(r => r.conflicted));
  assert.equal(dossier.evidenceHash, researchDossier([conflict, negative, ...positive]).evidenceHash);
  assert.equal(Buffer.byteLength(JSON.stringify(dossier)) < 4096, true);
});

test("policy rejects unbounded research, unknown flags and stopping before an escalation opportunity", () => {
  validateResearchStrategy(strategy());
  for (const patch of [{ maxResearchMs: Infinity }, { familiarObservations: 0 }, { highImpact: "yes" },
    { maxUninformative: 2 }, { stagnationWindow: 0 }, { reward: 1 }]) {
    const s = strategy(); Object.assign(s.deliberation!, patch); assert.throws(() => validateResearchStrategy(s));
  }
  const s = strategy(); delete s.frontier; assert.throws(() => validateResearchStrategy(s), /frontier/);
});
