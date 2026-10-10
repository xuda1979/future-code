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
      if (stopped || inFlight || !options.isReady()) return
      inFlight = true
      try { await options.process() }
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
