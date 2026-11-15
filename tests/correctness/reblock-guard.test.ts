import test from 'node:test'
import assert from 'node:assert/strict'
import {
  _resetReblockGuardForTest,
  clearReblockGuard,
  noteBlockingTimeoutExpired,
  shouldRefuseBlockedWait,
} from '../../src/utils/task/reblockGuard.ts'

/**
 * Regression test for the mechanical TaskOutput re-block guard.
 *
 * Transcript evidence (2026-11-16, mined across all live session
 * transcripts): 369 duplicate blocked TaskOutput calls on still-running
 * tasks — the worst session made 240 blocked calls, freezing the whole
 * session for hours. Once a blocked wait times out while the task keeps
 * running, re-blocking must be refused instantly instead of freezing the
 * session for yet another full timeout.
 *
 * The guard module is deliberately dependency-free so this test can run
 * under `node --experimental-strip-types` without loader hooks.
 */

test('guard arms only after noteBlockingTimeoutExpired and stays idempotent', () => {
  _resetReblockGuardForTest()
  try {
    assert.equal(shouldRefuseBlockedWait('task-a'), false, 'unknown task must not be guarded')
    noteBlockingTimeoutExpired('task-a')
    assert.equal(shouldRefuseBlockedWait('task-a'), true, 'guarded task must refuse blocked waits')
    // Re-noting must be a no-op (no duplicate bookkeeping, no eviction churn).
    noteBlockingTimeoutExpired('task-a')
    assert.equal(shouldRefuseBlockedWait('task-a'), true)
  } finally {
    _resetReblockGuardForTest()
  }
})

test('guard disarms when the task is no longer running', () => {
  _resetReblockGuardForTest()
  try {
    noteBlockingTimeoutExpired('task-b')
    clearReblockGuard('task-b')
    assert.equal(shouldRefuseBlockedWait('task-b'), false, 'cleared task must not be guarded')
    // Clearing an unguarded task must be a safe no-op.
    clearReblockGuard('task-b')
    assert.equal(shouldRefuseBlockedWait('task-b'), false)
  } finally {
    _resetReblockGuardForTest()
  }
})

test('guard bounds memory with FIFO eviction at 100 tasks', () => {
  _resetReblockGuardForTest()
  try {
    for (let i = 0; i < 100; i++) {
      noteBlockingTimeoutExpired(`task-${i}`)
    }
    assert.equal(shouldRefuseBlockedWait('task-0'), true)
    assert.equal(shouldRefuseBlockedWait('task-99'), true)

    // The 101st distinct guarded task evicts the oldest (task-0).
    noteBlockingTimeoutExpired('task-100')
    assert.equal(shouldRefuseBlockedWait('task-0'), false, 'oldest guarded task must be evicted FIFO')
    assert.equal(shouldRefuseBlockedWait('task-99'), true)
    assert.equal(shouldRefuseBlockedWait('task-100'), true, 'newest guarded task must be kept')
  } finally {
    _resetReblockGuardForTest()
  }
})
