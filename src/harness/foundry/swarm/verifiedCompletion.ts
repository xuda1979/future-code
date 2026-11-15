import { digest } from "../kernel.ts";
import type { Json, Verification } from "../types.ts";
import type { AgentProfile } from "./config.ts";
import type { ThreadState } from "./session.ts";
import { threadInputKey } from "./checkpointPolicy.ts";

export interface CompletionProbe {
  materialKey: string;
  status: "UNKNOWN" | "PASS" | "FAIL";
  receipt?: string;
}
export type CompletionState = Pick<ThreadState, "patchHash" | "lastJobReceipt" | "lastSpawnReceipt" |
  "feedbackHash" | "pending" | "pendingBatch" | "decisions" | "debugging" | "completionProbe">;
const emptyPatch = digest("");

/** Material identity deliberately excludes verifier feedback, timers and
 * model notes. Additional authoritative evidence is supplied by the host. */
export function completionMaterialKey(state: Pick<CompletionState, "patchHash" | "lastJobReceipt" | "lastSpawnReceipt">,
  externalEvidence: Json | null = null): string {
  return digest({ patch: state.patchHash ?? emptyPatch, job: state.lastJobReceipt ?? null,
    children: state.lastSpawnReceipt ?? null, externalEvidence });
}

/** Pure admission predicate. The callback must authenticate a current passing
 * result receipt; neither a model declaration nor these observations accept
 * the candidate. A separate fresh full verifier is still mandatory. */
export function eligibleVerifiedCompletion(profile: Pick<AgentProfile, "completionPolicy" | "checks">,
  state: CompletionState, passingReceipt: (hash: string) => boolean,
  externalEvidence: Json | null = null): { materialKey: string; receipts: string[] } | null {
  if (profile.completionPolicy !== "verified-checks" || !profile.checks.length || state.pending || state.pendingBatch?.length ||
      state.decisions?.review || state.debugging?.audit || state.debugging?.probeRequired) return null;
  // Capability-only or unchanged tasks retain their ordinary summary path.
  if ((!state.patchHash || state.patchHash === emptyPatch) && !state.lastJobReceipt && !state.lastSpawnReceipt) return null;
  const materialKey = completionMaterialKey(state, externalEvidence);
  if (state.completionProbe?.materialKey === materialKey) return null;
  // threadInputKey reads exactly this structural subset. Keep diagnostic/check
  // currentness shared with existing host observations, including feedback.
  const current = threadInputKey(state as ThreadState);
  const receipts: string[] = [];
  for (const name of profile.checks) {
    const observation = state.decisions?.measurements[name];
    if (!observation || observation.name !== name || observation.code !== 0 || observation.inputKey !== current ||
        !passingReceipt(observation.receipt)) return null;
    receipts.push(observation.receipt);
  }
  return { materialKey, receipts };
}

/** A full task verifier must bind the exact descriptor, supply every required
 * check once, and return no additional FAIL/UNKNOWN/INVALID checks. */
export function fullCompletionVerificationPassed(required: readonly string[], artifact: Json, verification: Verification): boolean {
  if (verification?.artifactHash !== digest(artifact) || !Array.isArray(verification.checks) || !required.length) return false;
  const ids = new Set<string>();
  for (const check of verification.checks) {
    if (!check || typeof check.id !== "string" || ids.has(check.id) || check.verdict !== "PASS") return false;
    ids.add(check.id);
  }
  return required.every(name => ids.has(name));
}
