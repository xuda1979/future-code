import { validateEndpointInput, type ModelEndpoint } from '../../utils/model/modelEndpoints.ts'

export const MODEL_ENDPOINT_HELP = 'Run /model to select a model; /model <id> to validate and select; /model list to list saved endpoints; /model add <id> <base-url> [--protocol openai|anthropic] [--api-key-env ENV_NAME] to save an endpoint locally. Without --api-key-env, enter the key in the masked prompt. Saving makes no network requests. OpenAI endpoints use the Future Code local translation proxy.'

export function parseEndpointCommand(args: string): Omit<ModelEndpoint, 'apiKey'> & { apiKey?: string } {
  const [verb, model, baseUrl, ...flags] = args.split(/\s+/)
  if (verb !== 'add' || !model || !baseUrl || flags.length % 2) throw new Error(MODEL_ENDPOINT_HELP)
  validateEndpointInput(model, baseUrl)
  let protocol: ModelEndpoint['protocol'] = 'openai'
  let apiKey: string | undefined
  const seen = new Set<string>()
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i]!
    const value = flags[i + 1]!
    if (seen.has(flag)) throw new Error('Duplicate model endpoint option.')
    seen.add(flag)
    if (flag === '--protocol' && ['openai', 'anthropic'].includes(value)) protocol = value as ModelEndpoint['protocol']
    else if (flag === '--api-key-env' && /^[A-Za-z_][A-Za-z_0-9]*$/.test(value)) {
      apiKey = process.env[value]
      if (!apiKey?.trim()) throw new Error('The API key environment variable is empty or unavailable.')
    } else throw new Error(MODEL_ENDPOINT_HELP)
  }
  return { version: 1, model, baseUrl, protocol, ...(apiKey !== undefined && { apiKey }) }
}
