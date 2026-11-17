import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register('./diagnostics-latency-loader.mjs', import.meta.url)
const { DiagnosticTrackingService } = await import('../../src/services/diagnosticTracking.ts')

const rpc = globalThis as typeof globalThis & {
  __diagnosticRpc: (...args: any[]) => Promise<unknown>
}
const connected = { type: 'connected', name: 'test-ide' } as any
const response = (files: unknown[]) => [{ type: 'text', text: JSON.stringify(files) }]
const diagnostic = (message: string) => ({ message, severity: 'Error',
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } })

async function microtasks() { for (let i = 0; i < 10; i++) await Promise.resolve() }

test('read-only turns do not wait for IDE diagnostics that cannot produce an attachment', async () => {
  const tracker = new DiagnosticTrackingService()
  tracker.initialize(connected)
  let calls = 0, release!: (value: unknown) => void
  rpc.__diagnosticRpc = () => { calls++; return new Promise(resolve => { release = resolve }) }
  const pending = tracker.getNewDiagnostics()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([pending,
      new Promise(resolve => { timer = setTimeout(() => resolve('blocked by unnecessary IDE request'), 100) })])
    assert.deepEqual(outcome, [])
    assert.equal(calls, 0)
  } finally {
    clearTimeout(timer)
    release?.(response([]))
    await pending
  }
})

test('edited-file diagnostics retain baseline comparison and report newly introduced errors once', async () => {
  const tracker = new DiagnosticTrackingService()
  tracker.initialize(connected)
  const before = diagnostic('existing'), after = diagnostic('new regression')
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  rpc.__diagnosticRpc = async (tool, args) => {
    calls.push({ tool, args })
    return response([{ uri: 'file:///project/main.ts', diagnostics: calls.length === 1 ? [before] : [before, after] },
      { uri: 'file:///project/unrelated.ts', diagnostics: [diagnostic('unrelated')] }])
  }
  await tracker.beforeFileEdited('/project/main.ts')
  assert.deepEqual(await tracker.getNewDiagnostics(), [{ uri: 'file:///project/main.ts', diagnostics: [after] }])
  assert.deepEqual(await tracker.getNewDiagnostics(), [])
  assert.deepEqual(calls, [
    { tool: 'getDiagnostics', args: { uri: 'file:///project/main.ts' } },
    { tool: 'getDiagnostics', args: {} }, { tool: 'getDiagnostics', args: {} },
  ])
})

test('diagnostic deadline releases an edit, aborts the transport, and rejects late baselines', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const tracker = new DiagnosticTrackingService()
  tracker.initialize(connected)
  let calls = 0, transportSignal: AbortSignal | undefined, release!: (value: unknown) => void
  rpc.__diagnosticRpc = (_tool, _args, _client, signal) => {
    calls++; transportSignal = signal
    return new Promise(resolve => { release = resolve })
  }
  const pending = tracker.beforeFileEdited('/project/main.ts')
  await microtasks()
  assert.equal(calls, 1)
  t.mock.timers.tick(1000)
  await pending
  assert.equal(transportSignal?.aborted, true)
  release(response([{ uri: 'file:///project/main.ts', diagnostics: [] }]))
  await microtasks()
  assert.deepEqual(await tracker.getNewDiagnostics(), [])
  assert.equal(calls, 1, 'timed-out baseline must not return late and enable polling')
})

test('caller cancellation releases an uncooperative IDE request without waiting for its deadline', async () => {
  const tracker = new DiagnosticTrackingService()
  tracker.initialize(connected)
  const controller = new AbortController()
  let transportSignal: AbortSignal | undefined, release!: (value: unknown) => void
  rpc.__diagnosticRpc = (_tool, _args, _client, signal) => {
    transportSignal = signal
    return new Promise(resolve => { release = resolve })
  }
  const pending = tracker.beforeFileEdited('/project/main.ts', controller.signal)
  await microtasks()
  controller.abort(new Error('operator cancelled'))
  await pending
  assert.equal(transportSignal?.aborted, true)
  release(response([]))
  await microtasks()
})

test('timed-out diagnostic polling keeps its baseline for the next healthy read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const tracker = new DiagnosticTrackingService()
  tracker.initialize(connected)
  const existing = diagnostic('existing'), regression = diagnostic('new regression')
  let unhealthy = true, release!: (value: unknown) => void
  rpc.__diagnosticRpc = async (_tool, args) => {
    if (args.uri) return response([{ uri: args.uri, diagnostics: [existing] }])
    if (unhealthy) return new Promise(resolve => { release = resolve })
    return response([{ uri: 'file:///project/main.ts', diagnostics: [existing, regression] }])
  }
  await tracker.beforeFileEdited('/project/main.ts')
  const pending = tracker.getNewDiagnostics()
  await microtasks()
  t.mock.timers.tick(1000)
  assert.deepEqual(await pending, [])
  unhealthy = false
  assert.deepEqual(await tracker.getNewDiagnostics(), [{ uri: 'file:///project/main.ts', diagnostics: [regression] }])
  release(response([{ uri: 'file:///project/main.ts', diagnostics: [] }]))
  await microtasks()
  assert.deepEqual(await tracker.getNewDiagnostics(), [], 'late failed read must not erase the accepted newer baseline')
})

test('reset retires a pending baseline without contaminating the next query', async () => {
  const tracker = new DiagnosticTrackingService()
  tracker.initialize(connected)
  const known = diagnostic('existing in new query'), introduced = diagnostic('new in new query')
  let release!: (value: unknown) => void
  rpc.__diagnosticRpc = async (_tool, args) => {
    if (args.uri === 'file:///project/old.ts') return new Promise(resolve => { release = resolve })
    if (args.uri) return response([{ uri: 'file:///project/new.ts', diagnostics: [known] }])
    return response([{ uri: 'file:///project/old.ts', diagnostics: [diagnostic('old query error')] },
      { uri: 'file:///project/new.ts', diagnostics: [known, introduced] }])
  }
  const old = tracker.beforeFileEdited('/project/old.ts')
  await microtasks()
  tracker.reset()
  await tracker.beforeFileEdited('/project/new.ts')
  await old
  release(response([{ uri: 'file:///project/old.ts', diagnostics: [] }]))
  await microtasks()
  assert.deepEqual(await tracker.getNewDiagnostics(), [{ uri: 'file:///project/new.ts', diagnostics: [introduced] }])
})

test('late old-query diagnostics cannot overwrite a new-query baseline for the same file', async () => {
  const tracker = new DiagnosticTrackingService()
  tracker.initialize(connected)
  const existing = diagnostic('existing'), newBaseline = diagnostic('new baseline'), regression = diagnostic('regression')
  let phase = 'old', release!: (value: unknown) => void
  rpc.__diagnosticRpc = async (_tool, args) => {
    if (args.uri) return response([{ uri: args.uri, diagnostics: phase === 'old' ? [existing] : [existing, newBaseline] }])
    if (phase === 'old') return new Promise(resolve => { release = resolve })
    return response([{ uri: 'file:///project/main.ts', diagnostics: [existing, newBaseline, regression] }])
  }
  await tracker.beforeFileEdited('/project/main.ts')
  const old = tracker.getNewDiagnostics()
  await microtasks()
  tracker.reset(); phase = 'new'
  await tracker.beforeFileEdited('/project/main.ts')
  assert.deepEqual(await old, [])
  release(response([{ uri: 'file:///project/main.ts', diagnostics: [] }]))
  await microtasks()
  assert.deepEqual(await tracker.getNewDiagnostics(), [{ uri: 'file:///project/main.ts', diagnostics: [regression] }])
})

test('shutdown aborts pending diagnostics and query start refreshes the IDE connection', async () => {
  const tracker = new DiagnosticTrackingService()
  tracker.initialize(connected)
  let transportSignal: AbortSignal | undefined, release!: (value: unknown) => void
  const clients: unknown[] = []
  rpc.__diagnosticRpc = (_tool, _args, client, signal) => {
    clients.push(client); transportSignal = signal
    return new Promise(resolve => { release = resolve })
  }
  const pending = tracker.beforeFileEdited('/project/main.ts')
  await microtasks()
  await tracker.shutdown()
  await pending
  assert.equal(transportSignal?.aborted, true)
  release(response([]))
  await microtasks()
  const replacement = { type: 'connected', name: 'replacement-ide' } as any
  rpc.__diagnosticRpc = async (_tool, _args, client) => { clients.push(client); return response([]) }
  await tracker.handleQueryStart([replacement])
  await tracker.beforeFileEdited('/project/main.ts')
  assert.equal(clients.at(-1), replacement)
  await tracker.handleQueryStart([connected])
  await tracker.beforeFileEdited('/project/main.ts')
  assert.equal(clients.at(-1), connected)
  await tracker.handleQueryStart([])
  const before = clients.length
  await tracker.beforeFileEdited('/project/main.ts')
  assert.deepEqual(await tracker.getNewDiagnostics(), [])
  assert.equal(clients.length, before, 'disconnected IDE must not receive calls')
})
