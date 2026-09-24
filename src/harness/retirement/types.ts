/**
 * Context-retirement mechanism study: shared types.
 *
 * This module answers a mechanism question, not an LLM-productivity
 * question: when a context policy retires history, what information
 * does the next call still receive, what must be re-fetched, and what
 * does the policy lose? No hosted model is called; every byte below is
 * measured on a deterministic, seeded episode stream.
 */

/** A fact the project state emits; every arm sees the same stream. */
export interface EpisodeFact {
  /** Stable gate/component identity, e.g. "gate-17". */
  id: string;
  /** True only when the fact's binding is currently verified. */
  verified: boolean;
  /** Bytes to state the fact in the submitted context. */
  bytes: number;
  /** Gate indices this fact's value depends on (coupling). */
  dependsOn: readonly number[];
  /** True if this fact is an unresolved obligation at emission time. */
  obligation: boolean;
}

/** One episode: a set of invalidated gates and the facts that arrive. */
export interface Episode {
  index: number;
  /** Gate indices whose bindings changed this episode (the invalidation set). */
  invalidated: readonly number[];
  /** Facts arriving this episode (fresh observations, obligations). */
  facts: readonly EpisodeFact[];
  /** Gate indices the episode's task requires reading to act correctly. */
  requiredReads: readonly number[];
  /** True if the episode's task must resolve a pending obligation. */
  needsObligation: boolean;
  /** Dependency footprint (frozen D=12): interfaces the working phase reads. */
  footprint: readonly number[];
}

/** Per-run outcome under the frozen acceptance contract. */
export interface RunResult {
  arm: string;
  seed: number;
  size: number;
  family: string;
  /** Submitted context bytes across all calls. */
  contextBytes: number;
  /** On-demand retrieval bytes (the retrieval tax). */
  retrievalBytes: number;
  /** Calls whose context held a stale binding for a required read. */
  stalenessDefects: number;
  /** Obligations dropped from active context before resolution. */
  obligationLoss: number;
  /** True iff acceptance contract satisfied (no staleness, all obligations resolved, evidence complete). */
  accepted: boolean;
  /** Episodes from start to final acceptance. */
  makespanEpisodes: number;
  /** Evidence-layout bytes over the run (HACT vs flat ablation). */
  evidenceBytes: number;
  /** Number of model-facing calls made. */
  calls: number;
  /** On-demand fetch round trips (co-primary; a live fetch is a tool call). */
  retrievalOps: number;
  /** Makespan in scheduler rounds (adaptive batching vs fixed). */
  makespanRounds: number;
}

/** Frozen arm configuration. */
export interface ArmSpec {
  name: string;
  /** Context policy identifier; see arms.ts. */
  policy: string;
}
