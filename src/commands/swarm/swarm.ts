import { formatHealth } from '../../harness/foundry/health.ts'
import type { LocalCommandCall } from '../../types/command.js'
import { handleSwarm, tokenize } from '../../harness/foundry/swarm/cli.ts'

// `src/utils/messages.js` pulls in Bun-only modules (`bun:bundle`), so importing it
// statically would break this module under the Node test runner (`--experimental-strip-types`
// keeps `.js` specifiers unresolved). Import it lazily, only when a health report arrives.
const createSystemMessage = async (
  ...args: Parameters<
    Awaited<ReturnType<typeof import('../../utils/messages.js')>>['createSystemMessage']
  >
) =>
  (
    await import('../../utils/messages.js')
  ).createSystemMessage(...args)

/** User-invoked command. It does not bypass approval by turning a model tool
 * call into a process launch; mutating commands require explicit --allow-exec. */
export const call: LocalCommandCall = async (args, context) => {
  let progressId: string | undefined
  try {
    const result = await handleSwarm(tokenize(args), context.abortController.signal, async report => {
      const message = await createSystemMessage(formatHealth(report), 'info')
      const previous = progressId
      progressId = message.uuid
      context.setMessages(messages => [...messages.filter(m => m.uuid !== previous), message])
    })
    return { type: 'text', value: JSON.stringify(result, null, 2) }
  } catch (error) {
    return { type: 'text', value: JSON.stringify({
      status: context.abortController.signal.aborted ? 'PAUSED' : 'ERROR',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2) }
  }
}
