import type { AgentProfile, PinnedSwarm } from "./config.ts";
import { evaluationEvidenceKey } from "./checkpointPolicy.ts";
import type { ThreadState } from "./session.ts";

/** An overdue write policy selects its declared measurement so an unrelated
 * checkpoint cannot strand the worker behind the admission gate. */
export function checkpointCheck(s: Pick<ThreadState, "decisions">, profile: AgentProfile): string {
  return s.decisions?.review?.measurementChecks[0] ?? profile.checkpointCheck ??
    profile.decisionPolicy?.measurementChecks[0] ?? profile.checks[0]!;
}

export function checkpointReason(s: ThreadState, cfg: PinnedSwarm, profile: AgentProfile,
  now = Date.now()): "measurement-due" | "new-evidence" | "turn-budget" | "interval" | null {
  const policy = cfg.spec.supervision;
  if (!policy || s.turns === 0) return null;
  if (s.decisions?.review) return "measurement-due";
  const observed = s.decisions?.measurements[checkpointCheck(s, profile)];
  if (policy.checkpointAfterEvidence !== false &&
      (s.feedbackHash || s.lastJobReceipt || s.lastSpawnReceipt) &&
      observed?.evidenceKey !== evaluationEvidenceKey(s)) return "new-evidence";
  if (s.turns - (observed?.atTurn ?? 0) >= (policy.checkpointEveryTurns ?? 4)) return "turn-budget";
  if (now - (observed?.at ?? s.evaluationStartedAt ?? now) >= policy.checkpointEveryMs) return "interval";
  return null;
}
