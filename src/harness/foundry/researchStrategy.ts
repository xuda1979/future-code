import { fields, type ResearchAssessment, type ResearchOutcome } from "./research.ts";
import { identifier, invariant } from "./kernel.ts";
import { validateExperimentDesign, type ExperimentDesign } from "./experimentDesign.ts";

export interface ResearchCandidate {
  id: string;
  template: string;
  line: string;
  purpose: "falsification" | "replication" | "exploration";
  after?: { candidate: string; outcomes: ResearchOutcome[] }[];
}
export interface ResearchStrategy {
  schema: 1;
  candidates: ResearchCandidate[];
  maxExperiments: number;
  maxSnapshotBytes: number;
  stopOnRefutation: boolean;
  /** Opt-in parallel hypothesis search. Scores allocate work, never certify truth. */
  frontier?: { maxParallel: number; explorationWeight: number; maxInconclusivePerLine: number };
  design?: ExperimentDesign;
}
export interface StrategyObservation {
  key: string;
  candidate: string;
  assessment: ResearchAssessment;
}
export function validateResearchStrategy(s: ResearchStrategy): void {
  fields(s, ["schema", "candidates", "maxExperiments", "maxSnapshotBytes", "stopOnRefutation"], ["frontier", "design"]);
  if (s.frontier !== undefined) {
    fields(s.frontier, ["maxParallel", "explorationWeight", "maxInconclusivePerLine"]);
    invariant(Number.isSafeInteger(s.frontier.maxParallel) && s.frontier.maxParallel > 0 && s.frontier.maxParallel <= 32 &&
      Number.isFinite(s.frontier.explorationWeight) && s.frontier.explorationWeight >= 0 && s.frontier.explorationWeight <= 8 &&
      Number.isSafeInteger(s.frontier.maxInconclusivePerLine) && s.frontier.maxInconclusivePerLine > 0 &&
      s.frontier.maxInconclusivePerLine <= 256, "invalid research frontier bounds");
  }
  const ceiling = s.frontier ? 256 : 32;
  invariant(s.schema === 1 && typeof s.stopOnRefutation === "boolean" && Array.isArray(s.candidates) &&
    s.candidates.length > 0 && s.candidates.length <= ceiling, "invalid research strategy");
  invariant(Number.isSafeInteger(s.maxExperiments) && s.maxExperiments > 0 && s.maxExperiments <= ceiling &&
    Number.isSafeInteger(s.maxSnapshotBytes) && s.maxSnapshotBytes >= 1024 && s.maxSnapshotBytes <= 65536, "unbounded research strategy");
  const candidates = new Map(s.candidates.map(c => [c.id, c]));
  invariant(candidates.size === s.candidates.length && new Set(s.candidates.map(c => c.template)).size === s.candidates.length,
    "duplicate strategy candidate/template");
  for (const c of s.candidates) {
    fields(c, ["id", "template", "line", "purpose"], ["after"]); [c.id, c.template, c.line].forEach(identifier);
    invariant(["falsification", "replication", "exploration"].includes(c.purpose), "unknown research purpose");
    if (c.after !== undefined) {
      invariant(Array.isArray(c.after) && c.after.length <= 32 && new Set(c.after.map(a => a.candidate)).size === c.after.length, "invalid strategy dependencies");
      for (const a of c.after) {
        fields(a, ["candidate", "outcomes"]);
        invariant(candidates.has(a.candidate) && a.candidate !== c.id && Array.isArray(a.outcomes) && a.outcomes.length > 0 &&
          new Set(a.outcomes).size === a.outcomes.length && a.outcomes.every(o => ["SUPPORTED", "REFUTED", "INCONCLUSIVE"].includes(o)), "invalid strategy condition");
      }
    }
  }
  const seen = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    invariant(!visiting.has(id), "cyclic research strategy"); if (seen.has(id)) return;
    visiting.add(id); for (const a of candidates.get(id)!.after ?? []) visit(a.candidate);
    visiting.delete(id); seen.add(id);
  };
  s.candidates.forEach(c => visit(c.id));
  validateExperimentDesign(s);
}

/** Advice from measured observations, not model-authored feasibility scores.
 * No task mutation, majority voting or relaxation of a frozen protocol occurs here. */
export function selectResearchStrategy(s: ResearchStrategy, observations: StrategyObservation[], used: number,
  unresolved: string[] = [], measuredCostMs: Record<string, number | null> = {}): {
    next: string | null; reason: string; blockedLines: string[]; observed: Record<string, ResearchOutcome[]>;
  } {
  validateResearchStrategy(s);
  invariant(Number.isSafeInteger(used) && used >= 0, "invalid experiment consumption");
  const byId = new Map(s.candidates.map(c => [c.id, c])), keys = new Map<string, string>();
  const outcomes = new Map<string, Set<ResearchOutcome>>();
  for (const o of observations) {
    invariant(byId.has(o.candidate) && typeof o.key === "string" && o.key.length > 0 &&
      ["SUPPORTED", "REFUTED", "INCONCLUSIVE"].includes(o.assessment.outcome), "unknown strategy observation");
    const binding = `${o.candidate}:${o.assessment.specHash}:${o.assessment.resultHash}:${o.assessment.outcome}`;
    invariant(!keys.has(o.key) || keys.get(o.key) === binding, "strategy observation replay drift"); keys.set(o.key, binding);
    const set = outcomes.get(o.candidate) ?? new Set(); set.add(o.assessment.outcome); outcomes.set(o.candidate, set);
  }
  const blocked = new Set<string>();
  for (const [id, values] of outcomes) if (observations.some(o => o.candidate === id && o.assessment.conflicted) || (values.has("SUPPORTED") && values.has("REFUTED")) ||
    (s.stopOnRefutation && values.has("REFUTED"))) blocked.add(byId.get(id)!.line);
  const observed = Object.fromEntries([...outcomes].map(([id, values]) => [id, [...values].sort()]));
  const result = (next: string | null, reason: string) => ({ next, reason, blockedLines: [...blocked].sort(), observed });
  if (used >= s.maxExperiments) return result(null, "EXPERIMENT_BUDGET_EXHAUSTED");
  const pendingLines = new Set(unresolved.map(id => { invariant(byId.has(id), "unknown unresolved candidate"); return byId.get(id)!.line; }));
  const eligible = s.candidates.filter(c => !outcomes.has(c.id) && !blocked.has(c.line) && !pendingLines.has(c.line) &&
    (c.after ?? []).every(a => outcomes.has(a.candidate) && [...outcomes.get(a.candidate)!].every(o => a.outcomes.includes(o))));
  const purpose = { falsification: 0, replication: 1, exploration: 2 };
  eligible.sort((a, b) => {
    const first = purpose[a.purpose] - purpose[b.purpose]; if (first) return first;
    const left = measuredCostMs[a.id], right = measuredCostMs[b.id];
    const bounded = (x: number | null | undefined) => typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : Infinity;
    return bounded(left) - bounded(right) || s.candidates.indexOf(a) - s.candidates.indexOf(b);
  });
  return result(eligible[0]?.id ?? null, eligible.length ? "FALSIFY_THEN_REPLICATE_THEN_EXPLORE" : "NO_ELIGIBLE_EXPERIMENT");
}
