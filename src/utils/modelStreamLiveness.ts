/** Transport pings are not model progress. Explicit host retry-wait messages
 * keep their bounded wait alive; a lost heartbeat still hits the idle deadline.
 * Bound silent adapters even when they ignore abort. Never restart tool effects. */
export class ModelStreamStalledError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`Model/API produced no progress for ${Math.round(timeoutMs / 1000)}s`)
    this.name = 'ModelStreamStalledError'
    this.timeoutMs = timeoutMs
  }
}
/** Separate from transport idleness: token/retry heartbeats cannot reset it.
 * A deadline is bounded even when unattended transport recovery is enabled. */
export class ModelRequestDeadlineError extends ModelStreamStalledError {
  constructor(timeoutMs: number) {
    super(timeoutMs)
    this.name = 'ModelRequestDeadlineError'
    this.message = `Model request reached its time budget (${Math.round(timeoutMs / 1000)}s); continued thinking is not completed tool work`
  }
}
export function modelStreamIdleTimeout(value = process.env.FUTURE_CODE_MODEL_IDLE_TIMEOUT_MS): number {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 1000 && n <= 3_600_000 ? n : 180_000
}
export function isModelProgress(value: { type: string; event?: { type: string; delta?: { type: string } } }): boolean {
  if (value.type === 'assistant') return true
  return value.type === 'stream_event' && value.event?.type === 'content_block_delta' &&
    ['text_delta', 'thinking_delta', 'input_json_delta'].includes(value.event.delta?.type ?? '')
}
/** These system events are emitted by withRetry, outside provider/model content.
 * Recognizing a wait does not mark it as progress or certify any work. */
function isProviderRetryWait(value: unknown): boolean {
  const event = value as { type?: string; subtype?: string; retryInMs?: number; retryAttempt?: number } | null
  return event?.type === 'system' && event.subtype === 'api_error' &&
    Number.isFinite(event.retryInMs) && event.retryInMs! > 0 && event.retryInMs! <= 21_600_000 &&
    Number.isSafeInteger(event.retryAttempt) && event.retryAttempt! > 0
}
export function modelStallAction(admittedTools: number, recoveries: number, aborted: boolean, persistent = false): 'collect' | 'retry' | 'block' {
  if (aborted) return 'block'
  if (admittedTools > 0) return 'collect'
  return persistent || recoveries === 0 ? 'retry' : 'block'
}
export async function* watchModelStream<T>(create: (signal: AbortSignal) => AsyncIterable<T>, options: {
  signal: AbortSignal; timeoutMs: number; isProgress: (value: T) => boolean; maxDurationMs?: number
  /** Shared by sequential attempts/rounds in one foreground invocation.
   * Bounds model stream lifetime; tool/hook execution and verification are
   * collected separately and never cancelled by this controller. */
  timeBudget?: { remainingMs: number }
}): AsyncGenerator<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal.reason)
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()
  let iterator: AsyncIterator<T> | undefined
  const started = performance.now()
  const durationLimit = Math.min(options.maxDurationMs ?? Infinity, options.timeBudget?.remainingMs ?? Infinity)
  let lastLiveness = started
  let finished = false
  try {
    if (options.signal.aborted) return
    if (durationLimit <= 0) throw new ModelRequestDeadlineError(0)
    iterator = create(controller.signal)[Symbol.asyncIterator]()
    while (true) {
      if (controller.signal.aborted) throw controller.signal.reason
      const idleRemaining = options.timeoutMs - (performance.now() - lastLiveness)
      const requestRemaining = durationLimit - (performance.now() - started)
      const requestDeadline = requestRemaining <= idleRemaining && Number.isFinite(durationLimit)
      const remaining = Math.min(idleRemaining, requestRemaining)
      if (remaining <= 0) throw requestDeadline
        ? new ModelRequestDeadlineError(durationLimit) : new ModelStreamStalledError(options.timeoutMs)
      let timer: ReturnType<typeof setTimeout> | undefined
      let rejectAbort: () => void = () => {}
      const deadline = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', rejectAbort, { once: true })
        // Do not allocate an Error/stack for every healthy streamed token.
        timer = setTimeout(() => controller.abort(requestDeadline
          ? new ModelRequestDeadlineError(durationLimit) : new ModelStreamStalledError(options.timeoutMs)), Math.ceil(remaining))
      })
      let next: IteratorResult<T>
      try { next = await Promise.race([iterator.next(), deadline]) }
      catch (error) { if (options.signal.aborted) return; throw error }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAbort) }
      if (next.done) { finished = true; return }
      if (options.isProgress(next.value) || isProviderRetryWait(next.value)) lastLiveness = performance.now()
      yield next.value
    }
  } finally {
    if (options.timeBudget) options.timeBudget.remainingMs = Math.max(0, options.timeBudget.remainingMs - (performance.now() - started))
    options.signal.removeEventListener('abort', abort)
    controller.abort()
    // .return() may itself wait forever behind a hung .next(). Observe its
    // rejection, but never let cleanup hold the foreground query hostage.
    if (!finished && iterator?.return) {
      try { void Promise.resolve(iterator.return()).catch(() => {}) } catch { /* Best-effort cleanup. */ }
    }
  }
}
