import { digest, invariant } from "./kernel.ts";
import { hash, type ResearchOutcome } from "./research.ts";
import { validateResearchStrategy, type ResearchStrategy, type StrategyObservation } from "./researchStrategy.ts";
import { validateTheoryGraph, type TheoryGraph } from "./theory.ts";
import { experimentalDesign } from "./experimentDesign.ts";
import { selectExperimentBatch } from "./experimentBatch.ts";

export type FrontierState = "ELIGIBLE" | "ASSIGNED" | "FAILED" | "OBSERVED" | "WAITING" |
  "INVALIDATED" | "REFUTED" | "CONFLICTED" | "STALLED";
export interface FrontierLine { visits: number; informative: number; inconclusive: number }
export interface FrontierInput {
  pending?: string[]; failed?: string[]; costs?: Record<string, number | null>;
  /** Host-derived from exact frozen protocols; never worker-authored scores. */
  theory?: TheoryGraph;
}

/** A bounded bandit portfolio over the operator's hypothesis DAG. This is not
 * MCTS or a probability that a hypothesis is true. A negative result can be as
 * informative as a positive one. Only independently accepted observations may
 * enter this function from a runtime adapter. */
export function selectResearchFrontier(s: ResearchStrategy, observations: StrategyObservation[], committed: number,
  input: FrontierInput = {}) {
  validateResearchStrategy(s); invariant(s.frontier, "research frontier is not configured");
  const theory = input.theory ?? {}; validateTheoryGraph(s, theory);
  invariant(Number.isSafeInteger(committed) && committed >= 0, "invalid experiment consumption");
  const byId = new Map(s.candidates.map(c => [c.id, c]));
  const pending = new Set(input.pending ?? []), failed = new Set(input.failed ?? []);
  for (const id of [...pending, ...failed]) invariant(byId.has(id), "unknown frontier assignment");
  const keys = new Map<string, string>(), unique = new Map<string, StrategyObservation>();
  const outcomes = new Map<string, Set<ResearchOutcome>>(), conflictedLines = new Set<string>(), refutedLines = new Set<string>();
  const protocols = new Map<string, Set<ResearchOutcome>>();
  for (const o of observations) {
    const c = byId.get(o.candidate); invariant(c && typeof o.key === "string" && o.key.length > 0, "unknown frontier observation");
    hash(o.assessment.specHash); hash(o.assessment.resultHash);
    invariant(["SUPPORTED", "REFUTED", "INCONCLUSIVE"].includes(o.assessment.outcome), "invalid frontier outcome");
    const node = theory[c.id];
    if (node) invariant(o.assessment.specHash === node.specHash && o.assessment.theory?.targetHash === node.targetHash &&
      (o.assessment.outcome !== "SUPPORTED" || o.assessment.theory.status === "ESTABLISHED"), "frontier requires exact deductive evidence");
    const binding = digest({ candidate: o.candidate, assessment: o.assessment });
    invariant(!keys.has(o.key) || keys.get(o.key) === binding, "frontier observation replay drift"); keys.set(o.key, binding);
    // Receipt IDs and execution counts are not novelty rewards. Replaying the
    // same checked result under another source cannot inflate visits or reward.
    unique.set(digest({ candidate: o.candidate, spec: o.assessment.specHash, result: o.assessment.resultHash,
      outcome: o.assessment.outcome, conflicted: !!o.assessment.conflicted }), o);
    const set = outcomes.get(c.id) ?? new Set(); set.add(o.assessment.outcome); outcomes.set(c.id, set);
    const protocol = `${c.line}:${o.assessment.specHash}`, values = protocols.get(protocol) ?? new Set();
    values.add(o.assessment.outcome); protocols.set(protocol, values);
    if (o.assessment.conflicted || (set.has("SUPPORTED") && set.has("REFUTED")) ||
      (values.has("SUPPORTED") && values.has("REFUTED"))) conflictedLines.add(c.line);
    if (s.stopOnRefutation && o.assessment.outcome === "REFUTED") refutedLines.add(c.line);
  }
  const lines: Record<string, FrontierLine> = Object.fromEntries(s.candidates.map(c => [c.line, { visits: 0, informative: 0, inconclusive: 0 }]));
  const novelty = new Map<string, Set<string>>();
  for (const o of unique.values()) {
    const line = byId.get(o.candidate)!.line, stats = lines[line]; stats.visits++;
    if (o.assessment.outcome === "INCONCLUSIVE") stats.inconclusive++;
    else if (!o.assessment.conflicted) {
      const known = novelty.get(line) ?? new Set(); known.add(`${o.assessment.specHash}:${o.assessment.outcome}`); novelty.set(line, known);
      stats.informative = known.size;
    }
  }
  // A rejected prerequisite invalidates the strategy descendants even when a
  // descendant has an older accepted result. A declared REFUTED-conditioned
  // alternative remains legal; a conflict never satisfies a condition.
  const valid = new Map<string, boolean>();
  const evidenceValid = (id: string): boolean => {
    if (valid.has(id)) return valid.get(id)!;
    const c = byId.get(id)!;
    const result = !conflictedLines.has(c.line) && (theory[id]?.premises ?? []).every(p =>
      evidenceValid(p) && outcomes.get(p)?.size === 1 && outcomes.get(p)!.has("SUPPORTED")) && (c.after ?? []).every(a => {
      const values = outcomes.get(a.candidate);
      return evidenceValid(a.candidate) && !!values?.size && [...values].every(v => a.outcomes.includes(v));
    });
    valid.set(id, result); return result;
  };
  const impossible = new Map<string, boolean>();
  const invalidated = (id: string): boolean => {
    if (impossible.has(id)) return impossible.get(id)!;
    const result = (theory[id]?.premises ?? []).some(p => invalidated(p) ||
      conflictedLines.has(byId.get(p)!.line) || outcomes.get(p)?.has("REFUTED")) ||
      (byId.get(id)!.after ?? []).some(a => invalidated(a.candidate) ||
      conflictedLines.has(byId.get(a.candidate)!.line) ||
      (outcomes.has(a.candidate) && (!evidenceValid(a.candidate) || [...outcomes.get(a.candidate)!].some(v => !a.outcomes.includes(v)))));
    impossible.set(id, result); return result;
  };
  const occupied = new Set([...pending].map(id => byId.get(id)!.line));
  const states: Record<string, FrontierState> = {};
  for (const c of s.candidates) {
    states[c.id] = invalidated(c.id) ? "INVALIDATED" : conflictedLines.has(c.line) ? "CONFLICTED" :
      refutedLines.has(c.line) ? "REFUTED" : pending.has(c.id) ? "ASSIGNED" : failed.has(c.id) ? "FAILED" :
      outcomes.has(c.id) ? (evidenceValid(c.id) ? "OBSERVED" : "INVALIDATED") :
      !evidenceValid(c.id) || occupied.has(c.line) ? "WAITING" :
      lines[c.line].inconclusive >= s.frontier.maxInconclusivePerLine ? "STALLED" : "ELIGIBLE";
  }
  const batch: string[] = [], scores: Record<string, number> = {};
  // Prefer a shared missing lemma over an unrelated deduction of the same
  // purpose. Count still-open transitive dependents once, including diamonds.
  const descendants = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  if (Object.keys(theory).length) for (const c of s.candidates) for (const dep of
    [...(theory[c.id]?.premises ?? []), ...(c.after ?? []).map(a => a.candidate)]) {
    const ids = children.get(dep) ?? new Set<string>(); ids.add(c.id); children.set(dep, ids);
  }
  const downstream = (id: string): Set<string> => {
    if (descendants.has(id)) return descendants.get(id)!;
    const ids = new Set<string>();
    for (const child of children.get(id) ?? []) {
      if (["WAITING", "ELIGIBLE"].includes(states[child]) ||
        (states[child] === "ASSIGNED" && theory[child] && !evidenceValid(child))) ids.add(child);
      for (const next of downstream(child)) ids.add(next);
    }
    descendants.set(id, ids); return ids;
  };
  const unlocks = Object.fromEntries(s.candidates.map(c => [c.id, downstream(c.id).size]));
  // A mandatory theorem may reserve the final result before its lemmas exist.
  // Keep that budget reservation, but let its dormant proof slot be used by
  // prerequisites. The authoritative scheduler still bounds live workers.
  const activeAssignments = [...pending].filter(id => !theory[id] || evidenceValid(id)).length;
  const room = Math.max(0, Math.min(s.frontier.maxParallel - activeAssignments, s.maxExperiments - committed));
  const total = Object.values(lines).reduce((n, line) => n + line.visits, 0);
  const purpose = { falsification: 0, replication: 1, exploration: 2 };
  const cost = (id: string) => {
    const value = input.costs?.[id]; return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Infinity;
  };
  const candidates = s.candidates.filter(c => states[c.id] === "ELIGIBLE");
  for (const c of candidates) {
    const line = lines[c.line];
    scores[c.id] = line.informative / Math.max(1, line.visits) +
      s.frontier.explorationWeight * Math.sqrt(Math.log(total + 2) / (line.visits + 1));
  }
  const order = new Map(s.candidates.map((c, i) => [c.id, i]));
  const designObservations = s.design ? [...unique.values()].filter(o => evidenceValid(o.candidate)) : [];
  const design = s.design ? { ...experimentalDesign(s, designObservations, input.costs, conflictedLines.size > 0),
    excludedObservations: unique.size - designObservations.length } : undefined;
  candidates.sort((a, b) => purpose[a.purpose] - purpose[b.purpose] || unlocks[b.id] - unlocks[a.id] ||
    (design ? (design.candidates[b.id].bitsPerMs ?? 0) - (design.candidates[a.id].bitsPerMs ?? 0) : 0) || scores[b.id] - scores[a.id] ||
    cost(a.id) - cost(b.id) || order.get(a.id)! - order.get(b.id)!);
  let batchDesign: ReturnType<typeof selectExperimentBatch> | undefined;
  if (design?.status === "READY") {
    let priority = 0;
    const ranked = candidates.map((c, i) => {
      const previous = candidates[i - 1];
      if (previous && (previous.purpose !== c.purpose || unlocks[previous.id] !== unlocks[c.id])) priority++;
      return { id: c.id, line: c.line, priority, costMs: design.candidates[c.id].costMs };
    });
    // Only unobserved, live assignments contribute expected future evidence.
    // Dormant proofs, invalidated work and known results cannot reserve information.
    const conditioning = [...pending].filter(id => states[id] === "ASSIGNED" && !outcomes.has(id));
    batchDesign = selectExperimentBatch(s, design.posterior!, ranked, room, conditioning);
    batch.push(...batchDesign.batch);
  } else if (!design) for (const c of candidates) {
    if (batch.length >= room) break;
    if (occupied.has(c.line)) continue;
    occupied.add(c.line); batch.push(c.id);
  }
  return { next: batch[0] ?? null, batch, reason: committed >= s.maxExperiments ? "EXPERIMENT_BUDGET_EXHAUSTED" :
    room === 0 ? "FRONTIER_AT_CAPACITY" : design && design.status !== "READY" ? `EXPERIMENT_DESIGN_${design.status}` :
    batch.length ? "EVIDENCE_DRIVEN_PARALLEL_FRONTIER" : batchDesign &&
      ["STATE_LIMIT", "LIKELIHOOD_TERM_LIMIT"].includes(batchDesign.stopReason) ? `EXPERIMENT_DESIGN_BATCH_${batchDesign.stopReason}` : "NO_ELIGIBLE_EXPERIMENT",
    states, lines, scores, unlocks, activeAssignments, proofStates: Object.fromEntries(Object.keys(theory).map(id => [id,
      states[id] === "OBSERVED" ? (outcomes.get(id)?.has("REFUTED") ? "REFUTED" :
        outcomes.get(id)?.has("SUPPORTED") ? "ESTABLISHED" : "OPEN") : states[id]])),
    evidenceHash: digest([...unique.keys()].sort()), ...(design ? { design: { ...design, ...(batchDesign ? { batch: batchDesign } : {}) } } : {}) };
}
