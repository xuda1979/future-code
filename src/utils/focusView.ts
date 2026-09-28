/**
 * /focus view filtering.
 *
 * Zero-dependency leaf module so the filter is unit-testable under the Node
 * test suite (tests/commands) — Messages.tsx itself is not Node-importable
 * (bun:bundle + .js-specifier runtime imports).
 */

export type FocusFilterableMessage = {
  type: string
  subtype?: string
  isMeta?: boolean
  message?: {
    role?: string
    content: Array<{ type: string }>
  }
}

/**
 * /focus view: keep only the latest exchange — everything from the most
 * recent human prompt onward — plus compact summaries that carry the
 * running narrative. Older turns stay in the transcript (ctrl+o) and in
 * the model's context; nothing is deleted from the conversation.
 */
export function filterForFocusView<
  T extends FocusFilterableMessage,
>(messages: T[]): T[] {
  // Index of the last real user prompt. Meta messages and tool-result
  // turns are not prompts — they belong to the running exchange and must
  // not reset the boundary.
  let lastPromptIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type !== 'user' || msg.isMeta) continue
    const block = msg.message?.content?.[0]
    if (block?.type === 'tool_result') continue
    lastPromptIndex = i
    break
  }
  return messages.filter((msg, i) => {
    // Compact summaries always stay visible — they are the narrative
    // header of the visible transcript in focus view too.
    if (msg.type === 'system' && msg.subtype === 'compact') return true
    return lastPromptIndex === -1 || i >= lastPromptIndex
  })
}
