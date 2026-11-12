import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

register('./task-output-memory-loader.mjs', import.meta.url)
const { TaskOutput } = await import('../../src/utils/task/TaskOutput.ts')
const { CircularBuffer } = await import('../../src/utils/CircularBuffer.ts')
const { _clearOutputsForTest, _resetTaskOutputDirForTest } = await import('../../src/utils/task/diskOutput.ts')

async function fixture(fn: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'task-output-memory-'))
  const previousDir = process.env.FUTURE_CODE_TEST_OUTPUT_DIR
  process.env.FUTURE_CODE_TEST_OUTPUT_DIR = dir
  _resetTaskOutputDirForTest()
  try {
    await fn()
  } finally {
    delete (globalThis as any).__taskOutputMemoryTail
    await _clearOutputsForTest()
    _resetTaskOutputDirForTest()
    if (previousDir === undefined) delete process.env.FUTURE_CODE_TEST_OUTPUT_DIR
    else process.env.FUTURE_CODE_TEST_OUTPUT_DIR = previousDir
    rmSync(dir, { recursive: true, force: true })
  }
}

test('pipe progress retains only the 100 readable lines, with identical previews and complete disk output', () => fixture(async () => {
  let maxRetained = 0
  const add = CircularBuffer.prototype.add
  CircularBuffer.prototype.add = function (item: unknown) {
    add.call(this, item)
    maxRetained = Math.max(maxRetained, this.length())
  }
  let last = ''
  let all = ''
  const output = new TaskOutput('pipe-progress', (l, a) => { last = l; all = a }, false, 32)
  const chunks = Array.from({ length: 1500 }, (_, i) => `\nline-${i}-` + 'x'.repeat(2000))
  try {
    for (const chunk of chunks) output.writeStdout(chunk)
    await output.flush()
    assert.equal(readFileSync(output.path, 'utf8'), chunks.join(''))
    assert.equal(all, chunks.slice(-100).map(s => s.slice(1)).join('\n'))
    assert.equal(last, chunks.slice(-5).map(s => s.slice(1)).join('\n'))
    assert.equal(output.totalLines, chunks.length)
    assert.equal(output.totalBytes, chunks.join('').length)
    const stdout = await output.getStdout()
    assert.ok(stdout.startsWith(last))
    assert.ok(stdout.includes(`Full output saved to: ${output.path}`))
    assert.ok(maxRetained <= 100, `Retained ${maxRetained} progress lines for a 100-line consumer`)
    output.clear()
    assert.equal(readFileSync(output.path, 'utf8'), chunks.join(''), 'Releasing progress must preserve the complete receipt')
  } finally {
    output.clear()
    CircularBuffer.prototype.add = add
  }
}))

test('file-mode output keeps the same inline bound and readable full receipt after release', () => fixture(async () => {
  const output = new TaskOutput('file-output', null, true)
  const content = 'command output\n'.repeat(4000)
  mkdirSync(dirname(output.path), { recursive: true })
  writeFileSync(output.path, content)
  try {
    assert.equal(await output.getStdout(), content.slice(0, 30000))
    assert.equal(output.outputFileRedundant, false)
    assert.equal(output.outputFileSize, Buffer.byteLength(content))
    output.clear()
    assert.equal(readFileSync(output.path, 'utf8'), content)
    assert.equal(await output.getStdout(), content.slice(0, 30000))
  } finally {
    output.clear()
  }
}))

test('a slow output read cannot stack polls, and does not block other tasks', t => fixture(async () => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let resolveSlow: ((value: any) => void) | undefined
  let slowReads = 0
  let fastReads = 0
  let slowUpdates = 0
  let fastUpdates = 0
  ;(globalThis as any).__taskOutputMemoryTail = (path: string) => {
    if (path.includes('slow-poll')) {
      slowReads++
      return new Promise(resolve => { resolveSlow = resolve })
    }
    fastReads++
    return Promise.resolve({ content: '', bytesRead: 0, bytesTotal: 0 })
  }
  const slow = new TaskOutput('slow-poll', () => slowUpdates++, true)
  const fast = new TaskOutput('fast-poll', () => fastUpdates++, true)
  try {
    TaskOutput.startPolling(slow.taskId)
    TaskOutput.startPolling(fast.taskId)
    for (let i = 0; i < 20; i++) {
      t.mock.timers.tick(1000)
      await Promise.resolve()
    }
    assert.equal(slowReads, 1, 'Only one pending read is allowed per task')
    assert.equal(fastReads, 20)
    assert.equal(fastUpdates, 20)
    resolveSlow!({ content: 'done\n', bytesRead: 5, bytesTotal: 5 })
    await Promise.resolve()
    assert.equal(slowUpdates, 1)
    t.mock.timers.tick(1000)
    await Promise.resolve()
    assert.equal(slowReads, 2, 'Polling resumes after I/O settles')
  } finally {
    slow.clear()
    fast.clear()
    resolveSlow?.({ content: '', bytesRead: 0, bytesTotal: 0 })
    await Promise.resolve()
  }
}))

test('stopping or clearing a task suppresses in-flight callbacks; failed reads can retry', t => fixture(async () => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const pending: Array<{ resolve: (result: any) => void; reject: (e: Error) => void }> = []
  ;(globalThis as any).__taskOutputMemoryTail = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  let updates = 0
  const output = new TaskOutput('stop-poll', () => updates++, true)
  try {
    TaskOutput.startPolling(output.taskId)
    t.mock.timers.tick(1000)
    pending[0]!.reject(new Error('temporary I/O failure'))
    await Promise.resolve()
    t.mock.timers.tick(1000)
    assert.equal(pending.length, 2)
    TaskOutput.stopPolling(output.taskId)
    pending[1]!.resolve({ content: 'stale\n', bytesRead: 6, bytesTotal: 6 })
    await Promise.resolve()
    assert.equal(updates, 0, 'Unmounted progress must not deliver late updates')
    TaskOutput.startPolling(output.taskId)
    t.mock.timers.tick(1000)
    assert.equal(pending.length, 3)
    output.clear()
    pending[2]!.resolve({ content: 'cleared\n', bytesRead: 8, bytesTotal: 8 })
    await Promise.resolve()
    TaskOutput.startPolling(output.taskId)
    t.mock.timers.tick(5000)
    assert.equal(pending.length, 3, 'Cleared output must be unregistered')
    assert.equal(updates, 0)
  } finally {
    output.clear()
  }
}))
