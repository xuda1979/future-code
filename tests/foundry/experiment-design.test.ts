import test from "node:test";
import assert from "node:assert/strict";
import { experimentalDesign } from "../../src/harness/foundry/experimentDesign.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { selectResearchFrontier } from "../../src/harness/foundry/researchFrontier.ts";
import { validateResearchStrategy, type ResearchStrategy, type StrategyObservation } from "../../src/harness/foundry/researchStrategy.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { ResearchJobs } from "../../src/harness/foundry/swarm/jobs.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { researchStrategySnapshot } from "../../src/harness/foundry/swarm/researchStrategy.ts";
import { bellExperiment, simulateQuantum } from "../../scripts/quantum-experiment.mjs";
import { fixture, reply, scripted, signal, task } from "./swarm-fixtures.ts";

const row = (p: number) => ({ SUPPORTED: p, REFUTED: 1 - p, INCONCLUSIVE: 0 });
function strategy(): ResearchStrategy {
  return { schema: 1, maxExperiments: 8, maxSnapshotBytes: 16000, stopOnRefutation: false,
    frontier: { maxParallel: 1, explorationWeight: 1, maxInconclusivePerLine: 3 },
    candidates: ["uninformative", "noisy", "perfect"].map(id => ({ id, template: id, line: id, purpose: "exploration" })),
    design: { schema: 1, hypotheses: [{ id: "a", prior: 0.5 }, { id: "b", prior: 0.5 }], fallbackCostMs: 1000,
      likelihoods: { uninformative: { a: row(0.5), b: row(0.5) }, noisy: { a: row(0.9), b: row(0.1) },
        perfect: { a: row(1), b: row(0) } } } };
}
// Independently accepted observation fixtures. A model cannot supply these to
// the runtime snapshot; the integration test below exercises that boundary.
const observed = (candidate = "noisy", outcome: any = "SUPPORTED", key = "first"): StrategyObservation => ({
  candidate, key, assessment: { schema: 1, specHash: digest(candidate), resultHash: digest({ candidate, outcome, key }),
    outcome, estimates: [], assumptions: [] },
});
const near = (x: number | null, y: number) => assert.ok(x !== null && Math.abs(x - y) < 1e-12, `${x} != ${y}`);

test("finite design matches binary-channel information and updates the posterior only from distinct results", () => {
  const s = strategy(), first = experimentalDesign(s, []);
  assert.equal(first.status, "READY"); near(first.entropyBits, 1);
  near(first.candidates.uninformative.expectedInformationBits, 0);
  near(first.candidates.perfect.expectedInformationBits, 1);
  near(first.candidates.noisy.expectedInformationBits, 0.5310044064107188);
  const observation = observed(), updated = experimentalDesign(s, [observation]);
  near(updated.posterior!.a, 0.9); near(updated.posterior!.b, 0.1);
  near(updated.entropyBits, 0.4689955935892812);
  assert.deepEqual(updated, experimentalDesign(s, [observation, { ...observation, key: "imported-copy" }, observation]));
  const next = observed("uninformative", "SUPPORTED", "second");
  assert.deepEqual(experimentalDesign(s, [observation, next]), experimentalDesign(s, [next, observation]));
  assert.throws(() => experimentalDesign(s, [observation, observed("perfect")]), /replay drift/);
});

test("information per host-measured duration changes ranking and labels every fallback", () => {
  const s = strategy();
  assert.equal(selectResearchFrontier(s, [], 0).next, "perfect");
  const fast = selectResearchFrontier(s, [], 0, { costs: { noisy: 10, perfect: 1000 } });
  assert.equal(fast.next, "noisy");
  assert.equal(fast.design!.candidates.noisy.costBasis, "HOST_OBSERVED_JOB_MS");
  assert.equal(fast.design!.candidates.uninformative.costBasis, "CONFIGURED_FALLBACK_MS");
  assert.equal(fast.design!.candidates.uninformative.costMs, 1000);
  const invalidCosts = experimentalDesign(s, [], { noisy: NaN, perfect: -1, uninformative: Infinity });
  assert.ok(Object.values(invalidCosts.candidates).every(c => c.costBasis === "CONFIGURED_FALLBACK_MS"));
  assert.equal(experimentalDesign(s, [], { perfect: 0 }).candidates.perfect.costMs, 1);
});

test("a checked result changes the next measurement toward remaining uncertainty", () => {
  const s = strategy();
  s.design!.hypotheses = ["h00", "h01", "h10", "h11"].map(id => ({ id, prior: 0.25 }));
  s.design!.likelihoods = Object.fromEntries(s.candidates.map((c, n) => [c.id,
    Object.fromEntries(s.design!.hypotheses.map(h => [h.id, row(h.id[n === 2 ? 2 : 1] === "0" ? 1 : 0)]))]));
  assert.equal(selectResearchFrontier(s, [], 0).next, "uninformative");
  const next = selectResearchFrontier(s, [observed("uninformative")], 1);
  assert.equal(next.next, "perfect");
  near(next.design!.candidates.noisy.expectedInformationBits, 0);
  near(next.design!.candidates.perfect.expectedInformationBits, 1);
  assert.deepEqual(next.design!.posterior, { h00: 0.5, h01: 0.5, h10: 0, h11: 0 });
});

test("invalidated descendant evidence cannot update the design posterior", () => {
  const s = strategy(); s.candidates[1].after = [{ candidate: "uninformative", outcomes: ["SUPPORTED"] }];
  const result = selectResearchFrontier(s, [observed("uninformative", "REFUTED"), observed("noisy", "SUPPORTED", "descendant")], 2);
  assert.equal(result.states.noisy, "INVALIDATED"); assert.equal(result.design!.excludedObservations, 1);
  assert.equal(result.design!.observations, 1); near(result.design!.posterior!.a, 0.5);
});

test("design cannot bypass falsification, prerequisites, reservations, conflicts or experiment budgets", () => {
  const s = strategy(); s.candidates[0].purpose = "falsification";
  assert.equal(selectResearchFrontier(s, [], 0).next, "uninformative");
  s.candidates[0].purpose = "exploration";
  s.candidates[2].after = [{ candidate: "noisy", outcomes: ["SUPPORTED"] }];
  assert.equal(selectResearchFrontier(s, [], 0).next, "noisy");
  assert.deepEqual(selectResearchFrontier(s, [], 7, { pending: ["noisy"] }).batch, []);
  assert.equal(selectResearchFrontier(s, [], 8).reason, "EXPERIMENT_BUDGET_EXHAUSTED");
  const evidence = [observed(), observed("noisy", "REFUTED", "contradiction")];
  assert.equal(selectResearchFrontier(s, evidence, 2).reason, "EXPERIMENT_DESIGN_CONFLICTED_EVIDENCE");
  assert.deepEqual(selectResearchFrontier(s, evidence, 2).batch, []);
  const conflicted = observed(); conflicted.assessment.conflicted = true;
  assert.equal(experimentalDesign(s, [conflicted]).posterior, null);
});

test("shared lemma allocation still precedes design utility within the same purpose", () => {
  const s = strategy(), graph = Object.fromEntries(s.candidates.map(c => [c.id, {
    specHash: digest(c.id), targetHash: digest({ target: c.id }), premises: c.id === "perfect" ? ["uninformative"] : [],
  }]));
  assert.equal(selectResearchFrontier(s, [], 0, { theory: graph }).next, "uninformative");
});

test("impossible evidence suspends optional work and long likelihood products stay numerically stable", () => {
  const s = strategy(); s.design!.likelihoods.uninformative = { a: row(0), b: row(1) };
  const impossible = [observed("perfect"), observed("uninformative", "SUPPORTED", "other")];
  const result = selectResearchFrontier(s, impossible, 2);
  assert.equal(result.design!.status, "MODEL_INCONSISTENT"); assert.equal(result.design!.posterior, null);
  assert.deepEqual(result.batch, []); assert.equal(result.reason, "EXPERIMENT_DESIGN_MODEL_INCONSISTENT");
  const many = Array.from({ length: 1000 }, (_, i) => observed("noisy", "SUPPORTED", `independent-${i}`));
  const stable = experimentalDesign(s, many);
  assert.equal(stable.status, "READY"); near(stable.posterior!.a, 1); near(stable.entropyBits, 0);
  assert.ok(Object.values(stable.candidates).every(c => Number.isFinite(c.bitsPerMs)));
});

test("design rejects unbounded, incomplete, unnormalized and model-authored configuration", () => {
  validateResearchStrategy(strategy());
  for (const mutate of [
    (s: any) => delete s.frontier,
    (s: any) => s.design = null,
    (s: any) => s.design.hypotheses[0].prior = 0.7,
    (s: any) => s.design.hypotheses[0].prior = 0,
    (s: any) => s.design.hypotheses[1].id = "a",
    (s: any) => s.design.hypotheses = Array.from({ length: 33 }, (_, i) => ({ id: `h${i}`, prior: 1 / 33 })),
    (s: any) => delete s.design.likelihoods.noisy,
    (s: any) => s.design.likelihoods.noisy.a.SUPPORTED = NaN,
    (s: any) => s.design.likelihoods.noisy.a.INCONCLUSIVE = 1,
    (s: any) => s.design.likelihoods.noisy.a.reward = 1,
    (s: any) => s.design.fallbackCostMs = 0,
    (s: any) => s.design.fallbackCostMs = Infinity,
  ]) { const s = strategy(); mutate(s); assert.throws(() => validateResearchStrategy(s)); }
});

function configure(s: any) {
  s.researchStrategy = strategy(); s.researchProgramme = { id: "design", maxFindingsPerTask: 4, maxContextBytes: 16000 };
  s.jobs = Object.fromEntries(s.researchStrategy.candidates.map((c: any) => [c.template, {
    adapter: { argv: [process.execPath, "-e", "process.exit(0)"] }, research: { spec: bellExperiment() },
    idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 8, maxConcurrent: 2,
  }]));
  s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = Object.keys(s.jobs);
  s.agents.planner = { ...s.agents.coder, tools: [...s.agents.coder.tools], model: "planner" };
  s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 10000,
    dynamicDAG: { maxChildrenPerTask: 4, maxDepth: 2, maxSpawnedTasks: 8 },
    workflowPolicy: { agent: "planner", mode: "apply", minIntervalMs: 100, maxReviews: 16,
      maxOperations: 4, maxSnapshotTasks: 8, maxSnapshotBytes: 16000, maxTaskTimeoutMs: 40000,
      allowedOperations: ["expand_task"] } };
}

test("runtime ignores unchecked results, then reconstructs accepted Bayesian observations after restart", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([{ ...task(), research: ["noisy"] }]);
  const before: any = researchStrategySnapshot(s, cfg, run);
  near(before.frontier.design.posterior.a, 0.5);
  const lease = q.claim(run, "worker")!, c = q.capsule(lease), protocol = cfg.spec.jobs!.noisy.research!.spec;
  const rpc = async (_c: any, _cfg: any, input: any) => ({ schema: 1, key: input.key, jobId: input.key,
    status: "SUCCEEDED", result: { exitCode: 0, data: simulateQuantum(protocol) } });
  await new ResearchJobs(new SessionJournal(s), cfg, rpc).execute(c, cfg.spec.agents.coder,
    { id: "job", name: "run_job", arguments: { name: "noisy", input: protocol.input } }, signal());
  const unaccepted: any = researchStrategySnapshot(s, cfg, run);
  near(unaccepted.frontier.design.posterior.a, 0.5); assert.equal(unaccepted.frontier.design.observations, 0);
  // Reuse the durable job through a new task attempt; no new execution is needed.
  q.fail(lease, "fixture worker crashed before acceptance");
  const mock = scripted([
    () => reply("", [{ name: "run_job", arguments: { name: "noisy", input: protocol.input } }]),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]), () => reply(),
  ]);
  const result = await runTasks(s, [], new SwarmDriver(s, cfg, mock.fetcher, undefined, rpc), { signal: signal(), resumeRun: run });
  assert.equal(result.status, "PASS");
  const accepted: any = researchStrategySnapshot(s, cfg, run);
  near(accepted.frontier.design.posterior.a, 0.9); assert.equal(accepted.frontier.design.observations, 1);
  assert.equal(accepted.frontier.design.trust, "CONDITIONAL_ON_OPERATOR_MODEL_NOT_ACCEPTANCE");
  assert.equal(accepted.frontier.scoring, "CONDITIONAL_INFORMATION_BITS_PER_JOB_MS");
  assert.equal(accepted.candidates[0].allocationScore, accepted.candidates[0].design.conditionalBitsPerMs);
  near(accepted.candidates[0].allocationScore, accepted.candidates[0].design.bitsPerMs);
  const reopened = await Store.open(s.root);
  try { assert.deepEqual(researchStrategySnapshot(reopened, cfg, run), accepted); } finally { reopened.close(); }
}, configure));
