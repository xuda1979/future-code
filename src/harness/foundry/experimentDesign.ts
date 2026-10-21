import { digest, identifier, invariant } from "./kernel.ts";
import { fields, type ResearchOutcome } from "./research.ts";
import type { ResearchStrategy, StrategyObservation } from "./researchStrategy.ts";

const outcomes: ResearchOutcome[] = ["SUPPORTED", "REFUTED", "INCONCLUSIVE"];
export interface ExperimentDesign {
  schema: 1;
  hypotheses: { id: string; prior: number }[];
  /** Operator-owned likelihoods, frozen with the strategy, never model rewards. */
  likelihoods: Record<string, Record<string, Record<ResearchOutcome, number>>>;
  fallbackCostMs: number;
  /** Deterministic bounds on exact, greedy batch conditioning. */
  batch?: { maxStates: number; maxLikelihoodTerms: number };
}

export function validateExperimentDesign(s: ResearchStrategy): void {
  const d = s.design; if (d === undefined) return;
  fields(d, ["schema", "hypotheses", "likelihoods", "fallbackCostMs"], ["batch"]);
  invariant(s.frontier && d.schema === 1 && Array.isArray(d.hypotheses) && d.hypotheses.length >= 2 &&
    d.hypotheses.length <= 32 && new Set(d.hypotheses.map(h => h.id)).size === d.hypotheses.length,
    "experimental design requires a frontier and 2..32 unique hypotheses");
  invariant(Number.isFinite(d.fallbackCostMs) && d.fallbackCostMs >= 1 && d.fallbackCostMs <= 3600000,
    "invalid experimental design fallback cost");
  if (d.batch !== undefined) {
    fields(d.batch, ["maxStates", "maxLikelihoodTerms"]);
    invariant(Number.isSafeInteger(d.batch.maxStates) && d.batch.maxStates >= 1 && d.batch.maxStates <= 4096 &&
      Number.isSafeInteger(d.batch.maxLikelihoodTerms) && d.batch.maxLikelihoodTerms >= 1 &&
      d.batch.maxLikelihoodTerms <= 4000000, "invalid experimental design batch bounds");
  }
  const probability = (x: number) => Number.isFinite(x) && x >= 0 && x <= 1;
  for (const h of d.hypotheses) {
    fields(h, ["id", "prior"]); identifier(h.id);
    invariant(probability(h.prior) && h.prior > 0, "invalid experimental design prior");
  }
  const normalized = (xs: number[]) => Math.abs(xs.reduce((a, b) => a + b, 0) - 1) <= 1e-9;
  invariant(normalized(d.hypotheses.map(h => h.prior)), "experimental design priors must sum to one");
  fields(d.likelihoods, s.candidates.map(c => c.id));
  for (const c of s.candidates) {
    fields(d.likelihoods[c.id], d.hypotheses.map(h => h.id));
    for (const h of d.hypotheses) {
      const row = d.likelihoods[c.id][h.id]; fields(row, outcomes);
      invariant(outcomes.every(o => probability(row[o])) && normalized(outcomes.map(o => row[o])),
        "experimental design likelihoods must be probabilities summing to one");
    }
  }
}

/** Finite Bayesian design, conditional on operator-supplied likelihoods and
 * conditional independence of distinct results. Posterior weights allocate
 * optional work; they never establish a theorem or change acceptance. */
export function experimentalDesign(s: ResearchStrategy, observations: StrategyObservation[],
  costs: Record<string, number | null> = {}, conflicted = false) {
  validateExperimentDesign(s); const d = s.design!;
  invariant(d, "experimental design is not configured");
  const keys = new Map<string, string>(), unique = new Map<string, StrategyObservation>();
  invariant(Array.isArray(observations) && observations.length <= 4096, "experimental design observation bound exceeded");
  const observed = new Map<string, Set<ResearchOutcome>>(); let conflict = conflicted;
  for (const o of observations) {
    invariant(Object.hasOwn(d.likelihoods, o.candidate) && typeof o.key === "string" && o.key.length > 0 &&
      outcomes.includes(o.assessment.outcome), "unknown design observation");
    const binding = digest({ candidate: o.candidate, assessment: o.assessment });
    invariant(!keys.has(o.key) || keys.get(o.key) === binding, "design observation replay drift"); keys.set(o.key, binding);
    const identity = digest({ candidate: o.candidate, spec: o.assessment.specHash, result: o.assessment.resultHash,
      outcome: o.assessment.outcome, conflicted: !!o.assessment.conflicted });
    unique.set(identity, o);
    const protocol = `${o.candidate}:${o.assessment.specHash}`, values = observed.get(protocol) ?? new Set<ResearchOutcome>();
    values.add(o.assessment.outcome); observed.set(protocol, values);
    conflict ||= !!o.assessment.conflicted || (values.has("SUPPORTED") && values.has("REFUTED"));
  }
  // Canonical order makes replay/permutation stable, including floating point.
  const ordered = [...unique].sort(([a], [b]) => a.localeCompare(b));
  const weights = d.hypotheses.map(h => ordered.reduce((w, [, o]) =>
    w + Math.log(d.likelihoods[o.candidate][h.id][o.assessment.outcome]), Math.log(h.prior)));
  const peak = Math.max(...weights), relative = weights.map(w => Math.exp(w - peak));
  const total = relative.reduce((a, b) => a + b, 0);
  const status = conflict ? "CONFLICTED_EVIDENCE" : !Number.isFinite(total) || total <= 0 ? "MODEL_INCONSISTENT" : "READY";
  const posterior = status === "READY" ? relative.map(w => w / total) : null;
  const entropy = (ps: number[]) => -ps.reduce((n, p) => n + (p > 0 ? p * Math.log2(p) : 0), 0);
  const entropyBits = posterior ? entropy(posterior) : null;
  const candidates = Object.fromEntries(s.candidates.map(c => {
    const measured = costs[c.id], known = typeof measured === "number" && Number.isFinite(measured) && measured >= 0;
    const costMs = known ? Math.max(1, measured) : d.fallbackCostMs;
    let expectedInformationBits: number | null = null;
    if (posterior) {
      let expectedEntropy = 0;
      for (const o of outcomes) {
        const joint = d.hypotheses.map((h, i) => posterior[i] * d.likelihoods[c.id][h.id][o]);
        const probability = joint.reduce((a, b) => a + b, 0);
        if (probability > 0) expectedEntropy += probability * entropy(joint.map(p => p / probability));
      }
      expectedInformationBits = Math.max(0, Math.min(entropyBits!, entropyBits! - expectedEntropy));
    }
    return [c.id, { expectedInformationBits, costMs, costBasis: known ? "HOST_OBSERVED_JOB_MS" : "CONFIGURED_FALLBACK_MS",
      bitsPerMs: expectedInformationBits === null ? null : expectedInformationBits / costMs }];
  }));
  return { status, modelHash: digest(d), evidenceHash: digest(ordered.map(([key]) => key)), observations: unique.size,
    entropyBits, posterior: posterior ? Object.fromEntries(d.hypotheses.map((h, i) => [h.id, posterior[i]])) : null, candidates };
}
