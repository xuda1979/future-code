import { invariant } from "./kernel.ts";
import { validateExperimentDesign } from "./experimentDesign.ts";
import type { ResearchStrategy } from "./researchStrategy.ts";

export interface DesignCandidate {
  id: string;
  line: string;
  /** Lower tiers retain host purpose and shared-lemma priority. */
  priority: number;
  costMs: number;
}
interface Belief { probability: number; posterior: number[] }
export interface ConditionalUtility {
  conditionalInformationBits: number;
  conditionalBitsPerMs: number;
  position: number;
}
export interface ExperimentBatch {
  method: "EXACT_GREEDY_CONDITIONAL_INFORMATION";
  batch: string[];
  pending: string[];
  utilities: Record<string, ConditionalUtility>;
  /** Expected NEW information beyond the pending measurements. */
  expectedInformationBits: number;
  pendingInformationBits: number | null;
  stopReason: "BATCH_LIMIT" | "NO_ELIGIBLE_EXPERIMENT" | "STATE_LIMIT" | "LIKELIHOOD_TERM_LIMIT";
  maxStates: number;
  peakStates: number;
  maxLikelihoodTerms: number;
  likelihoodTerms: number;
}
const outcomes = ["SUPPORTED", "REFUTED", "INCONCLUSIVE"] as const;
const entropy = (ps: number[]) => -ps.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0);

/** Expected conditional mutual information under a finite, operator-owned
 * model. Enumerate possible outcomes, never pretend a pending job succeeded.
 * Greedy selection is not a globally optimal batch or an acceptance oracle.
 * Candidate order breaks ties, making host priority and replay deterministic. */
export function selectExperimentBatch(s: ResearchStrategy, posterior: Record<string, number>,
  candidates: DesignCandidate[], count: number, pending: string[] = []): ExperimentBatch {
  validateExperimentDesign(s); const d = s.design!;
  invariant(d, "experimental design is not configured");
  invariant(Number.isSafeInteger(count) && count >= 0 && count <= 32, "invalid experiment batch size");
  const configured = new Map(s.candidates.map(c => [c.id, c]));
  invariant(candidates.length <= s.candidates.length && new Set(candidates.map(c => c.id)).size === candidates.length &&
    candidates.every(c => configured.get(c.id)?.line === c.line && Number.isSafeInteger(c.priority) && c.priority >= 0 &&
      Number.isFinite(c.costMs) && c.costMs >= 1), "invalid design batch candidates");
  invariant(pending.length <= s.candidates.length && new Set(pending).size === pending.length &&
    pending.every(id => configured.has(id)), "invalid pending design experiments");
  invariant(posterior && Object.keys(posterior).length === d.hypotheses.length && d.hypotheses.every(h =>
    Object.hasOwn(posterior, h.id) && Number.isFinite(posterior[h.id]) && posterior[h.id] >= 0 && posterior[h.id] <= 1) &&
    Math.abs(d.hypotheses.reduce((sum, h) => sum + posterior[h.id], 0) - 1) <= 1e-9, "invalid design batch posterior");
  const result: ExperimentBatch = { method: "EXACT_GREEDY_CONDITIONAL_INFORMATION", batch: [], pending: [...pending].sort(),
    utilities: {}, expectedInformationBits: 0, pendingInformationBits: null, stopReason: "BATCH_LIMIT",
    maxStates: d.batch?.maxStates ?? 256, peakStates: 1,
    maxLikelihoodTerms: d.batch?.maxLikelihoodTerms ?? 1000000, likelihoodTerms: 0 };
  if (!count) return result;
  const occupied = new Set(pending.map(id => configured.get(id)!.line));
  let remaining = candidates.filter(c => !occupied.has(c.line));
  if (!remaining.length) { result.stopReason = "NO_ELIGIBLE_EXPERIMENT"; return result; }
  const initial = d.hypotheses.map(h => posterior[h.id]);
  let beliefs: Belief[] = [{ probability: 1, posterior: initial }];
  const channels = new Map([...configured.keys()].map(id => [id, d.hypotheses.map(h => outcomes.map(o => d.likelihoods[id][h.id][o]))]));
  // This counter bounds likelihood terms in BOTH scoring and state expansion.
  // Reserve a whole priority tier before scoring to avoid truncation-order bias.
  const reserve = (evaluations: number): boolean => {
    const terms = evaluations * beliefs.length * d.hypotheses.length * outcomes.length;
    if (terms > result.maxLikelihoodTerms - result.likelihoodTerms) {
      result.stopReason = "LIKELIHOOD_TERM_LIMIT"; return false;
    }
    result.likelihoodTerms += terms; return true;
  };
  const extend = (id: string): boolean => {
    if (!reserve(1)) return false;
    const next: Belief[] = [], rows = channels.get(id)!;
    for (const b of beliefs) for (let y = 0; y < outcomes.length; y++) {
      const joint = b.posterior.map((p, h) => p * rows[h][y]);
      const probability = joint.reduce((sum, p) => sum + p, 0);
      if (probability === 0) continue;
      if (next.length === result.maxStates) {
        result.peakStates = Math.max(result.peakStates, next.length);
        result.stopReason = "STATE_LIMIT"; return false;
      }
      next.push({ probability: b.probability * probability, posterior: joint.map(p => p / probability) });
    }
    beliefs = next; result.peakStates = Math.max(result.peakStates, next.length); return true;
  };
  for (const id of result.pending) if (!extend(id)) return result;
  result.pendingInformationBits = Math.max(0, entropy(initial) - beliefs.reduce((sum, b) => sum + b.probability * entropy(b.posterior), 0));
  const information = (id: string): number => {
    const rows = channels.get(id)!;
    return beliefs.reduce((sum, b) => {
      // KL form avoids cancellation between nearly equal entropies.
      const predictive = outcomes.map((_, y) => b.posterior.reduce((p, w, h) => p + w * rows[h][y], 0));
      let bits = 0;
      for (let h = 0; h < rows.length; h++) for (let y = 0; y < outcomes.length; y++) {
        const joint = b.posterior[h] * rows[h][y];
        if (joint > 0) bits += joint * (Math.log2(rows[h][y]) - Math.log2(predictive[y]));
      }
      return sum + b.probability * Math.max(0, Math.min(entropy(b.posterior), bits));
    }, 0);
  };
  while (remaining.length && result.batch.length < count) {
    const priority = Math.min(...remaining.map(c => c.priority));
    const tier = remaining.filter(c => c.priority === priority);
    if (!reserve(tier.length)) return result;
    let chosen = tier[0], bits = information(chosen.id), score = bits / chosen.costMs;
    for (const c of tier.slice(1)) {
      const nextBits = information(c.id), nextScore = nextBits / c.costMs;
      if (nextScore > score) { chosen = c; bits = nextBits; score = nextScore; }
    }
    result.utilities[chosen.id] = { conditionalInformationBits: bits, conditionalBitsPerMs: score, position: result.batch.length };
    result.batch.push(chosen.id); result.expectedInformationBits += bits;
    remaining = remaining.filter(c => c.line !== chosen.line);
    if (!remaining.length) { result.stopReason = "NO_ELIGIBLE_EXPERIMENT"; return result; }
    if (result.batch.length < count && !extend(chosen.id)) return result;
  }
  return result;
}
