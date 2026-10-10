// Operating target for long goal runs, separate from the provider hard limit.
// Summarization still uses the existing durable compaction/restore pipeline.
export const DEFAULT_WORKING_CONTEXT_TOKENS = 64_000
export function workingContextThreshold(hardThreshold: number, activeGoal: boolean,
  override = process.env.FUTURE_CODE_WORKING_CONTEXT_TOKENS): number {
  if (!activeGoal) return hardThreshold
  const n = Number(override)
  const target = Number.isSafeInteger(n) && n >= 16_000 && n <= 1_000_000 ? n : DEFAULT_WORKING_CONTEXT_TOKENS
  return Math.min(hardThreshold, target)
}
