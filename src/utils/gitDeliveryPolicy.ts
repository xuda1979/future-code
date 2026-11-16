import { gitActivity, isShellObservation } from './shellActivity.ts'

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
  'You are handling Git delivery within the current authorized task. Inspect the relevant status/diff and required checks, ' +
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
    'this', 'code', 'to', 'remote', 'repo', 'repository', 'github', 'origin', 'branch'])
  return verbs.has(words.find(word => !['please', 'just', 'now', 'git'].includes(word)) ?? '') &&
    words.every(word => verbs.has(word) || filler.has(word))
}

/** Enter delivery after an actual foreground Git effect, including the final
 * phase of a mixed implementation request. Failed/unknown work releases the
 * latency policy for diagnosis/deep reasoning. Never execute or replay tools.
 * Read-only observations preserve the phase. Ambiguous batches release it. */
export function nextGitDeliveryPhase(previous: boolean,
  calls: readonly { id: string; name: string; input: unknown }[],
  results: readonly Message[],
): boolean {
  if (!calls.length) return previous
  const receipts = new Map<string, { failed: boolean; pending: boolean; count: number }>()
  for (const message of results) {
    const body = message.message?.content
    if (message.type !== 'user' || message.origin !== undefined || !Array.isArray(body)) continue
    const raw = message.toolUseResult as { backgroundTaskId?: unknown; interrupted?: unknown } | null
    const pending = Boolean(raw && typeof raw === 'object' && (raw.backgroundTaskId || raw.interrupted))
    for (const block of body) if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const old = receipts.get(block.tool_use_id)
      receipts.set(block.tool_use_id, { failed: block.is_error === true, pending, count: (old?.count ?? 0) + 1 })
    }
  }
  let delivered = false
  const ids = new Set<string>()
  for (const call of calls) {
    if (ids.has(call.id)) return false
    ids.add(call.id)
    const receipt = receipts.get(call.id)
    if (!receipt || receipt.count !== 1 || receipt.failed || receipt.pending) return false
    if (call.name === 'Bash') {
      const input = call.input as { command?: unknown; run_in_background?: unknown } | null
      if (!input || input.run_in_background) return false
      if (gitActivity(input.command) === 'deliver') { delivered = true; continue }
      if (isShellObservation(input.command)) continue
      return false
    }
    if (!['Read', 'Grep', 'Glob', 'TodoWrite', 'TaskGet', 'TaskList'].includes(call.name)) return false
  }
  return previous || delivered
}

function latestHumanText(messages: readonly Message[], mainThread: boolean): string | null {
  if (!mainThread) return null
  // Host reminders and tool results cannot select a faster policy. Stop at
  // the latest real human input, including images or other non-text content.
  for (let i = messages.length - 1, n = 0; i >= 0 && n < 256; i--, n++) {
    const message = messages[i]!
    if (message.type !== 'user' || message.isMeta || message.isCompactSummary ||
      message.toolUseResult !== undefined || message.origin !== undefined) continue
    const content = message.message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return null
    if (content.some(block => block?.type === 'tool_result')) continue
    if (!content.length || content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) return null
    return content.map(block => block.text).join('\n')
  }
  return null
}

export function gitDeliveryPolicy(messages: readonly Message[], mainThread: boolean): boolean {
  const text = latestHumanText(messages, mainThread)
  return text !== null && isGitDeliveryRequest(text)
}

/** Only enable phase detection for a human delivery request. A Git operation
 * used inside an experiment must not constrain the next research decision.
 * This is a conservative latency hint; tool authorization is always separate. */
export function gitDeliveryIntent(messages: readonly Message[], mainThread: boolean): boolean {
  const text = latestHumanText(messages, mainThread)
  if (text === null || text.length > 16_384 || /```|~~~/.test(text) ||
    /\b(?:do not|don't|never|without)\s+(?:git\s+)?(?:commit|push|publish|send|open|create|submit)\b/i.test(text)) return false
  return isGitDeliveryRequest(text) ||
    /\b(?:then|finally|and)\s+(?:git\s+)?(?:commit|push)\b/i.test(text) ||
    /\b(?:send|open|create|submit)\s+(?:a\s+|the\s+)?(?:pr|pull request)\b/i.test(text)
}

export function gitDeliveryModelTimeout(value = process.env.FUTURE_CODE_GIT_MODEL_TIMEOUT_MS): number {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 1000 && n <= 3_600_000 ? n : 120_000
}
