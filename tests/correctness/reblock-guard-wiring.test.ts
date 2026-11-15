import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Dependency-free wiring regression for the mechanical TaskOutput re-block
 * guard (src/utils/task/reblockGuard.ts).
 *
 * Why static: TaskOutputTool.tsx imports React, and the offline correctness
 * gate runs with zero installed dependencies, so the behavioral integration
 * test (tests/correctness/task-output-reblock-integration.test.ts, verified
 * locally with bun) cannot run in CI. This test protects the same wiring
 * contract by asserting the guard's call ordering in the tool source:
 *
 *   1. the refusal check runs BEFORE the blocking wait,
 *   2. an expired blocking wait on a still-running task arms the guard,
 *   3. task completion clears the guard,
 *   4. a non-blocking peek clears the guard.
 *
 * Transcript evidence motivating the guard (2026-11-16 mining): 369 duplicate
 * blocked TaskOutput calls on still-running tasks across live sessions; the
 * worst session froze itself for 240 blocked calls (131 redundant).
 */

const source = readFileSync(
  new URL('../../src/tools/TaskOutputTool/TaskOutputTool.tsx', import.meta.url),
  'utf8',
)

test('TaskOutputTool imports all three re-block guard operations', () => {
  const importLine = source.match(
    /import \{[^}]*\} from '\.\.\/\.\.\/utils\/task\/reblockGuard\.js'/,
  )
  assert.ok(importLine, 'guard module import must exist')
  for (const fn of ['clearReblockGuard', 'noteBlockingTimeoutExpired', 'shouldRefuseBlockedWait']) {
    assert.ok(
      importLine[0].includes(fn),
      `guard import must include ${fn}`,
    )
  }
})

test('a guarded blocked wait is refused before the session-blocking wait starts', () => {
  const refuseCall = source.indexOf('shouldRefuseBlockedWait(task_id)')
  assert.ok(refuseCall > 0, 'refusal check must exist in the blocked-wait path')
  assert.match(
    source.slice(refuseCall - 300, refuseCall),
    /task\.status === 'running' \|\| task\.status === 'pending'/,
    'refusal must only apply to still-running tasks',
  )
  const refuseReturnEnd = source.indexOf('}', source.indexOf('return', refuseCall))
  assert.ok(refuseReturnEnd > 0)

  const blockingWaitCall = source.indexOf('await waitForTaskCompletion(')
  assert.ok(blockingWaitCall > 0, 'blocking wait call must exist')
  assert.ok(
    refuseCall < blockingWaitCall,
    'refusal must short-circuit before waitForTaskCompletion freezes the session',
  )
})

test('an expired blocking wait on a still-running task arms the guard', () => {
  assert.match(
    source,
    /completedTask\.status === 'running' \|\| completedTask\.status === 'pending'[\s\S]{0,800}?noteBlockingTimeoutExpired\(task_id\)/,
    'guard must be armed in the still-running timeout branch',
  )
})

test('task completion and non-blocking peeks clear the guard', () => {
  const clears = source.match(/clearReblockGuard\(task_id\);/g) ?? []
  assert.ok(clears.length >= 2, `expected >=2 clearReblockGuard calls, found ${clears.length}`)
  assert.match(
    source,
    /Task finished: drop the re-block guard[\s\S]{0,200}?clearReblockGuard\(task_id\);/,
    'completion path must clear the guard before marking notified',
  )
  assert.match(
    source,
    /if \(!block\) \{[\s\S]{0,600}?clearReblockGuard\(task_id\);/,
    'non-blocking path must clear the guard',
  )
})

test('timeout guidance tells the model re-waits are refused and to end its turn', () => {
  assert.match(
    source,
    /Blocked re-waits on this still-running task are now refused instantly\./,
    'timeout hint must state that blocked re-waits are refused',
  )
  assert.match(
    source,
    /Instead: end your turn/,
    'timeout hint must direct the model to end its turn',
  )
})
