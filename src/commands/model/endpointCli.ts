import { listModelEndpoints, saveModelEndpoint } from '../../utils/model/modelEndpoints.ts'
import { MODEL_ENDPOINT_HELP, parseEndpointCommand } from './endpointCommand.ts'

/** Deterministic headless counterpart for operators and coding agents. */
export function runModelEndpointCLI(args: string[]): string {
  if (args.length === 1 && args[0] === 'list') {
    return listModelEndpoints().map(p => `${p.model} (${p.protocol})`).join('\n') || 'No saved model endpoints.'
  }
  if (args.length === 0 || args.some(arg => ['--help', '-h'].includes(arg))) return MODEL_ENDPOINT_HELP
  const input = parseEndpointCommand(args.join(' '))
  if (!input.apiKey) throw new Error('Headless endpoint setup requires --api-key-env ENV_NAME.')
  saveModelEndpoint({ ...input, apiKey: input.apiKey })
  return `Saved endpoint for ${input.model}. No network check was made. Run /model ${input.model} to validate and select it.`
}
