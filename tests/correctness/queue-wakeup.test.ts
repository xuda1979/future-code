import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { startQueueWakeup, hasMainThreadQueuedCommand } from '../../src/utils/queueWakeup.ts'
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
