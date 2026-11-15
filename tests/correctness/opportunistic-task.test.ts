import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { OpportunisticTask } from '../../src/utils/opportunisticTask.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('a ready label is returned once without aborting the parent', async () => {
  const parent = new AbortController(), task = new OpportunisticTask<string>()
  assert.equal(task.start(parent.signal, async () => 'finished reading'), true)
  await Promise.resolve()
  assert.equal(task.take(), 'finished reading')
  assert.equal(task.take(), null)
  assert.equal(parent.signal.aborted, false)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
})

test('a hung optional task is cancelled immediately and cannot publish late output', async () => {
  const parent = new AbortController(), pending = deferred<string>()
  const task = new OpportunisticTask<string>()
  let signal!: AbortSignal
  task.start(parent.signal, s => { signal = s; return pending.promise })
  assert.equal(task.take(), null)
  assert.equal(signal.aborted, true)
  assert.equal(parent.signal.aborted, false)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  assert.equal(task.start(parent.signal, async () => 'overlapping work'), false)
  pending.resolve('obsolete')
  await Promise.resolve()
  assert.equal(task.take(), null)
  assert.equal(task.start(parent.signal, async () => 'fresh'), true)
  await Promise.resolve()
  assert.equal(task.take(), 'fresh')
})

test('uncooperative cancellation stays single-flight over many work iterations', () => {
  const parent = new AbortController(), task = new OpportunisticTask<string>()
  let calls = 0
  for (let i = 0; i < 1000; i++) {
    task.start(parent.signal, () => { calls++; return new Promise(() => {}) })
    assert.equal(task.take(), null)
  }
  assert.equal(calls, 1)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  task[Symbol.dispose]()
})

test('errors, synchronous throws and late rejection remain optional', async () => {
  const parent = new AbortController(), task = new OpportunisticTask<string>()
  task.start(parent.signal, () => { throw new Error('sync failure') })
  assert.equal(task.take(), null)
  task.start(parent.signal, async () => { throw new Error('provider failure') })
  await Promise.resolve()
  assert.equal(task.take(), null)
  const pending = deferred<string>()
  task.start(parent.signal, () => pending.promise)
  task[Symbol.dispose]()
  pending.reject(new Error('late failure'))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(task.take(), null)
  assert.equal(task.start(parent.signal, async () => 'after disposal'), false)
})

test('parent cancellation discards ready or pending output and releases its listener', async () => {
  for (const ready of [false, true]) {
    const parent = new AbortController(), task = new OpportunisticTask<string>()
    let signal!: AbortSignal
    task.start(parent.signal, s => { signal = s; return ready ? Promise.resolve('label') : new Promise(() => {}) })
    if (ready) await Promise.resolve()
    parent.abort(new Error('operator stop'))
    assert.equal(task.take(), null)
    assert.equal(signal.aborted, true)
    assert.equal(task.start(parent.signal, async () => 'must not start'), false)
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  }
})

// Exercise the actual query-loop consume block, without importing the CLI/UI
// graph or replacing that block's await/poll decision with a test duplicate.
const source = readFileSync(new URL('../../src/query.ts', import.meta.url), 'utf8')
const start = source.indexOf('    if (pendingToolUseSummary) {')
const end = source.indexOf('    if (!needsFollowUp) {', start)
assert.ok(start > 0 && end > start)
const consume = new Function('pendingToolUseSummary', `return (async function* () { ${source.slice(start, end)} })()`)

test('production query consumes ready display labels and never waits for a hung label', async () => {
  const parent = new AbortController(), task = new OpportunisticTask<string>()
  task.start(parent.signal, async () => 'completed label')
  await Promise.resolve()
  const labels = []
  for await (const label of consume(task)) labels.push(label)
  assert.deepEqual(labels, ['completed label'])
  task.start(parent.signal, () => new Promise(() => {}))
  assert.deepEqual(await consume(task).next(), { value: undefined, done: true })
  task[Symbol.dispose]()
})

const retireStart = source.indexOf('    // Recovery transitions may drop their display label.')
const retireEnd = source.indexOf('    // Skill discovery prefetch', retireStart)
assert.ok(retireStart > 0 && retireEnd > retireStart)
const retire = new Function('pendingToolUseSummary', 'toolUseSummaryTask', source.slice(retireStart, retireEnd))

test('production recovery retires an orphaned label and permits a later fresh label', async () => {
  const parent = new AbortController(), task = new OpportunisticTask<string>(), pending = deferred<string>()
  let signal!: AbortSignal
  task.start(parent.signal, s => { signal = s; return pending.promise })
  retire(task, task)
  assert.equal(signal.aborted, false, 'an owned label still has the next model call to finish')
  retire(undefined, task)
  assert.equal(signal.aborted, true)
  assert.equal(task.start(parent.signal, async () => 'overlap'), false)
  pending.resolve('obsolete label')
  await Promise.resolve()
  assert.equal(task.start(parent.signal, async () => 'fresh label'), true)
  await Promise.resolve()
  assert.equal(task.take(), 'fresh label')
  assert.equal(parent.signal.aborted, false)
})

const generationStart = source.indexOf('    // Generate tool use summary after tool batch completes')
const generationEnd = source.indexOf('    // We were aborted during tool calls', generationStart)
assert.ok(generationStart > 0 && generationEnd > generationStart)
const generate = new Function('config', 'toolUseBlocks', 'toolUseContext', 'assistantMessages', 'toolResults',
  'toolUseSummaryTask', 'generateToolUseSummary', 'createToolUseSummaryMessage',
  stripTypeScriptTypes(source.slice(generationStart, generationEnd), { mode: 'transform' }) +
    '\nreturn nextPendingToolUseSummary;')

test('production generation preserves the feature/agent/cancellation gates and one-flight ownership', async () => {
  const task = new OpportunisticTask<string>(), parent = new AbortController()
  const pending = deferred<string>(), calls: any[] = []
  const blocks = [{ id: 'read', name: 'Read', input: { path: 'file' } }]
  const receipts = [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'actual evidence' }] } }]
  const run = (enabled = true, agentId?: string) => generate({ gates: { emitToolUseSummaries: enabled } }, blocks,
    { agentId, abortController: parent, options: {} }, [], receipts, task,
    (params: any) => { calls.push(params); return pending.promise }, (label: string) => label)
  assert.equal(run(false), undefined)
  assert.equal(run(true, 'child'), undefined)
  assert.equal(calls.length, 0)
  assert.equal(run(), task)
  assert.equal(calls.length, 1)
  assert.notEqual(calls[0].signal, parent.signal)
  assert.equal(calls[0].tools[0].output, 'actual evidence')
  assert.equal(task.take(), null)
  assert.equal(run(), undefined, 'an ignored cancellation must not launch another request')
  assert.equal(calls.length, 1)
  parent.abort()
  assert.equal(run(), undefined)
  pending.resolve('obsolete')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(task.take(), null)
  task[Symbol.dispose]()
})
