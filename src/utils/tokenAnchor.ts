/**
 * Usage-anchor validation for context token accounting.
 *
 * Leaf module (no SDK/Bun imports) so the correctness gate can exercise it
 * under node --experimental-strip-types.
 */

export interface UsageLike {
  input_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens: number
}

export function sumUsage(usage: UsageLike): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  )
}

/**
 * A usage object is a valid estimation anchor only when it carries a
 * positive total. Providers/proxies that do not report usage emit
 * all-zero usage fields on every response; anchoring on a zero total
 * makes the context look ~0 tokens, so autocompact and session-memory
 * thresholds never fire. The session then silently grows past the
 * model's real context window, which surfaces to users as recurring
 * empty end_turn responses (nothing renders, turn "completes").
 */
export function isUsableUsageAnchor(usage: UsageLike | undefined): boolean {
  return usage !== undefined && sumUsage(usage) > 0
}
