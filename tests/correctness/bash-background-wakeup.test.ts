import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { register } from 'node:module'
import { bashBackgroundFixture } from './fixtures/bash-background-fixture.mjs'
register('./shell-command-background-loader.mjs', import.meta.url)
const { wrapSpawn } = await import('../../src/utils/ShellCommand.ts')

test('timeout releases an existing foreground task without another output poll', async () => {
  const f = bashBackgroundFixture()
  await f.startProgress()
  const pending = f.generator.next()
  let result: any
  void pending.then(value => { result = value })
  try {
    f.timeout()
    await f.turn()
    assert.ok(result, 'backgrounding must wake the foreground waiter even when output polling is stalled')
    assert.equal(result.done, true)
    assert.equal(result.value.backgroundTaskId, 'task-1')
    assert.equal(f.counts.executions, 1)
    assert.equal(f.counts.foreground, 1)
    assert.equal(f.counts.backgrounded, 1)
    assert.equal(f.counts.spawned, 0, 'never spawn or register the same task twice')
    assert.equal(f.counts.cleanup, 0, 'background task still owns its output')
    assert.equal(f.counts.pollStops, 1)
    assert.equal(f.shell.status, 'backgrounded')
  } finally {
    f.complete()
    await pending
  }
})

test('timeout still wakes a task that has no foreground registration', async () => {
  const f = bashBackgroundFixture({ showUI: false })
  await f.startProgress()
  const pending = f.generator.next()
  f.timeout()
  const result = await pending
  assert.equal(result.value.backgroundTaskId, 'task-1')
  assert.equal(f.counts.spawned, 1)
  assert.equal(f.counts.backgrounded, 0)
  f.complete()
})

test('a failed background transition keeps waiting for the actual result', async () => {
  const f = bashBackgroundFixture()
  await f.startProgress()
  const pending = f.generator.next()
  let settled = false
  void pending.then(() => { settled = true })
  f.shell.status = 'completed' // exit observed, result is still being collected
  f.timeout()
  await f.turn()
  assert.equal(settled, false)
  assert.equal(f.counts.backgrounded, 0)
  f.complete({ stdout: 'verified exit output', code: 7 })
  const result = await pending
  assert.equal(result.value.stdout, 'verified exit output')
  assert.equal(result.value.code, 7)
  assert.equal(result.value.backgroundTaskId, undefined)
  assert.equal(f.counts.cleanup, 1)
})

test('quick commands return their actual result without foreground/background registration', async () => {
  const f = bashBackgroundFixture()
  const abortListeners = getEventListeners(f.controller.signal, 'abort').length
  f.complete({ stdout: 'short command', code: 3 })
  const result = await f.generator.next()
  assert.equal(result.done, true)
  assert.equal(result.value.stdout, 'short command')
  assert.equal(result.value.code, 3)
  assert.equal(f.counts.foreground + f.counts.spawned + f.counts.backgrounded, 0)
  assert.equal(f.backgroundListeners.size, 0)
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, abortListeners)
})

test('completion that wins the background race preserves output and suppresses duplicate notification', async () => {
  const f = bashBackgroundFixture()
  await f.startProgress()
  const pending = f.generator.next()
  f.complete({ backgroundTaskId: 'task-1', stdout: 'finished output' })
  f.timeout()
  const result = await pending
  assert.equal(result.value.stdout, 'finished output')
  assert.equal(result.value.backgroundTaskId, undefined)
  assert.equal(result.value.outputFilePath, '/output')
  assert.equal(f.counts.notified, 1)
  assert.equal(f.counts.cleanup, 1)
})

test('user cancellation still returns the actual interrupted result', async () => {
  const f = bashBackgroundFixture()
  await f.startProgress()
  const pending = f.generator.next()
  f.controller.abort('cancel')
  const result = await pending
  assert.equal(result.value.interrupted, true)
  assert.equal(result.value.code, 137)
  assert.equal(f.counts.cleanup, 1)
  assert.equal(f.counts.pollStops, 1)
})

test('manual backgrounding observed on progress retains its existing notification contract', async () => {
  const f = bashBackgroundFixture()
  await f.startProgress()
  const pending = f.generator.next()
  f.shell.status = 'backgrounded'
  f.progress()
  const result = await pending
  assert.equal(result.value.backgroundTaskId, 'task-1')
  assert.equal(result.value.backgroundedByUser, true)
  assert.equal(f.counts.spawned + f.counts.backgrounded, 0)
  f.complete()
})

for (const beforeProgress of [false, true]) {
  test(`interrupt backgrounds the existing command without output polling (${beforeProgress ? 'before' : 'after'} progress)`, async () => {
    const f = bashBackgroundFixture()
    if (!beforeProgress) await f.startProgress()
    const pending = f.generator.next()
    await f.turn()
    let result: any
    void pending.then(value => { result = value })
    try {
      f.controller.abort('interrupt')
      await f.turn()
      assert.ok(result, 'new user input must not wait for command completion or a poll')
      assert.equal(result.value.backgroundTaskId, 'task-1')
      assert.equal(result.value.backgroundedByUser, undefined)
      assert.equal(f.counts.executions, 1)
      assert.equal(f.counts.spawned + f.counts.backgrounded, 1)
      assert.equal(f.counts.kills, 0)
      assert.equal(f.counts.cleanup, 0)
      assert.equal(f.backgroundListeners.size, 0)
    } finally { f.complete(); await pending }
  })
}

test('interrupt kills promptly when background tasks are explicitly disabled', async () => {
  const f = bashBackgroundFixture({ backgroundDisabled: true })
  await f.startProgress()
  const pending = f.generator.next()
  let result: any
  void pending.then(value => { result = value })
  try {
    f.controller.abort('interrupt')
    await f.turn()
    assert.ok(result)
    assert.equal(result.value.interrupted, true)
    assert.equal(f.counts.kills, 1)
    assert.equal(f.counts.spawned + f.counts.backgrounded, 0)
  } finally { f.complete(); await pending }
})

test('manual background notification wakes the collector without an output poll', async () => {
  const f = bashBackgroundFixture()
  await f.startProgress()
  const pending = f.generator.next()
  let result: any
  void pending.then(value => { result = value })
  try {
    f.shell.background()
    await f.turn()
    assert.ok(result)
    assert.equal(result.value.backgroundTaskId, 'task-1')
    assert.equal(result.value.backgroundedByUser, true)
    assert.equal(f.counts.spawned + f.counts.backgrounded, 0)
    assert.equal(f.backgroundListeners.size, 0)
  } finally { f.complete(); await pending }
})

function shellLifecycle() {
  const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, pid: 123 })
  const controller = new AbortController(), effects = { spills: 0, kills: 0 }
  ;(globalThis as any).__shellBackgroundKill = () => { effects.kills++ }
  const output = { stdoutToFile: false, spillToDisk() { effects.spills++ },
    async getStdout() { return 'actual output' }, getStderr() { return '' }, clear() {} }
  const shell = wrapSpawn(child as any, controller.signal, 60000, output as any)
  return { child, controller, effects, shell }
}

test('real ShellCommand publishes exactly one successful background transition and retains exit output', async () => {
  const f = shellLifecycle(), states: string[] = []
  const stop = f.shell.onBackground!(() => states.push(f.shell.status))
  assert.equal(f.shell.background('durable-task'), true)
  assert.equal(f.shell.background('duplicate'), false)
  assert.deepEqual(states, ['backgrounded'])
  assert.equal(f.effects.spills, 1)
  stop()
  f.child.emit('exit', 7, null)
  const result = await f.shell.result
  assert.equal(result.code, 7)
  assert.equal(result.stdout, 'actual output')
  assert.equal(result.backgroundTaskId, 'durable-task')
  f.shell.cleanup()
})

test('real ShellCommand unsubscribes observers and keeps cancellation distinct from backgrounding', async () => {
  const f = shellLifecycle()
  let notices = 0
  f.shell.onBackground!(() => { notices++ })()
  f.controller.abort('cancel')
  assert.equal(f.shell.background('must-not-register'), false)
  const result = await f.shell.result
  assert.equal(result.interrupted, true)
  assert.equal(f.effects.kills, 1)
  assert.equal(notices, 0)
  f.shell.cleanup()
})

test('a throwing background observer cannot undo task ownership transfer', async () => {
  const f = shellLifecycle()
  f.shell.onBackground!(() => { throw new Error('observer failed') })
  assert.equal(f.shell.background('durable-task'), true)
  f.child.emit('exit', 0, null)
  assert.equal((await f.shell.result).backgroundTaskId, 'durable-task')
  f.shell.cleanup()
})

test('real ShellCommand does not notify an unsubscribed observer on a successful handoff', async () => {
  const f = shellLifecycle()
  let notices = 0
  const stop = f.shell.onBackground!(() => { notices++ })
  stop(); stop()
  assert.equal(f.shell.background('durable-task'), true)
  assert.equal(notices, 0)
  f.child.emit('exit', 0, null)
  await f.shell.result
  f.shell.cleanup()
})

test('interrupt includes observed output and racing timeout never duplicates the task', async () => {
  const f = bashBackgroundFixture()
  await f.startProgress()
  const progress = f.generator.next()
  f.progress()
  await progress
  const pending = f.generator.next()
  f.controller.abort('interrupt')
  await f.turn()
  f.timeout()
  const result = await pending
  assert.equal(result.value.stdout, 'partial output')
  assert.equal(f.counts.executions, 1)
  assert.equal(f.counts.spawned + f.counts.backgrounded, 1)
  f.complete()
})

test('failed new task registration reports an error without repeating command execution', async () => {
  const f = bashBackgroundFixture({ showUI: false, spawnError: new Error('task registration failed') })
  await f.startProgress()
  const pending = f.generator.next()
  f.timeout()
  await assert.rejects(pending, /task registration failed/)
  assert.equal(f.counts.executions, 1)
  assert.equal(f.counts.spawned, 1)
  assert.equal(f.backgroundListeners.size, 0)
  f.complete()
})

test('initial completion/background race preserves output and releases listeners before progress starts', async () => {
  const f = bashBackgroundFixture()
  const abortListeners = getEventListeners(f.controller.signal, 'abort').length
  const pending = f.generator.next()
  await f.turn()
  f.complete({ backgroundTaskId: 'task-1', stdout: 'early completion output', code: 9 })
  f.controller.abort('interrupt')
  const result = await pending
  assert.equal(result.value.stdout, 'early completion output')
  assert.equal(result.value.code, 9)
  assert.equal(result.value.backgroundTaskId, undefined)
  assert.equal(result.value.outputFilePath, '/output')
  assert.equal(f.counts.notified, 1)
  assert.equal(f.counts.cleanup, 1)
  assert.equal(f.backgroundListeners.size, 0)
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, abortListeners)
})
