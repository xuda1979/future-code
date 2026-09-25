import type { LocalCommandCall } from '../../types/command.js'
import { handleSwarm, tokenize } from '../../harness/foundry/swarm/cli.ts'

/** User-invoked command. It does not bypass approval by turning a model tool
 * call into a process launch; mutating commands require explicit --allow-exec. */
export const call: LocalCommandCall = async (args, context) => {
  try {
    const result = await handleSwarm(tokenize(args), context.abortController.signal)
    return { type: 'text', value: JSON.stringify(result, null, 2) }
  } catch (error) {
    return { type: 'text', value: JSON.stringify({
      status: context.abortController.signal.aborted ? 'PAUSED' : 'ERROR',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2) }
  }
}
