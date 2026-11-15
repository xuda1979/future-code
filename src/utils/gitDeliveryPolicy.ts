/** Request-local latency policy, never an execution grant or acceptance rule.
 * Fail open to normal reasoning for mixed, quoted or ambiguous requests. */
interface Message {
  type: string
  isMeta?: boolean
  isCompactSummary?: boolean
  toolUseResult?: unknown
  origin?: unknown
  message?: { content?: unknown }
}

export const GIT_DELIVERY_GUIDANCE = '[Git delivery scope]\n' +
  'The current human request is limited to Git delivery. Inspect the relevant status/diff and required checks, ' +
  'then stage the intended files, commit, and push only as requested. Stage before committing. ' +
  'Use existing check receipts only when they still match the exact candidate and the project permits reuse. ' +
  'Do not start unrelated exploration, repeat unchanged checks, delegate routine Git work, or expand the task. ' +
  'Keep hooks, signing, permissions and independent acceptance intact. ' +
  'After an uncertain commit/push outcome, reconcile local HEAD and the remote ref before retrying effects.'

export function isGitDeliveryRequest(text: string): boolean {
  if (text.length > 256) return false
  // An allowlist of complete short imperatives, not a keyword classifier.
  // Unknown words (fix, review, research, why, failure, etc.) keep normal depth.
  const words = text.toLowerCase().trim().replace(/[.!]$/, '').replace(/[,;&]+/g, ' ').split(/\s+/)
  const verbs = new Set(['add', 'stage', 'commit', 'push'])
  const filler = new Set(['please', 'just', 'now', 'git', 'and', 'then', 'all', 'the', 'these', 'my', 'our',
    'current', 'staged', 'unstaged', 'relevant', 'changed', 'changes', 'files', 'everything', 'them', 'it',
    'this', 'to', 'remote', 'repo', 'repository', 'github', 'origin', 'branch'])
  return verbs.has(words.find(word => !['please', 'just', 'now', 'git'].includes(word)) ?? '') &&
    words.every(word => verbs.has(word) || filler.has(word))
}

export function gitDeliveryPolicy(messages: readonly Message[], mainThread: boolean): boolean {
  if (!mainThread) return false
  // Host reminders and tool results cannot select a faster policy. Stop at
  // the latest real human input, including images or other non-text content.
  for (let i = messages.length - 1, n = 0; i >= 0 && n < 256; i--, n++) {
    const message = messages[i]!
    if (message.type !== 'user' || message.isMeta || message.isCompactSummary ||
      message.toolUseResult !== undefined || message.origin !== undefined) continue
    const content = message.message?.content
    if (typeof content === 'string') return isGitDeliveryRequest(content)
    if (!Array.isArray(content)) return false
    if (content.some(block => block?.type === 'tool_result')) continue
    if (!content.length || content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) return false
    return isGitDeliveryRequest(content.map(block => block.text).join('\n'))
  }
  return false
}

export function gitDeliveryModelTimeout(value = process.env.FUTURE_CODE_GIT_MODEL_TIMEOUT_MS): number {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 1000 && n <= 3_600_000 ? n : 120_000
}
