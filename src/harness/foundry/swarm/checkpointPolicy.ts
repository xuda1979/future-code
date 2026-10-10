import { digest } from "../kernel.ts";

/** Advisory, exploratory work only. Does not bypass host acceptance or integration. */
export function checkpointInputKey(patchHash: string | null, feedbackRevision: number, evidenceHash?: string): string {
  return digest({ patchHash, feedbackRevision, ...(evidenceHash ? { evidenceHash } : {}) });
}
export function shouldRunExploratoryCheckpoint(previousKey: string | undefined,
  currentKey: string, cadence?: "periodic" | "on-change"): boolean {
  return cadence === "periodic" || previousKey !== currentKey;
}
