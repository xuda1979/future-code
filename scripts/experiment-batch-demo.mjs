/** Offline finite-model calculation. No LLM, external job or acceptance claim. */
import { experimentalDesign } from "../src/harness/foundry/experimentDesign.ts";
import { selectResearchFrontier } from "../src/harness/foundry/researchFrontier.ts";

const hypotheses = ["h00", "h01", "h10", "h11"].map(id => ({ id, prior: 0.25 }));
const candidates = ["screen-a", "screen-a-copy", "screen-b"].map(id => ({
  id, template: id, line: id, purpose: "exploration",
}));
const strategy = { schema: 1, maxExperiments: 8, maxSnapshotBytes: 16000, stopOnRefutation: false,
  frontier: { maxParallel: 2, explorationWeight: 1, maxInconclusivePerLine: 3 }, candidates,
  design: { schema: 1, hypotheses, fallbackCostMs: 1000,
    likelihoods: Object.fromEntries(candidates.map((c, i) => [c.id, Object.fromEntries(hypotheses.map(h => {
      const p = h.id[i === 2 ? 2 : 1] === "0" ? 1 : 0;
      return [h.id, { SUPPORTED: p, REFUTED: 1 - p, INCONCLUSIVE: 0 }];
    }))])) } };

// Independent direct joint-distribution calculation for the displayed arms.
function information(ids) {
  const outcomes = ["SUPPORTED", "REFUTED", "INCONCLUSIVE"];
  let bits = 0;
  function enumerate(tuple) {
    if (tuple.length < ids.length) { for (const y of outcomes) enumerate([...tuple, y]); return; }
    const joint = hypotheses.map(h => h.prior * ids.reduce((p, id, i) => p * strategy.design.likelihoods[id][h.id][tuple[i]], 1));
    const marginal = joint.reduce((a, b) => a + b, 0);
    joint.forEach((p, i) => { if (p > 0) bits += p * Math.log2(p / (hypotheses[i].prior * marginal)); });
  }
  enumerate([]); return bits;
}

const individual = experimentalDesign(strategy, []);
const baseline = candidates.map((c, i) => ({ id: c.id, i, score: individual.candidates[c.id].bitsPerMs }))
  .sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 2).map(c => c.id);
const selected = selectResearchFrontier(strategy, [], 0);
const withPending = selectResearchFrontier(strategy, [], 1, { pending: ["screen-a"] });
console.log(JSON.stringify({ schema: 1, scope: "SYNTHETIC_FINITE_MODEL_NOT_LIVE_RESEARCH", hypotheses: hypotheses.length,
  arms: {
    individual: { batch: baseline, jointInformationBits: information(baseline) },
    conditional: { batch: selected.batch, jointInformationBits: information(selected.batch),
      expectedInformationBits: selected.design.batch.expectedInformationBits },
  },
  pendingExample: { pending: ["screen-a"], next: withPending.batch,
    expectedNewInformationBits: withPending.design.batch.expectedInformationBits,
    acceptedObservations: withPending.design.observations },
  tokens: null, costUsd: null,
}, null, 2));
