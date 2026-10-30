/** Main-thread queue wake-up independent of React/Ink rendering. The periodic
 * read is a fallback for missed notifications, never an extra model request. */
export function hasMainThreadQueuedCommand(commands: readonly { agentId?: string }[]): boolean {
  return commands.some(command => command.agentId === undefined)
}

export function startQueueWakeup(options: {
  isReady: () => boolean
  process: () => Promise<void> | void
  subscribe: Array<(wake: () => void) => () => void>
  onError: (error: unknown) => void
  pollMs?: number
}): { wake: () => void; stop: () => void } {
  let stopped = false
  let scheduled = false
  let inFlight = false
  let requested = false
  const wake = () => {
    if (stopped) return
    if (scheduled || inFlight) { requested = true; return }
    scheduled = true
    queueMicrotask(async () => {
      scheduled = false
      if (stopped || inFlight) return
      inFlight = true
      try { if (options.isReady()) await options.process() }
      catch (error) { try { options.onError(error) } catch { /* Observers cannot break the pump. */ } }
      finally {
        inFlight = false
        if (requested) { requested = false; wake() }
      }
    })
  }
  const unsubscribe = options.subscribe.map(subscribe => subscribe(wake))
  const timer = setInterval(wake, options.pollMs ?? 1000)
  timer.unref?.()
  wake()
  return { wake, stop: () => { stopped = true; clearInterval(timer); for (const off of unsubscribe) off() } }
}

/** QueryGuard owns foreground serialization. A cancelled/released generation
 * may leave an adapter or bookkeeping promise unresolved; that promise must
 * not become a second, permanent lock on queued user input. dispatch() must
 * synchronously reserve the guard before its first await (executeUserInput does).
 * Late failures are still observed, never used to release a newer generation. */
export function startGuardedQueueWakeup(options: {
  guard: { readonly isActive: boolean; readonly epoch: number; subscribe: (wake: () => void) => () => void }
  isReady: () => boolean
  dispatch: () => Promise<void> | void
  subscribe: Array<(wake: () => void) => () => void>
  onError: (error: unknown) => void
  onStaleError?: (error: unknown) => void
  pollMs?: number
}): ReturnType<typeof startQueueWakeup> {
  const report = (error: unknown) => { try { options.onError(error) } catch { /* Observer failure is not a queue lock. */ } }
  return startQueueWakeup({
    isReady: () => !options.guard.isActive && options.isReady(),
    process: () => {
      const completion = options.dispatch()
      const epoch = options.guard.epoch
      if (completion) void Promise.resolve(completion).catch(error => {
        if (options.guard.epoch === epoch) report(error)
        else { try { options.onStaleError?.(error) } catch { /* Late errors cannot alter current ownership. */ } }
      })
    },
    subscribe: [options.guard.subscribe, ...options.subscribe],
    onError: report,
    pollMs: options.pollMs,
  })
}
