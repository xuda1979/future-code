import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskOutputTool } from '../../src/tools/TaskOutputTool/TaskOutputTool.tsx'
import {
  _resetReblockGuardForTest,
  noteBlockingTimeoutExpired,
  shouldRefuseBlockedWait,
} from '../../src/utils/task/reblockGuard.ts'

/**
 * Integration regression test: TaskOutputTool.call must refuse instant
 * re-blocks once a blocked wait on a still-running task has timed out.
 *
 * Mined transcript evidence (2026-11-16): sessions froze for hours on
 * repeated `block: true` TaskOutput calls against still-running tasks.
 * The tool now arms a guard when a blocking wait expires while the task
 * keeps running, and short-circuits subsequent blocked calls instead of
 * freezing the session for another full timeout. The guard disarms as
 * soon as the task reaches a terminal status.
 *
 * Runs under `bun test` because it imports the TSX tool module.
 */

type AnyTask = {
  id: string
  type: string
  status: string
  description: string
  command: string
  notified?: boolean
}

type CallResult = { data: { retrieval_status: string; task: Record<string, unknown> | null } }

const callTool = TaskOutputTool as unknown as {
  call: (
    input: { task_id: string; block?: boolean; timeout?: number },
    toolUseContext: unknown,
    canUseTool?: unknown,
    parentMessage?: unknown,
    onProgress?: unknown,
  ) => Promise<CallResult>
}

function makeTask(id: string, status: 'running' | 'completed'): AnyTask {
  return {
    id,
    // 'remote_agent' keeps getTaskOutputData on a dependency-free path:
    // no shellCommand plumbing, just the prompt passthrough.
    type: 'remote_agent',
    status,
    description: 're-block integration fixture',
    command: 'echo fixture',
  }
}

function makeContext(task: AnyTask) {
  let state = { tasks: { [task.id]: task } }
  return {
    getAppState: () => state,
    setAppState: (updater: (prev: typeof state) => typeof state) => {
      state = updater(state)
    },
    abortController: undefined,
  }
}

test('first blocked timeout arms the guard; an immediate re-block short-circuits', async () => {
  _resetReblockGuardForTest()
  try {
    const task = makeTask('reblock-it-1', 'running')
    const ctx = makeContext(task)

    // First blocked wait: the task never finishes, so it times out (~250ms).
    const first = await callTool.call({ task_id: task.id, block: true, timeout: 250 }, ctx)
    assert.equal(first.data.retrieval_status, 'timeout', 'first blocked wait must report timeout')
    assert.equal(shouldRefuseBlockedWait(task.id), true, 'guard must arm after the first timeout')

    // Second blocked wait: must be refused instantly, not wait 3 more seconds.
    const startedAt = Date.now()
    const second = await callTool.call({ task_id: task.id, block: true, timeout: 3000 }, ctx)
    const elapsed = Date.now() - startedAt
    assert.equal(second.data.retrieval_status, 'timeout', 'refused re-block must report timeout')
    assert.ok(
      elapsed < 1500,
      `refused re-block must return near-instantly (took ${elapsed}ms; a broken guard would wait the full 3000ms)`,
    )
    assert.equal((second.data.task as AnyTask | null)?.status, 'running')
  } finally {
    _resetReblockGuardForTest()
  }
})

test('non-blocking peek on a running task does not arm the guard', async () => {
  _resetReblockGuardForTest()
  try {
    const task = makeTask('reblock-it-2', 'running')
    const ctx = makeContext(task)

    const result = await callTool.call({ task_id: task.id, block: false, timeout: 5000 }, ctx)
    assert.equal(result.data.retrieval_status, 'not_ready')
    assert.equal(shouldRefuseBlockedWait(task.id), false, 'non-blocking peeks must never arm the guard')
  } finally {
    _resetReblockGuardForTest()
  }
})

test('non-blocking read of a finished task clears a stale guard and marks notified', async () => {
  _resetReblockGuardForTest()
  try {
    const task = makeTask('reblock-it-3', 'completed')
    const ctx = makeContext(task)
    // A guard left over from an earlier timeout while the task was running.
    noteBlockingTimeoutExpired(task.id)
    assert.equal(shouldRefuseBlockedWait(task.id), true)

    const result = await callTool.call({ task_id: task.id, block: false }, ctx)
    assert.equal(result.data.retrieval_status, 'success')
    assert.equal(shouldRefuseBlockedWait(task.id), false, 'finished task must clear the guard')

    const stored = (ctx.getAppState() as { tasks: Record<string, AnyTask> }).tasks[task.id]
    assert.equal(stored.notified, true, 'successful read must mark the task notified')
  } finally {
    _resetReblockGuardForTest()
  }
})

test('blocked call on a finished task succeeds immediately and clears the guard', async () => {
  _resetReblockGuardForTest()
  try {
    const task = makeTask('reblock-it-4', 'completed')
    const ctx = makeContext(task)
    noteBlockingTimeoutExpired(task.id)

    const startedAt = Date.now()
    const result = await callTool.call({ task_id: task.id, block: true, timeout: 5000 }, ctx)
    const elapsed = Date.now() - startedAt
    assert.equal(result.data.retrieval_status, 'success')
    assert.ok(elapsed < 1500, `completed task must not block (took ${elapsed}ms)`)
    assert.equal(shouldRefuseBlockedWait(task.id), false)

    const stored = (ctx.getAppState() as { tasks: Record<string, AnyTask> }).tasks[task.id]
    assert.equal(stored.notified, true)
  } finally {
    _resetReblockGuardForTest()
  }
})
