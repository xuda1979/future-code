/**
 * Mechanical guard against re-blocking TaskOutput waits.
 *
 * Transcript evidence (2026-11-16, mined across all live session
 * transcripts): 369 duplicate blocked TaskOutput calls on still-running
 * tasks; the worst session made 240 blocked calls (131 redundant),
 * freezing the whole session for a timeout window each time. Every
 * duplicate call received the "end your turn" hint and re-blocked
 * anyway — a textual hint cannot break the loop. This guard makes the
 * fix mechanical: once a blocking wait on a still-running task has
 * timed out, later blocked waits on that same task short-circuit
 * instantly. The completion <task-notification> still delivers the
 * result, and the guard clears as soon as the task is observed to be
 * no longer running.
 */

const MAX_GUARDED_TASKS = 100

/** Task IDs whose blocking wait already timed out while the task kept running. */
const timedOutBlockedTasks = new Set<string>()

/** Record that a blocking wait on `taskId` expired while the task was still running. */
export function noteBlockingTimeoutExpired(taskId: string): void {
  if (timedOutBlockedTasks.has(taskId)) {
    return
  }
  if (timedOutBlockedTasks.size >= MAX_GUARDED_TASKS) {
    // FIFO eviction: drop the oldest recorded task ID.
    const oldest = timedOutBlockedTasks.values().next().value
    if (oldest !== undefined) {
      timedOutBlockedTasks.delete(oldest)
    }
  }
  timedOutBlockedTasks.add(taskId)
}

/** True when a blocked wait on `taskId` must short-circuit instantly. */
export function shouldRefuseBlockedWait(taskId: string): boolean {
  return timedOutBlockedTasks.has(taskId)
}

/** Drop the guard once the task is no longer running (completed, failed, cancelled). */
export function clearReblockGuard(taskId: string): void {
  timedOutBlockedTasks.delete(taskId)
}

/** Test helper — clear all guarded task IDs. */
export function _resetReblockGuardForTest(): void {
  timedOutBlockedTasks.clear()
}
