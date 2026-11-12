import { AsyncLocalStorage } from 'node:async_hooks'
import { configuredAutoGoalSessionId } from './autoGoalSessionId.ts'
import { getWorkload, WORKLOAD_CRON } from './workloadContext.ts'
export { configureAutoGoalSession } from './autoGoalSessionId.ts'

// A leaf module keeps the goal engine independently testable. The CLI binds
// its existing session identity; standalone callers retain legacy cwd scope.
const current = new AsyncLocalStorage<{ id: string | null }>()

/** A native scheduled tick executes its saved task under scheduler authority;
 * it neither inherits nor replaces the foreground conversation's objective. */
export function isAutoGoalBackgroundTurn(): boolean {
  return getWorkload() === WORKLOAD_CRON
}

export function getAutoGoalSessionId(): string | null {
  const snapshot = current.getStore()
  return snapshot ? snapshot.id : configuredAutoGoalSessionId()
}

/** Capture ownership before the first await. A late result/cleanup from an
 * outgoing query must never mutate the newly selected session's objective. */
export function runWithAutoGoalSession<T>(run: () => T, fresh = false): T {
  if (!fresh && current.getStore()) return run()
  return current.run({ id: fresh ? configuredAutoGoalSessionId() : getAutoGoalSessionId() }, run)
}
