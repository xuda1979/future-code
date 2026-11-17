import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

// Load the exact production RPC/tool functions. The full MCP module also boots
// auth, transports and UI; only those unrelated services are replaced here.
const source = readFileSync(new URL('../../src/services/mcp/client.ts', import.meta.url), 'utf8')
function declaration(start: string): string {
  const offset = source.indexOf(start)
  assert.notEqual(offset, -1, `missing production declaration: ${start}`)
  const end = source.indexOf('\n}\n', offset)
  assert.notEqual(end, -1)
  return source.slice(offset, end + 3).replace(/^export /, '')
}
const functions = stripTypeScriptTypes([
  source.match(/^const DEFAULT_MCP_TOOL_TIMEOUT_MS = .+$/m)![0],
  declaration('function getMcpToolTimeoutMs('),
  declaration('export async function callIdeRpc('),
  declaration('async function callMCPTool('),
].join('\n'), { mode: 'strip' })
const api = new Function(`
  const createAbortController = () => new AbortController();
  const CallToolResultSchema = {};
  const logMCPDebug = () => {}, logMCPError = () => {}, logEvent = () => {};
  const detectCodeIndexingFromMcpServerName = () => undefined;
  const processMCPResult = async result => result.content;
  const isMcpSessionExpiredError = () => false;
  const clearServerCache = async () => {};
  class TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends Error {}
  class McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends Error {}
  class UnauthorizedError extends Error {}
  class McpAuthError extends Error {}
  class McpSessionExpiredError extends Error {}
  ${functions}
  return { callIdeRpc, getMcpToolTimeoutMs };
`)() as { callIdeRpc: (...args: any[]) => Promise<unknown>; getMcpToolTimeoutMs: () => number }

function connection(callTool: (...args: any[]) => Promise<unknown>) {
  return { type: 'connected', name: 'test-ide', config: { type: 'stdio' }, client: { callTool } }
}

test('diagnostic RPC bounds its own MCP timeout even when the transport ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const deadlineTimer = t.mock.method(globalThis, 'setTimeout')
  const progressTimer = t.mock.method(globalThis, 'setInterval')
  const clearDeadline = t.mock.method(globalThis, 'clearTimeout')
  const clearProgress = t.mock.method(globalThis, 'clearInterval')
  let options: { signal: AbortSignal; timeout: number } | undefined
  let rejectTransport!: (error: Error) => void
  const controller = new AbortController()
  const client = connection((_call, _schema, opts) => {
    options = opts
    return new Promise((_resolve, reject) => { rejectTransport = reject })
  })
  const pending = api.callIdeRpc('getDiagnostics', {}, client, controller.signal, 1000)
  const observed = assert.rejects(pending, /timed out after 1s/)
  assert.equal(options?.signal, controller.signal)
  assert.equal(options?.timeout, 1000)
  controller.abort()
  t.mock.timers.tick(1000)
  await observed
  assert.ok(clearDeadline.mock.calls.some(call => call.arguments[0] === deadlineTimer.mock.calls[0]!.result), 'MCP deadline handle is cleared')
  assert.ok(clearProgress.mock.calls.some(call => call.arguments[0] === progressTimer.mock.calls[0]!.result), 'MCP progress interval is cleared')
  // The abandoned transport is still observed after the host timeout.
  rejectTransport(new Error('late transport rejection'))
  await new Promise<void>(resolve => setImmediate(resolve))
})

test('diagnostics deadline does not change ordinary MCP timeouts or successful RPC content', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let options: { signal: AbortSignal; timeout: number } | undefined
  const content = [{ type: 'text', text: 'actual result' }]
  const client = connection(async (_call, _schema, opts) => { options = opts; return { content } })
  assert.deepEqual(await api.callIdeRpc('regularTool', {}, client), content)
  assert.equal(options?.timeout, api.getMcpToolTimeoutMs())
  assert.equal(options?.timeout, parseInt(process.env.MCP_TOOL_TIMEOUT || '', 10) || 100_000_000)
  assert.ok(options?.signal instanceof AbortSignal)
  // A success clears its deadline; advancing time must not throw/reject.
  t.mock.timers.tick(api.getMcpToolTimeoutMs())
})

test('diagnostic RPC preserves actual server errors instead of converting them into success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const client = connection(async () => ({ isError: true, content: [{ type: 'text', text: 'IDE unavailable' }] }))
  await assert.rejects(api.callIdeRpc('getDiagnostics', {}, client, undefined, 1000), /IDE unavailable/)
  t.mock.timers.tick(1000)
})
