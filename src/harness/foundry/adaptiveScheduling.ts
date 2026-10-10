import { digest } from "./kernel.ts";
import { taskExperienceSignature } from "./evidenceFabric.ts";
import type { Store } from "./store.ts";
import type { Recipe, Task } from "./types.ts";

/**
 * Experience-conditioned critical-path scheduling (opt-in for long DAGs).
 *
 * Execution evidence is produced by the independent verifier and measured by
 * the host. Never use model-predicted durations as learned observations.
 * Historical data is advice for ORDERING ONLY, never for admission or PASS.
 */
export const ADAPTIVE_MIN_TASKS = 8;
const MAX_HISTORY_ROWS = 2048;
const MAX_PER_SIGNATURE = 9;
const MIN_OBSERVATIONS = 3;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface DurationHints {
  tasks: Task[];
  matchedTasks: number;
  learnedSignatures: number;
  usedObservations: number;
}

/** Geometrically spaced recomputations: 3, 6, 12, 24 ... accepted tasks.
 * This bounds reindexing to O(log N) per long run, rather than one rebuild
 * (and a full-DAG scan) per completed task. */
export function shouldRerankAfter(accepted: number): boolean {
  if (!Number.isSafeInteger(accepted) || accepted < MIN_OBSERVATIONS ||
      accepted % MIN_OBSERVATIONS !== 0) return false;
  const ratio = accepted / MIN_OBSERVATIONS;
  return Number.isInteger(Math.log2(ratio));
}

/**
 * One capped SQL history query, independent of DAG width. Do not infer
 * evidence from unverified tasks, different execution contracts, stale
 * observations, failed attempts or LLM-generated task metadata.
 */
export function learnedDurationHints(store: Store, tasks: readonly Task[],
  recipe: Recipe, now = Date.now()): DurationHints {
  const unchanged = (): DurationHints => ({
    tasks: [...tasks], matchedTasks: 0, learnedSignatures: 0, usedObservations: 0,
  });
  if (recipe.scheduling !== "adaptive-critical-path" || tasks.length < ADAPTIVE_MIN_TASKS) return unchanged();

  const domain = store.getMeta<string>("extension.evidenceDomain") ?? "software-engineering";
  const signatures = new Map<string, string>();
  for (const task of tasks) if (task.estimatedDurationMs === undefined) {
    signatures.set(task.id, taskExperienceSignature(task, domain));
  }
  if (!signatures.size) return unchanged();

  const needed = new Set(signatures.values());
  const samples = new Map<string, number[]>();
  const maxObservedMs = recipe.timeoutMs * recipe.attempts;
  const rows = store.db.prepare(`SELECT e.signature, e.duration
    FROM fabric_experience e
    JOIN runs r ON r.id=e.run
    JOIN tasks t ON t.run=e.run AND t.id=e.task
    WHERE r.contract=? AND e.domain=? AND e.outcome='PASS'
      AND e.evidence_strength>=1 AND t.status='PASS'
      AND t.artifact IS NOT NULL AND t.evidence IS NOT NULL
      AND e.duration>=1 AND e.created>=?
    ORDER BY e.created DESC,e.id DESC LIMIT ?`)
    .all(digest(store.contract()), domain, now - MAX_AGE_MS, MAX_HISTORY_ROWS);
  for (const row of rows) {
    const signature = String(row.signature);
    if (!needed.has(signature)) continue;
    const duration = Number(row.duration);
    if (!Number.isFinite(duration) || duration > maxObservedMs) continue;
    const list = samples.get(signature) ?? [];
    if (list.length < MAX_PER_SIGNATURE) list.push(duration);
    samples.set(signature, list);
  }
  const medians = new Map<string, number>();
  let usedObservations = 0;
  for (const [signature, durations] of samples) {
    if (durations.length < MIN_OBSERVATIONS) continue;
    // Median is robust to a single extremely slow experiment/retry.
    const ordered = durations.slice().sort((a, b) => a - b);
    medians.set(signature, Math.max(1, Math.round(ordered[Math.floor(ordered.length / 2)])));
    usedObservations += durations.length;
  }
  let matchedTasks = 0;
  const predicted = tasks.map(task => {
    const signature = signatures.get(task.id);
    const duration = signature === undefined ? undefined : medians.get(signature);
    if (duration === undefined) return task;
    matchedTasks++;
    return { ...task, estimatedDurationMs: duration };
  });
  return { tasks: predicted, matchedTasks, learnedSignatures: medians.size, usedObservations };
}
