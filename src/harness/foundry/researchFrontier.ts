import { digest, invariant } from "./kernel.ts";
import { hash, type ResearchOutcome } from "./research.ts";
import { validateResearchStrategy, type ResearchStrategy, type StrategyObservation } from "./researchStrategy.ts";

export type FrontierState = "ELIGIBLE" | "ASSIGNED" | "FAILED" | "OBSERVED" | "WAITING" |
  "INVALIDATED" | "REFUTED" | "CONFLICTED" | "STALLED";
export interface FrontierLine { visits: number; informative: number; inconclusive: number }
export interface FrontierInput { pending?: string[]; failed?: string[]; costs?: Record<string, number | null> }

/** A bounded bandit portfolio over the operator's hypothesis DAG. This is not
 * MCTS or a probability that a hypothesis is true. A negative result can be as
 * informative as a positive one. Only independently accepted observations may
 * enter this function from a runtime adapter. */
export function selectResearchFrontier(s: ResearchStrategy, observations: StrategyObservation[], committed: number,
  input: FrontierInput = {}) {
  validateResearchStrategy(s); invariant(s.frontier, "research frontier is not configured");
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
    const result = !conflictedLines.has(c.line) && (c.after ?? []).every(a => {
      const values = outcomes.get(a.candidate);
      return evidenceValid(a.candidate) && !!values?.size && [...values].every(v => a.outcomes.includes(v));
    });
    valid.set(id, result); return result;
  };
  const impossible = new Map<string, boolean>();
  const invalidated = (id: string): boolean => {
    if (impossible.has(id)) return impossible.get(id)!;
    const result = (byId.get(id)!.after ?? []).some(a => invalidated(a.candidate) ||
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
  const room = Math.max(0, Math.min(s.frontier.maxParallel - pending.size, s.maxExperiments - committed));
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
  candidates.sort((a, b) => purpose[a.purpose] - purpose[b.purpose] || scores[b.id] - scores[a.id] ||
    cost(a.id) - cost(b.id) || order.get(a.id)! - order.get(b.id)!);
  for (const c of candidates) {
    if (batch.length >= room) break;
    if (occupied.has(c.line)) continue;
    occupied.add(c.line); batch.push(c.id);
  }
  return { next: batch[0] ?? null, batch, reason: committed >= s.maxExperiments ? "EXPERIMENT_BUDGET_EXHAUSTED" :
    room === 0 ? "FRONTIER_AT_CAPACITY" : batch.length ? "EVIDENCE_DRIVEN_PARALLEL_FRONTIER" : "NO_ELIGIBLE_EXPERIMENT",
    states, lines, scores, evidenceHash: digest([...unique.keys()].sort()) };
}
