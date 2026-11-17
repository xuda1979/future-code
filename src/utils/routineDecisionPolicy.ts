/** Request-local latency recovery. This never grants tools, accepts work,
 * lowers reasoning effort, or limits the lifetime of an autonomous goal. */
interface Message {
  type: string; isMeta?: boolean; isCompactSummary?: boolean; origin?: unknown; toolUseResult?: unknown
  message?: unknown
}
interface Goal {
  state: string; goal: string; revision?: number; activeSteering?: string[]; horizon?: string
}
export interface RoutineDecisionState {
  goalVersion: string
  expiries: number
  released: boolean
  guidance: string | null
}

const quoted = '(?:"[^"\\n]{0,120}"|\'[^\'\\n]{0,120}\'|`[^`\\n]{0,120}`)'
const path = '(?:`[^`\\n]{1,160}`|[A-Za-z0-9_./@~+\\-]+\\.[A-Za-z0-9_\\-]+)'
const literalEdit = new RegExp(`^(?:please )?(?:replace ${quoted} with ${quoted} in ${path}|rename ${path} to ${path}|set [A-Za-z_][A-Za-z0-9_.\\-]* to (?:${quoted}|true|false|[0-9]+(?:\\.[0-9]+)?) in ${path})[.!]?$`, 'i')
const command = /^(?:please )?run `?(?:(?:npm|pnpm|yarn|bun) (?:run )?(?:test|lint|build|typecheck)|(?:python3? -m )?(?:pytest|unittest)|ruff (?:check|format)|mypy|go test|cargo (?:test|check|fmt)|git (?:status|diff|log))(?: [\w.\/@=:+\-]+)*`?[.!]?$/i
const endpoint = /^(?:please )?(?:add model [\w./\-]+ (?:with )?(?:API )?(?:URL|endpoint)|(?:set|configure|update) (?:the )?(?:model )?API (?:URL|endpoint)(?: to)?) https?:\/\/[^\s`"'<>]+$/i

/** Complete routine imperatives only. Short text is not evidence that a
 * mathematical, scientific or design decision deserves less thinking. */
export function isRoutineDecisionRequest(text: string): boolean {
  if (!text || text.length > 512 || /[\n\r?]|```|~~~/.test(text) ||
    /\b(?:research|derive|prove|design|redesign|explain|analy[sz]e|algorithm|architecture|experiment|train|training|benchmark|paper|weeks?|and|then)\b/i.test(text)) return false
  return literalEdit.test(text.trim()) || command.test(text.trim()) || endpoint.test(text.trim())
}

function latestHumanText(messages: readonly Message[]): string | null {
  for (let i = messages.length - 1, count = 0; i >= 0 && count < 256; i--, count++) {
    const m = messages[i]!
    if (m.type !== 'user' || m.isMeta || m.isCompactSummary || m.origin !== undefined || m.toolUseResult !== undefined) continue
    const body = m.message
    const content = body !== null && typeof body === 'object' && 'content' in body ? body.content : undefined
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return null
    if (content.some(block => block?.type === 'tool_result')) continue
    if (!content.length || content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) return null
    return content.map(block => block.text).join('\n')
  }
  return null
}
function version(goal: Goal): string {
  return JSON.stringify([goal.goal, goal.revision ?? 1, goal.activeSteering ?? [], goal.horizon ?? 'auto'])
}
export function createRoutineDecisionPolicy(messages: readonly Message[], mainThread: boolean,
  goal: Goal | null, shortHorizon: boolean): RoutineDecisionState | undefined {
  const text = mainThread && goal?.state === 'ACTIVE' && shortHorizon ? latestHumanText(messages) : null
  return text !== null && isRoutineDecisionRequest(text) && goal && isRoutineDecisionRequest(goal.goal) ?
    { goalVersion: version(goal), expiries: 0, released: false, guidance: null } : undefined
}
export function isRoutineDecisionCurrent(state: RoutineDecisionState, goal: Goal | null): boolean {
  return goal?.state === 'ACTIVE' && state.goalVersion === version(goal)
}
export function routineDecisionModelTimeout(state: RoutineDecisionState | undefined,
  value = process.env.FUTURE_CODE_ROUTINE_MODEL_TIMEOUT_MS): number | undefined {
  if (!state || state.released || value?.trim() === '0') return undefined
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 1000 && n <= 3_600_000 ? n : 120_000
}

const DIRECT_GUIDANCE = '[Routine decision recovery]\n' +
  'The previous model decision exceeded its latency target before a tool was admitted. ' +
  'Use the current objective and existing evidence to choose the next direct action or discriminating check. ' +
  'Execute authorized work autonomously, preserve necessary reasoning and all permissions, hooks and independent verification. ' +
  'Inspect uncertain external outcomes before retrying effects. This reminder is not acceptance evidence.'

/** At most one guided retry and one configured fallback in an unchanged
 * no-tool phase. Release the latency target instead of parking the goal or
 * repeatedly interrupting necessary reasoning when those corrections fail. */
export function recoverRoutineDecision(state: RoutineDecisionState,
  options: { admittedTools: number; aborted: boolean; currentModel: string; fallbackModel?: string }):
  { kind: 'retry' | 'fallback' | 'release'; model: string; message: string } | null {
  if (state.released || options.aborted || options.admittedTools > 0) return null
  state.expiries++
  state.guidance = DIRECT_GUIDANCE
  if (state.expiries === 1) return { kind: 'retry', model: options.currentModel,
    message: 'Routine model decision exceeded its latency target; retrying automatically with direct-action guidance.' }
  if (state.expiries === 2 && options.fallbackModel && options.fallbackModel !== options.currentModel) return {
    kind: 'fallback', model: options.fallbackModel,
    message: 'Routine model decision remained slow; trying the configured fallback automatically.' }
  state.released = true
  state.guidance = null
  return { kind: 'release', model: options.currentModel,
    message: 'Routine latency corrections were exhausted; continuing autonomously with normal reasoning and no routine decision deadline.' }
}
export function resetRoutineDecisionAfterTools(state: RoutineDecisionState | undefined): void {
  if (!state) return
  state.expiries = 0
  state.released = false
  state.guidance = null
}
