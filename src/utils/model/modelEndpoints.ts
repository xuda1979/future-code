import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ModelEndpoint = {
  version: 1
  model: string
  baseUrl: string
  protocol: 'openai' | 'anthropic'
  apiKey: string
}

const MAX_BYTES = 16_384
const reserved = new Set(['default', 'add', 'list', 'help', 'info', 'best', 'opus', 'sonnet', 'haiku', 'opusplan'])

function directory(): string {
  return join(process.env.FUTURE_CONFIG_DIR ?? join(homedir(), '.future'), 'model-endpoints')
}

function filename(model: string): string {
  return `${createHash('sha256').update(model).digest('hex')}.json`
}

function readProfileFile(path: string): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0))
  } finally { closeSync(fd) }
}

export function validateEndpointInput(model: string, baseUrl: string): void {
  if (!model || model.length > 200 || /[\s\x00-\x1f\x7f]/.test(model) || model.includes('[') || reserved.has(model.toLowerCase()) || model.startsWith('-')) {
    throw new Error('Use a nonempty model ID without spaces, control characters, suffixes or reserved command/alias names.')
  }
  let url: URL
  try { url = new URL(baseUrl) } catch { throw new Error('Enter a valid HTTP or HTTPS API base URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || /[\s\x00-\x1f\x7f]/.test(baseUrl)) {
    throw new Error('Use an HTTP or HTTPS API base URL without credentials, query parameters or fragments.')
  }
}

function validateProfile(value: unknown): ModelEndpoint {
  const p = value as ModelEndpoint
  if (!p || p.version !== 1 || typeof p.model !== 'string' || typeof p.baseUrl !== 'string' || !['openai', 'anthropic'].includes(p.protocol) || typeof p.apiKey !== 'string' || !p.apiKey.trim() || p.apiKey.length > 8192 || /[\r\n\x00]/.test(p.apiKey)) {
    throw new Error('Invalid saved model endpoint. Add it again with /model add.')
  }
  validateEndpointInput(p.model, p.baseUrl)
  return { version: 1, model: p.model, baseUrl: p.baseUrl.replace(/\/+$/, ''), protocol: p.protocol, apiKey: p.apiKey }
}

/** One atomic file per model: unrelated concurrent saves cannot overwrite each other.
 * Repeating a save replaces that model; the last completed rename wins. */
export function saveModelEndpoint(input: ModelEndpoint): void {
  const profile = validateProfile(input)
  const data = JSON.stringify(profile) + '\n'
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Model endpoint configuration is too large.')
  const dir = directory()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = join(dir, `.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, data)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, join(dir, filename(profile.model)))
  } catch {
    throw new Error('Could not save model endpoint. Check your configuration directory permissions.')
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* renamed or never created */ }
  }
}

export function readModelEndpoint(model: string): ModelEndpoint | undefined {
  let data: Buffer
  try { data = readProfileFile(join(directory(), filename(model))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Could not read saved model endpoint.')
  }
  if (data.length > MAX_BYTES) throw new Error('Saved model endpoint is too large.')
  let profile: ModelEndpoint
  try { profile = validateProfile(JSON.parse(data.toString('utf8'))) }
  catch { throw new Error('Invalid saved model endpoint. Add it again with /model add.') }
  if (profile.model !== model) throw new Error('Saved model endpoint does not match its model ID.')
  return profile
}

/** Never expose credentials to picker labels, command output or telemetry. */
export function listModelEndpoints(): Pick<ModelEndpoint, 'model' | 'protocol'>[] {
  let names: string[]
  try { names = readdirSync(directory()) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Could not list saved model endpoints.')
  }
  return names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort().flatMap(name => {
    try {
      const data = readProfileFile(join(directory(), name))
      if (data.length > MAX_BYTES) throw new Error()
      const p = validateProfile(JSON.parse(data.toString('utf8')))
      if (filename(p.model) !== name) throw new Error()
      return [{ model: p.model, protocol: p.protocol }]
    } catch {
      // A corrupt saved profile must not break the recovery picker. It is
      // excluded; selecting it explicitly still fails closed in readModelEndpoint.
      return []
    }
  })
}

/** Credentials belong only to the selected endpoint; never inherit OAuth,
 * custom Authorization headers or API-key helpers from the previous provider. */
export function modelEndpointClientOptions(model: string | undefined): { protocol: ModelEndpoint['protocol']; baseURL: string; apiKey: string; authToken: null } | undefined {
  const p = model ? readModelEndpoint(model) : undefined
  if (!p) return undefined
  if (p.protocol === 'anthropic') return { protocol: p.protocol, baseURL: p.baseUrl.replace(/\/v1(?:\/messages)?$/, ''), apiKey: p.apiKey, authToken: null }
  let proxy: URL
  try { proxy = new URL(process.env.FUTURE_BASE_URL ?? '') } catch { throw new Error('OpenAI endpoints require the Future Code local translation proxy.') }
  if (!['http:', 'https:'].includes(proxy.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(proxy.hostname) || proxy.username || proxy.password) {
    throw new Error('OpenAI endpoints require FUTURE_BASE_URL to point to the Future Code local translation proxy.')
  }
  // The local proxy resolves the protected profile itself. Its HTTP ingress
  // does not use upstream credentials; do not send the upstream key to it.
  return { protocol: p.protocol, baseURL: proxy.toString().replace(/\/$/, ''), apiKey: 'local-model-endpoint', authToken: null }
}

export async function checkModelEndpointProxy(baseURL: string): Promise<void> {
  try {
    const url = new URL('/health', baseURL)
    const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: 'error' })
    if (!response.ok) throw new Error()
    const data = await response.json() as { model_endpoints?: number }
    if (data.model_endpoints !== 1) throw new Error()
  } catch {
    throw new Error('Update and restart the Future Code local translation proxy to use saved OpenAI endpoints.')
  }
}
