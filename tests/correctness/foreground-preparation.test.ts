import test from 'node:test'
import assert from 'node:assert/strict'
import { DeferredHookGate, foregroundPreparationTimeout, ForegroundPreparationTimeoutError,
  waitForForegroundPreparation } from '../../src/utils/foregroundPreparation.ts'

test('a hung startup hook gives a named error and a later continue reuses the same invocation', async () => {
  let finish!: (messages: string[]) => void
  let invocations = 0
  const hook = new Promise<string[]>(resolve => { invocations++; finish = resolve })
  const gate = new DeferredHookGate(hook), published: string[][] = []
  await assert.rejects(gate.wait(messages => published.push(messages), { timeoutMs: 15 }), error => {
    assert.ok(error instanceof ForegroundPreparationTimeoutError)
    assert.match(error.message, /SessionStart hooks/)
    return true
  })
  assert.deepEqual(published, [])
  finish(['required hook context'])
  await gate.wait(messages => published.push(messages), { timeoutMs: 100 })
  await gate.wait(messages => published.push(messages), { timeoutMs: 100 })
  assert.equal(invocations, 1)
  assert.deepEqual(published, [['required hook context']])
})

test('startup rejection is handled before effects mount and remains a required visible failure', async () => {
  const error = new Error('SessionStart command failed: missing executable')
  const gate = new DeferredHookGate(Promise.reject(error)), seen: unknown[] = []
  // Allow rejection to settle before attaching UI observers, as a deferred mount does.
  await new Promise<void>(resolve => setImmediate(resolve))
  const stop = gate.observe(() => assert.fail('failed hooks cannot publish context'), value => seen.push(value))
  await assert.rejects(gate.wait(() => assert.fail('required hooks must not be bypassed')), /missing executable/)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(seen, [error])
  stop()
})

test('effect delivery and a submitted request publish hook context exactly once', async () => {
  const gate = new DeferredHookGate(Promise.resolve(['context'])), published: string[][] = []
  const stop = gate.observe(messages => published.push(messages), error => assert.fail(String(error)))
  await Promise.all([gate.wait(messages => published.push(messages)), gate.wait(messages => published.push(messages))])
  assert.deepEqual(published, [['context']])
  stop()
})

test('cancelling preparation is prompt even when its reader ignores abort; late output is not published', async () => {
  const controller = new AbortController()
  let finish!: (value: string) => void, calls = 0
  const result = waitForForegroundPreparation('context loading', () => {
    calls++; return new Promise<string>(resolve => { finish = resolve })
  }, { signal: controller.signal, timeoutMs: 1000 })
  await Promise.resolve()
  controller.abort(new Error('operator pause'))
  await assert.rejects(result, /operator pause/)
  finish('late context')
  assert.equal(calls, 1)
  await assert.rejects(waitForForegroundPreparation('context', () => { calls++; return 'must not start' },
    { signal: controller.signal }), /operator pause/)
  assert.equal(calls, 1)
})

test('preparation deadline parsing keeps bounded host waits configurable', () => {
  assert.equal(foregroundPreparationTimeout('60000'), 60000)
  for (const value of ['', '0', '-1', 'NaN', 'Infinity', '5000000'])
    assert.equal(foregroundPreparationTimeout(value), 120000)
})
