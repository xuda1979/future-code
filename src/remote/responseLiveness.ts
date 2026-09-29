export type RemoteResponseWatchdogOptions = {
  responseTimeoutMs: number
  compactionTimeoutMs: number
  reconnectGraceMs: number
  maxReconnects: number
}

export type RemoteResponseWatchdogCallbacks = {
  isCompacting: () => boolean
  onReconnect: (attempt: number) => void
  onExhausted: () => void
}

const DEFAULTS: RemoteResponseWatchdogOptions = {
  responseTimeoutMs: 60_000,
  compactionTimeoutMs: 180_000,
  reconnectGraceMs: 60_000,
  maxReconnects: 1,
}

/**
 * Foreground remote-turn liveness watchdog.
 *
 * This is intentionally independent from WebSocket transport liveness:
 * user-message echoes and connection heartbeats prove only that the transport
 * moved bytes, not that the remote agent is making progress on the user's turn.
 *
 * Lifecycle:
 *   start -> progress* -> complete
 *             | stall
 *             v
 *          reconnect (bounded)
 *             | stall
 *             v
 *          exhausted
 *
 * Permission prompts pause the timer without completing the turn.
 */
export class RemoteResponseWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null
  private waiting = false
  private reconnectAttempts = 0
  private readonly options: RemoteResponseWatchdogOptions

  constructor(
    private readonly callbacks: RemoteResponseWatchdogCallbacks,
    options: Partial<RemoteResponseWatchdogOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
  }

  get isWaiting(): boolean {
    return this.waiting
  }

  start(): void {
    this.waiting = true
    this.reconnectAttempts = 0
    this.arm(this.currentTimeout())
  }

  /**
   * Record semantic foreground progress (assistant text/tool activity,
   * tool_result, compaction transition, etc.). Transport-only echoes should
   * never call this.
   */
  progress(): void {
    if (!this.waiting) return
    this.reconnectAttempts = 0
    this.arm(this.currentTimeout())
  }

  /** Pause while the user is deciding a permission prompt. */
  pause(): void {
    if (!this.waiting) return
    this.clearTimer()
  }

  /** Resume after a permission decision/cancellation. */
  resume(): void {
    if (!this.waiting) return
    this.arm(this.currentTimeout())
  }

  complete(): void {
    this.waiting = false
    this.reconnectAttempts = 0
    this.clearTimer()
  }

  dispose(): void {
    this.complete()
  }

  private currentTimeout(): number {
    return this.callbacks.isCompacting()
      ? this.options.compactionTimeoutMs
      : this.options.responseTimeoutMs
  }

  private arm(delayMs: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => this.onTimeout(), delayMs)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private onTimeout(): void {
    this.timer = null
    if (!this.waiting) return

    if (this.reconnectAttempts < this.options.maxReconnects) {
      this.reconnectAttempts += 1
      this.callbacks.onReconnect(this.reconnectAttempts)
      this.arm(this.options.reconnectGraceMs)
      return
    }

    this.waiting = false
    this.callbacks.onExhausted()
  }
}
