/** Real SDK/client + validator; isolate unrelated auth/terminal subsystems. */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { saveModelEndpoint } from '../../src/utils/model/modelEndpoints.ts'

const noop = () => {}
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(`../../src/${path}.ts`, import.meta.url).pathname, () => exports)
let oldAuthCalls = 0
const oldAuth = () => { oldAuthCalls++; throw new Error('old provider auth must not run') }
stub('utils/auth', {
  checkAndRefreshOAuthTokenIfNeeded: oldAuth, getApiKeyFromApiKeyHelper: oldAuth,
  getFutureApiKey: oldAuth, getFutureAIOAuthTokens: oldAuth,
  isFutureAISubscriber: oldAuth, refreshAndGetAwsCredentials: oldAuth,
  refreshGcpCredentialsIfNeeded: oldAuth,
})
stub('utils/http', { getUserAgent: () => 'model-config-test' })
stub('utils/model/model', { getSmallFastModel: () => 'unused' })
stub('utils/model/providers', { getAPIProvider: () => 'firstParty', isFirstPartyFutureBaseUrl: () => false })
let firstPartyTunnelRequested: unknown
stub('utils/proxy', { getProxyFetchOptions: (options?: { forFutureAPI?: boolean }) => { firstPartyTunnelRequested = options?.forFutureAPI; return {} } })
stub('bootstrap/state', { getIsNonInteractiveSession: () => true, getSessionId: () => 'test-session' })
stub('constants/oauth', { getOauthConfig: () => ({}) })
stub('utils/debug', { isDebugToStdErr: () => false, logForDebugging: noop })
stub('utils/envUtils', { getAWSRegion: noop, getVertexRegionForModel: noop, isEnvTruthy: () => false })
let allowed = true
stub('utils/model/modelAllowlist', { isModelAllowed: () => allowed })
stub('utils/model/modelStrings', { getModelStrings: () => ({}) })

const { getFutureClient } = await import('../../src/services/api/client.ts')
let probes = 0
let lastProbe: any
let sideMode = 'normal'
let onProbe: (() => void) | undefined
stub('utils/sideQuery', { sideQuery: async (options: any) => {
  probes++
  lastProbe = options
  onProbe?.()
  if (sideMode === 'hung') return new Promise(() => {})
  const client = await getFutureClient({ model: options.model, maxRetries: options.maxRetries })
  return client.beta.messages.create({ model: options.model, max_tokens: options.max_tokens, messages: options.messages, thinking: { type: 'disabled' } }, { signal: options.signal })
} })
const { validateModel } = await import('../../src/utils/model/validateModel.ts')
const receipts: { url: string; key?: string; authorization?: string; body: any }[] = []
let status = 200
let errorMessage = 'invalid test key'
const server = createServer(async (request, response) => {
  let data = ''
  for await (const chunk of request) data += chunk
  receipts.push({ url: request.url!, key: request.headers['x-api-key'] as string, authorization: request.headers.authorization, body: JSON.parse(data) })
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(status === 200 ? { id: 'message-test', type: 'message', role: 'assistant', model: 'Example/Model-A', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } : { type: 'error', error: { type: 'authentication_error', message: errorMessage } }))
})
const oldConfig = process.env.FUTURE_CONFIG_DIR
const dir = mkdtempSync(join(tmpdir(), 'model-api-'))
let baseUrl: string
const profile = (key = 'test-key-A') => ({ version: 1 as const, model: 'Example/Model-A', baseUrl, protocol: 'anthropic' as const, apiKey: key })
beforeAll(async () => {
  process.env.FUTURE_CONFIG_DIR = dir
  process.env.FUTURE_CUSTOM_HEADERS = 'Authorization: Bearer previous-provider-secret'
  process.env.FUTURE_AUTH_TOKEN = 'previous-provider-secret'
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  if (oldConfig === undefined) delete process.env.FUTURE_CONFIG_DIR; else process.env.FUTURE_CONFIG_DIR = oldConfig
  delete process.env.FUTURE_CUSTOM_HEADERS
  delete process.env.FUTURE_AUTH_TOKEN
  delete process.env.FUTURE_CUSTOM_MODEL_OPTION
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

test('a saved native endpoint uses its URL/key without consulting old auth or sending old headers', async () => {
  saveModelEndpoint(profile())
  const result = await validateModel('Example/Model-A')
  expect(result).toEqual({ valid: true })
  expect(oldAuthCalls).toBe(0)
  expect(firstPartyTunnelRequested).not.toBe(true)
  expect(receipts.at(-1)?.url).toBe('/v1/messages?beta=true')
  expect(receipts.at(-1)?.key).toBe('test-key-A')
  expect(receipts.at(-1)?.authorization).toBeUndefined()
  expect(receipts.at(-1)?.body.model).toBe('Example/Model-A')
  expect(lastProbe.maxRetries).toBe(0)
  expect(lastProbe.thinking).toBe(false)
  expect(lastProbe.skipSystemPromptPrefix).toBe(true)
})

test('replacing the same model key invalidates its previous successful validation', async () => {
  const previous = probes
  saveModelEndpoint(profile('test-key-replaced'))
  status = 401
  try {
    const result = await validateModel('Example/Model-A')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Authentication failed')
    expect(probes).toBe(previous + 1)
    expect(receipts.at(-1)?.key).toBe('test-key-replaced')
  } finally { status = 200 }
})

test('a saved endpoint cannot inherit the legacy env option validation bypass', async () => {
  process.env.FUTURE_CUSTOM_MODEL_OPTION = 'Example/Model-A'
  saveModelEndpoint(profile('test-key-env-option'))
  const previous = probes
  expect((await validateModel('Example/Model-A')).valid).toBe(true)
  expect(probes).toBe(previous + 1)
  delete process.env.FUTURE_CUSTOM_MODEL_OPTION
})

test('provider error bodies cannot echo saved credentials into validation output', async () => {
  saveModelEndpoint(profile('test-key-error-echo'))
  status = 500
  errorMessage = 'provider echoed test-key-error-echo'
  try {
    const result = await validateModel('Example/Model-A')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('HTTP 500')
    expect(result.error).not.toContain('test-key-error-echo')
  } finally { status = 200; errorMessage = 'invalid test key' }
})

test('allowlists are enforced before network access, including cached valid endpoints', async () => {
  allowed = false
  const previous = probes
  try {
    expect((await validateModel('Example/Model-A')).valid).toBe(false)
    expect(probes).toBe(previous)
  } finally { allowed = true }
})

test('a configuration changed during a probe cannot be accepted using an older request receipt', async () => {
  saveModelEndpoint(profile('test-key-before-change'))
  onProbe = () => saveModelEndpoint(profile('test-key-after-change'))
  try {
    const result = await validateModel('Example/Model-A')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('changed during validation')
  } finally { onProbe = undefined }
})

test('production validation has a ten-second bound even when client initialization never returns', async () => {
  saveModelEndpoint(profile('test-key-hung'))
  sideMode = 'hung'
  const start = performance.now()
  try {
    const result = await validateModel('Example/Model-A')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('timed out')
    expect(performance.now() - start).toBeGreaterThanOrEqual(9900)
    expect(performance.now() - start).toBeLessThan(12000)
    expect(lastProbe.signal.aborted).toBe(true)
  } finally { sideMode = 'normal' }
}, 15000)

test('cancelled validation cannot return a cached success or keep the request alive', async () => {
  const controller = new AbortController()
  controller.abort()
  const previous = probes
  expect((await validateModel('Example/Model-A', controller.signal)).valid).toBe(false)
  expect(probes).toBe(previous)
})
