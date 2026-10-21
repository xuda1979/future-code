import test from "node:test";
import assert from "node:assert/strict";
import { experimentalDesign } from "../../src/harness/foundry/experimentDesign.ts";
import { selectExperimentBatch } from "../../src/harness/foundry/experimentBatch.ts";
import { selectResearchFrontier } from "../../src/harness/foundry/researchFrontier.ts";
import { validateResearchStrategy, type ResearchStrategy } from "../../src/harness/foundry/researchStrategy.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { researchStrategySnapshot, assertResearchFrontierExpansion } from "../../src/harness/foundry/swarm/researchStrategy.ts";
import { bellExperiment } from "../../scripts/quantum-experiment.mjs";
import { fixture, task } from "./swarm-fixtures.ts";

const near = (x: number | null, y: number) => assert.ok(x !== null && Math.abs(x - y) < 1e-12, `${x} != ${y}`);
const outcomes = ["SUPPORTED", "REFUTED", "INCONCLUSIVE"] as const;
function strategy(): ResearchStrategy {
  const candidates = ["screen-a", "screen-a-copy", "screen-b"].map(id => ({ id, template: id, line: id, purpose: "exploration" as const }));
  const hypotheses = ["h00", "h01", "h10", "h11"].map(id => ({ id, prior: 0.25 }));
  return { schema: 1, maxExperiments: 8, maxSnapshotBytes: 16000, stopOnRefutation: false,
    frontier: { maxParallel: 2, explorationWeight: 1, maxInconclusivePerLine: 3 }, candidates,
    design: { schema: 1, hypotheses, fallbackCostMs: 1000,
      likelihoods: Object.fromEntries(candidates.map((c, i) => [c.id, Object.fromEntries(hypotheses.map(h => {
        const p = h.id[i === 2 ? 2 : 1] === "0" ? 1 : 0;
        return [h.id, { SUPPORTED: p, REFUTED: 1 - p, INCONCLUSIVE: 0 }];
      }))])) } };
}
const ranked = (s: ResearchStrategy) => s.candidates.map(c => ({ id: c.id, line: c.line, priority: 0, costMs: 1000 }));
const prior = (s: ResearchStrategy) => Object.fromEntries(s.design!.hypotheses.map(h => [h.id, h.prior]));

/** Independent oracle: enumerate the joint distribution P(H, Y1, ..., Yn)
 * directly, without the implementation's posterior-state recursion. */
function jointInformation(s: ResearchStrategy, p: Record<string, number>, ids: string[]): number {
  const d = s.design!; let bits = 0;
  const enumerate = (tuple: number[]) => {
    if (tuple.length < ids.length) { for (let y = 0; y < 3; y++) enumerate([...tuple, y]); return; }
    const joint = d.hypotheses.map(h => p[h.id] * ids.reduce((q, id, i) => q * d.likelihoods[id][h.id][outcomes[tuple[i]]], 1));
    const marginal = joint.reduce((a, b) => a + b, 0);
    joint.forEach((q, h) => { if (q > 0) bits += q * Math.log2(q / (p[d.hypotheses[h].id] * marginal)); });
  };
  enumerate([]); return bits;
}

test("parallel design prefers complementary measurements over individually identical utility", () => {
  const s = strategy(), individual = experimentalDesign(s, []);
  for (const c of s.candidates) near(individual.candidates[c.id].expectedInformationBits, 1);
  const result = selectResearchFrontier(s, [], 0);
  assert.deepEqual(result.batch, ["screen-a", "screen-b"]);
  const batch = result.design!.batch!;
  near(batch.expectedInformationBits, 2); near(batch.pendingInformationBits, 0);
  near(batch.expectedInformationBits, jointInformation(s, prior(s), result.batch));
  near(jointInformation(s, prior(s), ["screen-a", "screen-a-copy"]), 1);
  near(batch.utilities["screen-b"].conditionalInformationBits, 1);
  assert.equal(batch.method, "EXACT_GREEDY_CONDITIONAL_INFORMATION");
});

test("pending jobs contribute expected uncertainty reduction without fabricated observations", () => {
  const s = strategy(), next = selectResearchFrontier(s, [], 1, { pending: ["screen-a"] });
  assert.deepEqual(next.batch, ["screen-b"]);
  assert.equal(next.design!.observations, 0); assert.deepEqual(next.design!.posterior, prior(s));
  assert.deepEqual(next.design!.batch!.pending, ["screen-a"]);
  near(next.design!.batch!.pendingInformationBits, 1);
  near(next.design!.batch!.expectedInformationBits, 1);
  assert.equal(next.states["screen-a-copy"], "ELIGIBLE");
  const both = selectExperimentBatch(s, prior(s), ranked(s), 1, ["screen-a", "screen-b"]);
  near(both.expectedInformationBits, 0); near(both.pendingInformationBits, 2);
  assert.deepEqual(both, selectExperimentBatch(s, prior(s), ranked(s), 1, ["screen-b", "screen-a"]));
});

test("exact marginal utilities match independent joint enumeration for noisy three-outcome models", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const s = strategy(); let state = seed;
    const next = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % 100) + 1;
    for (const c of s.candidates) for (const h of s.design!.hypotheses) {
      const raw = outcomes.map(next), sum = raw.reduce((a, b) => a + b, 0);
      s.design!.likelihoods[c.id][h.id] = Object.fromEntries(outcomes.map((o, i) => [o, raw[i] / sum])) as any;
    }
    s.design!.hypotheses.forEach((h, i) => h.prior = (i + 1) / 10);
    for (const pending of [[], ["screen-a-copy"]]) {
      const result = selectExperimentBatch(s, prior(s), ranked(s), 2, pending);
      const base = jointInformation(s, prior(s), pending);
      near(result.pendingInformationBits, base);
      near(result.expectedInformationBits, jointInformation(s, prior(s), [...pending, ...result.batch]) - base);
      result.batch.forEach((id, i) => {
        const prefix = [...pending, ...result.batch.slice(0, i)];
        near(result.utilities[id].conditionalInformationBits,
          jointInformation(s, prior(s), [...prefix, id]) - jointInformation(s, prior(s), prefix));
      });
    }
  }
});

test("falsification, shared-lemma priority, line diversity and budget gates still govern batches", () => {
  const s = strategy(); s.frontier!.maxParallel = 3;
  s.candidates[0].purpose = "falsification"; s.candidates[1].purpose = "falsification";
  assert.deepEqual(selectResearchFrontier(s, [], 0).batch, ["screen-a", "screen-a-copy", "screen-b"]);
  // The second falsification has zero modeled information but retains host priority.
  near(selectResearchFrontier(s, [], 0).design!.batch!.utilities["screen-a-copy"].conditionalInformationBits, 0);
  s.candidates[1].line = s.candidates[0].line;
  assert.deepEqual(selectResearchFrontier(s, [], 0).batch, ["screen-a", "screen-b"]);
  assert.deepEqual(selectResearchFrontier(s, [], 7).batch, ["screen-a"]);
  assert.deepEqual(selectResearchFrontier(s, [], 8).batch, []);
  assert.deepEqual(selectResearchFrontier(s, [], 3, { pending: s.candidates.map(c => c.id) }).batch, []);
  const candidates = ranked(s); candidates[1].priority = 0; candidates[2].priority = 1;
  assert.deepEqual(selectExperimentBatch(s, prior(s), candidates, 2, ["screen-a"]).batch, ["screen-b"]);
  s.candidates[1].line = "copy";
  const tiers = ranked(s); tiers[2].priority = 1;
  assert.deepEqual(selectExperimentBatch(s, prior(s), tiers, 2).batch, ["screen-a", "screen-a-copy"]);
});

test("a state limit preserves the valid prefix and cannot approximate away pending jobs", () => {
  const s = strategy(); s.design!.batch = { maxStates: 1, maxLikelihoodTerms: 1000000 };
  const first = selectResearchFrontier(s, [], 0);
  assert.deepEqual(first.batch, ["screen-a"]);
  assert.equal(first.design!.batch!.stopReason, "STATE_LIMIT");
  assert.equal(first.design!.batch!.peakStates, 1);
  near(first.design!.batch!.expectedInformationBits, 1);
  const pending = selectResearchFrontier(s, [], 1, { pending: ["screen-a"] });
  assert.deepEqual(pending.batch, []);
  assert.equal(pending.reason, "EXPERIMENT_DESIGN_BATCH_STATE_LIMIT");
  assert.equal(pending.design!.batch!.pendingInformationBits, null);
  // A single requested measurement does not enumerate unneeded future states.
  assert.deepEqual(selectResearchFrontier(s, [], 7).batch, ["screen-a"]);
  s.frontier!.maxParallel = 3; s.design!.batch.maxStates = 3;
  const two = selectResearchFrontier(s, [], 0);
  assert.deepEqual(two.batch, ["screen-a", "screen-b"]);
  assert.equal(two.design!.batch!.peakStates, 3);
  assert.equal(two.design!.batch!.stopReason, "STATE_LIMIT");
});

test("likelihood-term limits reserve complete tiers and bound pending conditioning", () => {
  const s = strategy(); s.design!.batch = { maxStates: 256, maxLikelihoodTerms: 35 };
  const insufficient = selectResearchFrontier(s, [], 0);
  assert.deepEqual(insufficient.batch, []);
  assert.equal(insufficient.reason, "EXPERIMENT_DESIGN_BATCH_LIKELIHOOD_TERM_LIMIT");
  assert.equal(insufficient.design!.batch!.likelihoodTerms, 0);
  s.design!.batch.maxLikelihoodTerms = 48;
  const prefix = selectResearchFrontier(s, [], 0);
  assert.deepEqual(prefix.batch, ["screen-a"]);
  assert.equal(prefix.design!.batch!.stopReason, "LIKELIHOOD_TERM_LIMIT");
  assert.equal(prefix.design!.batch!.likelihoodTerms, 48);
  s.design!.batch.maxLikelihoodTerms = 11;
  const pending = selectResearchFrontier(s, [], 1, { pending: ["screen-a"] });
  assert.deepEqual(pending.batch, []); assert.equal(pending.design!.batch!.pendingInformationBits, null);
});

test("batch policy rejects unbounded configuration and invalid selector inputs", () => {
  for (const batch of [null, {}, { maxStates: 0, maxLikelihoodTerms: 1 }, { maxStates: 4097, maxLikelihoodTerms: 1 },
    { maxStates: 1, maxLikelihoodTerms: 0 }, { maxStates: 1.5, maxLikelihoodTerms: 10 },
    { maxStates: 1, maxLikelihoodTerms: Infinity }, { maxStates: 1, maxLikelihoodTerms: 4000001 },
    { maxStates: 1, maxLikelihoodTerms: 100, reward: 1 }]) {
    const s = strategy(); s.design!.batch = batch as any; assert.throws(() => validateResearchStrategy(s));
  }
  const s = strategy(), p = prior(s), cs = ranked(s);
  for (const n of [-1, 1.5, 33]) assert.throws(() => selectExperimentBatch(s, p, cs, n));
  assert.throws(() => selectExperimentBatch(s, { ...p, h00: NaN }, cs, 1), /posterior/);
  assert.throws(() => selectExperimentBatch(s, { ...p, h00: 0.5 }, cs, 1), /posterior/);
  assert.throws(() => selectExperimentBatch(s, p, [...cs, cs[0]], 1), /candidates/);
  assert.throws(() => selectExperimentBatch(s, p, [{ ...cs[0], costMs: 0 }], 1), /candidates/);
  assert.throws(() => selectExperimentBatch(s, p, cs, 1, ["unknown"]), /pending/);
  assert.throws(() => selectExperimentBatch(s, p, cs, 1, ["screen-a", "screen-a"]), /pending/);
});

test("cost-normalized conditional utility is finite at degenerate and extreme posteriors", () => {
  const s = strategy();
  const expensive = selectResearchFrontier(s, [], 0, { costs: { "screen-a": 1000, "screen-a-copy": 1, "screen-b": 10 } });
  assert.deepEqual(expensive.batch, ["screen-a-copy", "screen-b"]);
  near(expensive.design!.batch!.utilities["screen-a-copy"].conditionalBitsPerMs, 1);
  for (const p of [{ h00: 1, h01: 0, h10: 0, h11: 0 }, { h00: Number.MIN_VALUE, h01: 1, h10: 0, h11: 0 }]) {
    const result = selectExperimentBatch(s, p, ranked(s), 2);
    assert.ok(Number.isFinite(result.expectedInformationBits));
    assert.ok(Object.values(result.utilities).every(v => Number.isFinite(v.conditionalBitsPerMs) && v.conditionalInformationBits >= 0));
    near(result.expectedInformationBits, 0);
  }
});

test("hundreds of noisy candidates stay within deterministic work and state bounds", () => {
  const s = strategy(); s.frontier!.maxParallel = 32; s.maxExperiments = 256;
  s.candidates = Array.from({ length: 256 }, (_, i) => ({ id: `c${i}`, template: `c${i}`, line: `c${i}`, purpose: "exploration" }));
  s.design!.hypotheses = Array.from({ length: 32 }, (_, i) => ({ id: `h${i}`, prior: 1 / 32 }));
  s.design!.likelihoods = Object.fromEntries(s.candidates.map((c, i) => [c.id, Object.fromEntries(s.design!.hypotheses.map((h, j) => {
    const p = (1 + (i + j) % 8) / 10;
    return [h.id, { SUPPORTED: p, REFUTED: 0.9 - p, INCONCLUSIVE: 0.1 }];
  }))]));
  const result = selectResearchFrontier(s, [], 0), batch = result.design!.batch!;
  assert.ok(result.batch.length > 0 && result.batch.length < 32);
  assert.ok(batch.likelihoodTerms <= batch.maxLikelihoodTerms && batch.peakStates <= batch.maxStates);
  assert.ok(batch.expectedInformationBits >= 0 && batch.expectedInformationBits <= 5 + 1e-12);
  assert.deepEqual(selectResearchFrontier(s, [], 0), result);
});

test("runtime admission and restart preserve pending-job conditioning and bounded diagnostics", async () => fixture(async (store, cfg) => {
  const run = new Scheduler(store).start([{ ...task(), research: ["screen-a"] }]);
  const snapshot: any = researchStrategySnapshot(store, cfg, run);
  assert.deepEqual(snapshot.decision.batch, ["screen-b"]);
  assert.equal(snapshot.reserved, 1); assert.equal(snapshot.used, 0);
  assert.equal(snapshot.frontier.design.observations, 0);
  assert.equal(snapshot.frontier.design.batch.pendingCount, 1);
  assert.equal(snapshot.frontier.design.batch.pendingHash.length, 64);
  assert.equal(snapshot.frontier.design.batch.pending, undefined);
  near(snapshot.frontier.design.batch.pendingInformationBits, 1);
  assert.equal(snapshot.candidates[0].allocationScore, snapshot.candidates[0].design.conditionalBitsPerMs);
  assert.throws(() => assertResearchFrontierExpansion(store, cfg, run, [{ ...task("b"), research: ["screen-a-copy"] }]), /eligible frontier/);
  assertResearchFrontierExpansion(store, cfg, run, [{ ...task("b"), research: ["screen-b"] }]);
  const reopened = await Store.open(store.root);
  try { assert.deepEqual(researchStrategySnapshot(reopened, cfg, run), snapshot); } finally { reopened.close(); }
}, configure));

test("large mandatory portfolios keep pending diagnostics within a small snapshot budget", async () => fixture(async (store, cfg) => {
  const run = new Scheduler(store).start(cfg.spec.researchStrategy!.candidates.map((c, i) => ({ ...task(`task${i}`), research: [c.template] })));
  const snapshot: any = researchStrategySnapshot(store, cfg, run);
  assert.equal(snapshot.frontier.design.batch.pendingCount, 64);
  assert.deepEqual(snapshot.decision.batch, []);
  assert.equal(snapshot.decision.reason, "FRONTIER_AT_CAPACITY");
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 2048);
}, s => {
  configure(s);
  const old = s.researchStrategy!, channel = old.design!.likelihoods[old.candidates[0].id];
  const job = s.jobs![old.candidates[0].template];
  const candidates = Array.from({ length: 64 }, (_, i) => {
    const id = `c${i}-${"x".repeat(120)}`;
    return { id, template: id, line: id, purpose: "exploration" as const };
  });
  s.researchStrategy = { ...old, maxExperiments: 128, maxSnapshotBytes: 2048, candidates,
    design: { ...old.design!, likelihoods: Object.fromEntries(candidates.map(c => [c.id, channel])) } };
  s.jobs = Object.fromEntries(candidates.map(c => [c.template, job]));
  for (const agent of Object.values(s.agents)) agent.jobs = Object.keys(s.jobs);
}));

function configure(s: any) {
  s.researchStrategy = strategy();
  s.jobs = Object.fromEntries(s.researchStrategy.candidates.map(c => [c.template, {
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
