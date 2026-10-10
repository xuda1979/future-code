import { MAX_TOOL_RESULTS_PER_MESSAGE_CHARS } from '../constants/toolLimits.ts'

/** Host defaults also work without a remote feature service. */
export function toolResultBudgetEnabled(
  remoteValue: unknown,
  disable = process.env.FUTURE_CODE_DISABLE_TOOL_RESULT_BUDGET,
): boolean {
  return disable !== '1' && remoteValue !== false
}

export function toolResultBudgetLimit(
  remoteValue: unknown,
  configured = process.env.FUTURE_CODE_TOOL_RESULT_BUDGET_CHARS,
): number {
  const local = configured?.trim() ? Number(configured) : NaN
  if (Number.isSafeInteger(local) && local >= 8_000 && local <= 1_000_000) {
    return local
  }
  if (typeof remoteValue === 'number' && Number.isFinite(remoteValue) && remoteValue > 0) {
    return remoteValue
  }
  return MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
}

/** Preserve previous decisions; offload only fresh results that get smaller. */
export function selectToolResultsForBudget<T extends { size: number }>(
  fresh: readonly T[],
  frozenSize: number,
  limit: number,
  previewSize: number,
): T[] {
  let remaining = frozenSize + fresh.reduce((sum, result) => sum + result.size, 0)
  const selected: T[] = []
  for (const result of [...fresh].sort((a, b) => b.size - a.size)) {
    if (remaining <= limit) break
    // Small outputs cost more as references. Accept an overage rather than
    // do extra disk I/O and enlarge the model payload.
    if (result.size <= previewSize) continue
    selected.push(result)
    remaining -= result.size - previewSize
  }
  return selected
}
