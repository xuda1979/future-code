import { digest, invariant } from "../kernel.ts";
import type { Json } from "../types.ts";
import type { AgentProfile, PinnedSwarm } from "./config.ts";
import type { Call } from "./context.ts";
import { threadInputKey } from "./checkpointPolicy.ts";
import type { ThreadState } from "./session.ts";

export interface EvaluationObservation {
  inputKey: string;
  evidenceKey: string;
  receipt: string;
  turn: number;
  at: number;
  passed: boolean;
}
export const evaluationEvidenceKey = (s: ThreadState): string => digest({
  feedback: s.feedbackHash, job: s.lastJobReceipt ?? null, children: s.lastSpawnReceipt ?? null,
});

/** Only a completed, permitted run_check is an evaluation. A prose note,
 * micro-probe, other named check, or a source-mutating command cannot stand in
 * for the selected check on the current source/evidence. */
export function recordEvaluation(s: ThreadState, call: Call, result: Json,
  receipt: string, beforePatch: string | null, admitted: boolean): void {
  if (!admitted || call.name !== "run_check") return;
  const v = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, Json> : {};
  const sourceUnchanged = (beforePatch ?? digest("")) === (s.patchHash ?? digest(""));
  (s.evaluations ??= {})[String(call.arguments.name)] = {
    inputKey: threadInputKey(s), evidenceKey: evaluationEvidenceKey(s), receipt,
    turn: s.turns, at: Date.now(),
    passed: sourceUnchanged && v.code === 0 && !v.error,
  };
}

export function checkpointReason(s: ThreadState, cfg: PinnedSwarm, profile: AgentProfile,
  now = Date.now()): "new-evidence" | "turn-budget" | "interval" | null {
  const policy = cfg.spec.supervision;
  if (!policy || s.turns === 0) return null;
  const observed = s.evaluations?.[profile.checkpointCheck ?? profile.checks[0]!];
  if (policy.checkpointAfterEvidence !== false &&
      (s.feedbackHash || s.lastJobReceipt || s.lastSpawnReceipt) &&
      observed?.evidenceKey !== evaluationEvidenceKey(s)) return "new-evidence";
  if (s.turns - (observed?.turn ?? 0) >= (policy.checkpointEveryTurns ?? 4)) return "turn-budget";
  if (now - (observed?.at ?? s.evaluationStartedAt ?? now) >= policy.checkpointEveryMs) return "interval";
  return null;
}

/** Existing identities always reconcile. This gate applies only before the
 * first durable intent of a new external effect, including batched calls. */
export function admitJobEvaluation(s: ThreadState, cfg: PinnedSwarm, call: Call,
  existingSubmission: boolean): void {
  if (call.name !== "run_job" || existingSubmission) return;
  const required = cfg.spec.jobs?.[String(call.arguments.name)]?.preflightChecks ?? [];
  const key = threadInputKey(s);
  const missing = required.filter(name => {
    const observed = s.evaluations?.[name];
    return !observed?.passed || observed.inputKey !== key;
  });
  invariant(!missing.length,
    `EVALUATION_REQUIRED: run_check must pass on the current source and evidence before a new ${call.arguments.name} job: ${missing.join(", ")}. Diagnose failed checks, repair, and re-evaluate; existing jobs remain reconcilable.`);
}
