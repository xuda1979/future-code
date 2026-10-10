import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { QueryActivityMonitor, formatQueryActivity, notifyQueryActivity } from '../../src/utils/queryActivity.ts'

test('activity keeps publishing during a silent wait without changing conversation state', async () => {
  const history = [{ role: 'user', content: 'Perform research' }]
  const before = JSON.stringify(history)
  let at = 0
  const updates: ReturnType<QueryActivityMonitor['snapshot']>[] = []
  const monitor = new QueryActivityMonitor(s => updates.push(s), 5, () => at)
  try {
    monitor.observe({ kind: 'phase', phase: 'model' })
    monitor.observe({ kind: 'context', tokens: 65_100 })
    at = 30_000
    await delay(20)
    assert.ok(updates.length >= 3)
    assert.equal(updates.at(-1)?.quietMs, 30_000)
    assert.match(formatQueryActivity(updates.at(-1)!), /Waiting for model\/API.*30s since activity.*66k/)
    assert.equal(JSON.stringify(history), before)
    monitor.observe({ kind: 'progress' })
    at += 5000
    assert.equal(monitor.snapshot().quietMs, 5000)
    monitor.observe({ kind: 'phase', phase: 'tools' })
    assert.match(formatQueryActivity(monitor.snapshot()), /Waiting for tools\/jobs/)
  } finally { monitor.stop() }
  const count = updates.length
  await delay(15)
  assert.equal(updates.length, count)
})

test('observer failure never terminates work', () => {
  assert.doesNotThrow(() => notifyQueryActivity(() => { throw new Error('UI failed') }, { kind: 'progress' }))
  const monitor = new QueryActivityMonitor(() => { throw new Error('UI failed') })
  monitor.observe({ kind: 'phase', phase: 'compacting' })
  monitor.stop()
})
