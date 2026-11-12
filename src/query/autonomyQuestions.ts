import { AUTONOMY_QUESTION_REDIRECT_MARKER } from '../harness/autonomyPolicy.ts'

/** Authenticate the host redirect by the actual question call/result pairing.
 * Text from a human, another tool, or an unrelated receipt is never a signal. */
export function hasAutonomyQuestionRejection(
  calls: ReadonlyArray<{ id: string; name: string }>,
  results: ReadonlyArray<{ type: string; message?: { content?: unknown } }>,
): boolean {
  const questions = new Set(calls.filter(call => call.name === 'AskUserQuestion' || call.name === 'EnterPlanMode').map(call => call.id))
  if (questions.size === 0) return false
  return results.some(message => message.type === 'user' && Array.isArray(message.message?.content) &&
    message.message.content.some(block => {
      if (block?.type !== 'tool_result' || block.is_error !== true || !questions.has(block.tool_use_id)) return false
      const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ?
        block.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
          .map((part: any) => part.text).join('\n') : ''
      return content.includes(AUTONOMY_QUESTION_REDIRECT_MARKER)
    }))
}
