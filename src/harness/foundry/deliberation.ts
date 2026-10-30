import { digest, invariant } from "./kernel.ts";
import type { ResearchStrategy, StrategyObservation } from "./researchStrategy.ts";

/** Host-completed jobs from this run, ordered by completion time/key. Only an
 * independently checked result may fill observation; failures still cost time.
 * Imported memory has no current-run cost or stagnation credit. */
export interface DeliberationSample {
  key: string;
  observation: StrategyObservation | null;
  elapsedMs: number | null;
  completedAt: number;
}

/** Three bounded research allocation gears, not MCTS, semantic entropy, or an
 * acceptance rule. Only the existing frozen frontier may receive work. */
export function researchDeliberation(s: ResearchStrategy, observations: StrategyObservation[], samples: DeliberationSample[], openLines: number) {
  const p = s.deliberation;
  invariant(p && s.frontier, "research deliberation not configured");
  invariant(Number.isSafeInteger(openLines) && openLines >= 0 && openLines <= s.candidates.length, "invalid open-line count");
  const fact = (o: StrategyObservation) => digest({ spec: o.assessment.specHash,
    outcome: o.assessment.outcome, conflicted: !!o.assessment.conflicted });
  const informative = (o: StrategyObservation) => !o.assessment.conflicted && o.assessment.outcome !== "INCONCLUSIVE";
  const known = new Set(observations.filter(informative).map(fact));
  const unique = new Map<string, DeliberationSample>();
  for (const sample of samples) {
    invariant(Number.isFinite(sample.completedAt) && sample.completedAt >= 0 &&
      (sample.elapsedMs === null || (Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0)), "invalid host research timing");
    const old = unique.get(sample.key);
    invariant(!old || digest(old) === digest(sample), "deliberation sample replay drift");
    unique.set(sample.key, sample);
  }
  const seen = new Set<string>(); let uninformative = 0, measuredMs = 0, unknownDurations = 0;
  for (const sample of [...unique.values()].sort((a, b) => a.completedAt - b.completedAt || a.key.localeCompare(b.key))) {
    const observation = sample.observation;
    const novel = observation && informative(observation) && !seen.has(fact(observation));
    if (novel) { seen.add(fact(observation!)); uninformative = 0; } else uninformative++;
    if (sample.elapsedMs === null) unknownDurations++; else measuredMs += sample.elapsedMs;
  }
  const stagnant = uninformative >= p.stagnationWindow;
  const gear = p.highImpact || stagnant || (known.size === 0 && openLines >= 3) ? 3 :
    known.size >= p.familiarObservations && openLines <= 1 ? 1 : 2;
  const reason = p.highImpact ? "OPERATOR_HIGH_IMPACT" : stagnant ? "CHECKED_EVIDENCE_STAGNATION" :
    gear === 3 ? "COLD_COMPETING_LINES" : gear === 1 ? "FAMILIAR_NARROW_FRONTIER" : "PROBE_GUIDED_EXPLORATION";
  const stop = measuredMs >= p.maxResearchMs ? "RESEARCH_TIME_BUDGET_EXHAUSTED" :
    uninformative >= p.maxUninformative ? "MARGINAL_EVIDENCE_EXHAUSTED" : null;
  return { gear, reason, maxParallel: Math.min(s.frontier.maxParallel, gear === 1 ? 1 : gear === 2 ? 2 : s.frontier.maxParallel),
    stop, informativeProtocols: known.size, trailingUninformative: uninformative, measuredMs, unknownDurations,
    trust: "ALLOCATION_HEURISTIC_NOT_ACCEPTANCE" };
}

/** Small retirement-friendly dossier of checked records. Deduplicate semantic
 * outcomes while preserving contradictions and exact provenance references. */
export function researchDossier(observations: StrategyObservation[], limit = 8) {
  const unique = new Map<string, StrategyObservation>();
  for (const o of observations) {
    const key = digest({ candidate: o.candidate, spec: o.assessment.specHash, result: o.assessment.resultHash,
      outcome: o.assessment.outcome, conflicted: !!o.assessment.conflicted });
    if (!unique.has(key)) unique.set(key, o);
  }
  const records = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b));
  // Counterevidence stays visible even after many positive results.
  records.sort(([, a], [, b]) => Number(!a.assessment.conflicted && a.assessment.outcome !== "REFUTED") -
    Number(!b.assessment.conflicted && b.assessment.outcome !== "REFUTED"));
  return { trust: "CHECKED_OBSERVATIONS_WITH_ASSUMPTIONS_NOT_PLAN_ACCEPTANCE", total: records.length,
    omitted: Math.max(0, records.length - limit), evidenceHash: digest(records.map(([key]) => key).sort()),
    records: records.slice(0, limit).map(([, o]) => ({ candidate: o.candidate, sourceKey: o.key, receipt: digest(o.assessment),
      specHash: o.assessment.specHash, resultHash: o.assessment.resultHash,
      outcome: o.assessment.outcome, conflicted: !!o.assessment.conflicted })) };
}
