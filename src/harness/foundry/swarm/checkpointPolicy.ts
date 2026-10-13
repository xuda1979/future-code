import { digest } from "../kernel.ts";
import type { ThreadState } from "./session.ts";

const emptyPatch = digest("");
/** Shared binding for diagnostics and submission preflights. Thread ownership
 * separately pins the task, dependency capsule, base commit, and configuration. */
export function threadInputKey(state: ThreadState): string {
  return digest({ patchHash: state.patchHash ?? emptyPatch, feedbackHash: state.feedbackHash,
    jobReceipt: state.lastJobReceipt ?? null, spawnReceipt: state.lastSpawnReceipt ?? null });
}
export const evaluationEvidenceKey = (s: ThreadState): string => digest({
  feedback: s.feedbackHash, job: s.lastJobReceipt ?? null, children: s.lastSpawnReceipt ?? null,
});

/** Advisory, exploratory work only. Does not bypass host acceptance or integration. */
export function checkpointInputKey(patchHash: string | null, feedbackRevision: number, evidenceHash?: string): string {
  return digest({ patchHash, feedbackRevision, ...(evidenceHash ? { evidenceHash } : {}) });
}
export function shouldRunExploratoryCheckpoint(previousKey: string | undefined,
  currentKey: string, cadence?: "periodic" | "on-change"): boolean {
  return cadence === "periodic" || previousKey !== currentKey;
}

/** Optional operator-declared test impact index. This can only suppress an
 * automatic *exploratory* checkpoint, never a tool-requested check, task
 * acceptance, or final integration. Unknown inputs conservatively run it. */
export function canSliceExploratoryCheckpoint(
  changedPaths: readonly string[] | undefined,
  diagnosticPaths: readonly string[] | undefined,
  cadence?: "periodic" | "on-change",
  hasFeedback = false,
  hasJobEvidence = false,
): boolean {
  if (cadence === "periodic" || hasFeedback || hasJobEvidence ||
      !diagnosticPaths?.length || !changedPaths?.length) return false;
  // Prefixes are operator-configured and validated when the swarm is pinned.
  // Reverted/unknown changes and backends without path evidence run the check.
  return changedPaths.every(file => !diagnosticPaths.some(prefix =>
    file === prefix || file.startsWith(prefix + "/")));
}
