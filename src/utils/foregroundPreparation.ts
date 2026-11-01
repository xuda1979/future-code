/** Deadlines for host preparation only. Never put tools, jobs, permission
 * decisions or the entire research objective under this deadline. */
export class ForegroundPreparationTimeoutError extends Error {
  constructor(phase: string, timeoutMs: number) {
    super(`Request preparation stalled in ${phase} for ${Math.round(timeoutMs / 1000)}s. ` +
      'Check the named hook/context dependency. No model or tool work was restarted.')
    this.name = 'ForegroundPreparationTimeoutError'
  }
}

export function foregroundPreparationTimeout(value = process.env.FUTURE_CODE_PREPARATION_TIMEOUT_MS): number {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 1000 && n <= 3_600_000 ? n : 120_000
}

/** Abort/deadline wins even when the underlying read ignores cancellation.
 * Observe late rejection, release listeners/timers, and never publish a late
 * return into a new foreground generation. This helper never replays work. */
export async function waitForForegroundPreparation<T>(phase: string, start: () => PromiseLike<T> | T,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const { signal, timeoutMs = foregroundPreparationTimeout() } = options
  if (signal?.aborted) throw signal.reason
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => reject(new ForegroundPreparationTimeoutError(phase, timeoutMs)), timeoutMs)
  })
  try { return await Promise.race([Promise.resolve().then(() => { signal?.throwIfAborted(); return start() }), deadline]) }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
}

type HookOutcome<T> = { ok: true; messages: T[] } | { ok: false; error: unknown }

/** One SessionStart invocation, including after a timeout or another continue.
 * Promise rejection is observed immediately, before React effects or a user
 * submission. A timeout never bypasses a required hook or runs it twice. */
export class DeferredHookGate<T> {
  private result: Promise<HookOutcome<T>>
  private delivered = false
  constructor(pending?: Promise<T[]>) {
    this.result = pending ? pending.then(
      messages => ({ ok: true as const, messages }), error => ({ ok: false as const, error }),
    ) : Promise.resolve({ ok: true, messages: [] })
  }
  private deliver(result: HookOutcome<T>, publish: (messages: T[]) => void): void {
    if (!result.ok) throw result.error
    if (this.delivered) return
    if (result.messages.length) publish(result.messages)
    this.delivered = true
    this.result = Promise.resolve({ ok: true, messages: [] })
  }
  observe(publish: (messages: T[]) => void, onError: (error: unknown) => void): () => void {
    let active = true
    void this.result.then(result => { if (active) this.deliver(result, publish) })
      .catch(error => { if (active) { try { onError(error) } catch { /* Error display cannot reject a hook promise. */ } } })
    return () => { active = false }
  }
  async wait(publish: (messages: T[]) => void,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    if (this.delivered) return
    const result = await waitForForegroundPreparation('SessionStart hooks', () => this.result, options)
    this.deliver(result, publish)
  }
}
