import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { startQueueWakeup, startGuardedQueueWakeup, hasMainThreadQueuedCommand } from '../../src/utils/queueWakeup.ts'
import { QueryGuard } from '../../src/utils/QueryGuard.ts'

test('only main-thread input or notifications can take over the foreground dispatcher', () => {
  assert.equal(hasMainThreadQueuedCommand([]), false)
  assert.equal(hasMainThreadQueuedCommand([{ agentId: 'child' }]), false)
  assert.equal(hasMainThreadQueuedCommand([{ agentId: 'child' }, {}]), true)
})

test('a missed idle notification is recovered without user input or React rendering', async () => {
  const guard = new QueryGuard()
  const generation = guard.tryStart()!
  let pending = 1
  let calls = 0
  const pump = startQueueWakeup({ isReady: () => !guard.isActive && pending > 0,
    process: () => { calls++; pending-- }, subscribe: [], onError: e => { throw e }, pollMs: 5 })
  try {
    await delay(15)
    assert.equal(calls, 0)
    guard.end(generation)
    await delay(20)
    assert.equal(calls, 1)
    await delay(15)
    assert.equal(calls, 1)
  } finally { pump.stop() }
})
test('queued follow-up wakes immediately after completion and never runs concurrently', async () => {
  let pending = 2
  let active = 0
  let maxActive = 0
  let wake: () => void = () => {}
  const pump = startQueueWakeup({ isReady: () => pending > 0, process: async () => {
    pending--; active++; maxActive = Math.max(active, maxActive)
    wake(); await delay(5); active--
  }, subscribe: [fn => { wake = fn; return () => { wake = () => {} } }], onError: e => { throw e }, pollMs: 1000 })
  try {
    await delay(30)
    assert.equal(pending, 0)
    assert.equal(maxActive, 1)
  } finally { pump.stop() }
})
test('modal readiness, failure and shutdown preserve queue ownership', async () => {
  let modal = true
  let pending = 2
  let errors = 0
  let calls = 0
  const pump = startQueueWakeup({ isReady: () => !modal && pending > 0,
    process: () => { pending--; calls++; if (calls === 1) throw new Error('dispatch failed') },
    subscribe: [], onError: () => { errors++ }, pollMs: 5 })
  await delay(15)
  assert.equal(calls, 0)
  modal = false
  await delay(25)
  pump.stop()
  assert.equal(calls, 2)
  assert.equal(errors, 1)
  pending = 1; pump.wake(); await delay(10)
  assert.equal(calls, 2)
})

for (const release of ['completed', 'cancelled'] as const) {
  test(`two continue messages drain after ${release} even if the previous dispatch promise never settles`, async () => {
    const guard = new QueryGuard(), pending = ['initial task', 'continue', 'continue'], dispatched: string[] = []
    let generation = 0
    let startSecond!: () => void, startThird!: () => void
    const second = new Promise<void>(resolve => { startSecond = resolve })
    const third = new Promise<void>(resolve => { startThird = resolve })
    const pump = startGuardedQueueWakeup({ guard, isReady: () => pending.length > 0, subscribe: [], pollMs: 5,
      onError: error => assert.fail(String(error)), dispatch: () => {
        assert.equal(guard.reserve(), true)
        generation = guard.tryStart()!
        dispatched.push(pending.shift()!)
        if (dispatched.length === 1) return new Promise<void>(() => {})
        if (dispatched.length === 2) { startSecond(); return new Promise<void>(() => {}) }
        startThird()
      } })
    try {
      await delay(10)
      assert.deepEqual(dispatched, ['initial task'])
      const old = generation
      if (release === 'cancelled') guard.forceEnd(); else guard.end(old)
      await Promise.race([second, delay(1000).then(() => assert.fail('first continue was locked behind an obsolete promise'))])
      assert.equal(guard.isActive, true)
      assert.equal(guard.end(old), false, 'stale completion cannot release the second query')
      await delay(15)
      assert.deepEqual(dispatched, ['initial task', 'continue'], 'no concurrent foreground query')
      guard.end(generation)
      await Promise.race([third, delay(1000).then(() => assert.fail('second continue was lost'))])
      assert.deepEqual(dispatched, ['initial task', 'continue', 'continue'])
    } finally { pump.stop(); guard.forceEnd() }
  })
}

test('dispatch epochs preserve error reporting across preparation and model start', async () => {
  const guard = new QueryGuard(), errors: unknown[] = [], stale: unknown[] = []
  let pending = 2, rejectOld!: (error: Error) => void, generation = 0
  const pump = startGuardedQueueWakeup({ guard, isReady: () => pending > 0, subscribe: [], pollMs: 5,
    onError: error => errors.push(error), onStaleError: error => stale.push(error), dispatch: () => {
      pending--; guard.reserve()
      if (pending === 1) return new Promise<void>((_, reject) => { rejectOld = reject })
      generation = guard.tryStart()!
      return Promise.reject(new Error('current provider failed'))
    } })
  try {
    await delay(15)
    guard.tryStart() // same ownership epoch as its reservation
    rejectOld(new Error('current preparation failed'))
    await delay(15)
    assert.match(String(errors[0]), /current preparation failed/)
    guard.forceEnd()
    await delay(20)
    assert.match(String(errors[1]), /current provider failed/)
    assert.equal(stale.length, 0)
    assert.equal(guard.end(generation), true)
  } finally { pump.stop(); guard.forceEnd() }
})

test('late failure from a cancelled dispatch cannot report a new turn as failed', async () => {
  const guard = new QueryGuard(), errors: unknown[] = [], stale: unknown[] = []
  let pending = 2, rejectOld!: (error: Error) => void, generation = 0
  const pump = startGuardedQueueWakeup({ guard, isReady: () => pending > 0, subscribe: [], pollMs: 5,
    onError: error => errors.push(error), onStaleError: error => stale.push(error), dispatch: () => {
      pending--; guard.reserve(); generation = guard.tryStart()!
      if (pending === 1) return new Promise<void>((_, reject) => { rejectOld = reject })
      return new Promise<void>(() => {})
    } })
  try {
    await delay(15)
    guard.forceEnd()
    await delay(15)
    const error = new Error('obsolete adapter failed after cancel')
    rejectOld(error)
    await delay(15)
    assert.deepEqual(errors, [])
    assert.deepEqual(stale, [error])
    assert.equal(guard.isActive, true)
    assert.equal(guard.end(generation), true)
  } finally { pump.stop(); guard.forceEnd() }
})

test('readiness errors reach the error observer and do not kill queue polling', async () => {
  let checks = 0, calls = 0
  const errors: unknown[] = []
  const pump = startQueueWakeup({ isReady: () => { if (++checks === 1) throw new Error('queue state failed'); return calls === 0 },
    process: () => { calls++ }, subscribe: [], onError: error => errors.push(error), pollMs: 5 })
  try {
    await delay(25)
    assert.equal(calls, 1)
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]), /queue state failed/)
  } finally { pump.stop() }
})
