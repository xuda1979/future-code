import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { watchModelStream, ModelStreamStalledError, isModelProgress, modelStreamIdleTimeout, modelStallAction } from '../../src/utils/modelStreamLiveness.ts'

const opts = (signal = new AbortController().signal, timeoutMs = 30) => ({ signal, timeoutMs, isProgress: isModelProgress })
test('hung next and return cannot hold a foreground request hostage', async () => {
  let requestSignal: AbortSignal | undefined
  const hung = { [Symbol.asyncIterator]() { return {
    next: () => new Promise<IteratorResult<{ type: string }>>(() => {}),
    return: () => new Promise<IteratorResult<{ type: string }>>(() => {}),
  } } }
  await assert.rejects(async () => {
    for await (const _ of watchModelStream(signal => { requestSignal = signal; return hung }, opts())) {}
  }, ModelStreamStalledError)
  assert.equal(requestSignal?.aborted, true)
})
test('control heartbeats cannot mask a stalled model', async () => {
  async function* pings(signal: AbortSignal) {
    while (!signal.aborted) { await delay(4); yield { type: 'stream_request_start' } }
  }
  await assert.rejects(async () => {
    for await (const _ of watchModelStream(pings, opts())) {}
  }, ModelStreamStalledError)
})
test('real tokens keep a long request alive beyond a single idle deadline', async () => {
  let count = 0
  async function* tokens() {
    for (let i = 0; i < 8; i++) { await delay(8); yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } } }
  }
  for await (const _ of watchModelStream(tokens, opts())) count++
  assert.equal(count, 8)
})
test('operator cancellation closes a hung read promptly without becoming a stall', async () => {
  const controller = new AbortController()
  async function* hung() { await new Promise(() => {}); yield { type: 'assistant' } }
  const task = (async () => { for await (const _ of watchModelStream(hung, opts(controller.signal, 1000))) {} })()
  controller.abort(new Error('operator pause'))
  await task
})
test('synchronous adapter failure releases the abort subscription', async () => {
  const controller = new AbortController()
  await assert.rejects(async () => {
    for await (const _ of watchModelStream(() => { throw new Error('adapter failed') }, opts(controller.signal))) {}
  }, /adapter failed/)
  controller.abort()
})
test('timeout parsing and progress classification', () => {
  assert.equal(modelStreamIdleTimeout('60000'), 60_000)
  for (const value of ['0', '-1', 'Infinity', 'NaN', '5000000']) assert.equal(modelStreamIdleTimeout(value), 180_000)
  assert.equal(isModelProgress({ type: 'stream_request_start' }), false)
  assert.equal(isModelProgress({ type: 'assistant' }), true)
  assert.equal(isModelProgress({ type: 'stream_event', event: { type: 'ping' } }), false)
})

test('a stalled read after tool admission collects a single actual receipt instead of replaying effects', async () => {
  let executions = 0
  let modelReads = 0
  let admitted = 0
  let receipt: Promise<string> | undefined
  async function* partial() {
    modelReads++
    yield { type: 'assistant' }
    await new Promise(() => {})
  }
  try {
    for await (const _ of watchModelStream(partial, opts())) {
      admitted++; executions++
      receipt = delay(10).then(() => 'verified job output')
    }
    assert.fail('stream must time out')
  } catch (error) {
    assert.ok(error instanceof ModelStreamStalledError)
    assert.equal(modelStallAction(admitted, 0, false), 'collect')
    assert.equal(await receipt, 'verified job output')
  }
  assert.equal(modelReads, 1)
  assert.equal(executions, 1)
  assert.equal(modelStallAction(0, 0, false), 'retry')
  assert.equal(modelStallAction(0, 1, false), 'block')
  assert.equal(modelStallAction(1, 0, true), 'block')
})
