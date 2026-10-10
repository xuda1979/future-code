/** Activity is UI telemetry, never a conversation message or acceptance proof. */
export type QueryPhase = 'preparing' | 'compacting' | 'model' | 'model-tools' | 'tools' | 'stop-hooks' | 'continuing'
export type QueryActivityEvent =
  | { kind: 'phase'; phase: QueryPhase }
  | { kind: 'progress' }
  | { kind: 'context'; tokens: number }
export interface QueryActivitySnapshot {
  phase: QueryPhase
  elapsedMs: number
  quietMs: number
  contextTokens: number | null
}

export function notifyQueryActivity(observer: ((event: QueryActivityEvent) => void) | undefined, event: QueryActivityEvent): void {
  try { observer?.(event) } catch { /* An observer cannot fail a research task. */ }
}

export class QueryActivityMonitor {
  private phase: QueryPhase = 'preparing'
  private readonly started: number
  private lastProgress: number
  private tokens: number | null = null
  private stopped = false
  private readonly timer: ReturnType<typeof setInterval>
  private readonly observer: (snapshot: QueryActivitySnapshot) => void
  private readonly now: () => number
  constructor(observer: (snapshot: QueryActivitySnapshot) => void,
    intervalMs = 15_000, now: () => number = Date.now) {
    this.observer = observer
    this.now = now
    this.started = this.lastProgress = now()
    this.timer = setInterval(() => this.publish(), intervalMs)
    this.timer.unref?.()
    this.publish()
  }
  observe(event: QueryActivityEvent): void {
    if (this.stopped) return
    if (event.kind === 'phase') {
      this.phase = event.phase
      this.lastProgress = this.now()
      this.publish()
    } else if (event.kind === 'progress') this.lastProgress = this.now()
    else this.tokens = event.tokens
  }
  snapshot(): QueryActivitySnapshot {
    const at = this.now()
    return { phase: this.phase, elapsedMs: Math.max(0, at - this.started),
      quietMs: Math.max(0, at - this.lastProgress), contextTokens: this.tokens }
  }
  private publish(): void {
    if (this.stopped) return
    try { this.observer(this.snapshot()) } catch { /* UI telemetry is optional. */ }
  }
  stop(): void { this.stopped = true; clearInterval(this.timer) }
}

export function formatQueryActivity(snapshot: QueryActivitySnapshot): string {
  const labels: Record<QueryPhase, string> = { preparing: 'Preparing request', compacting: 'Compacting context',
    model: 'Waiting for model/API', 'model-tools': 'Model/API and tools active', tools: 'Waiting for tools/jobs', 'stop-hooks': 'Checking stop hooks', continuing: 'Continuing goal' }
  const quiet = Math.floor(snapshot.quietMs / 1000)
  const context = snapshot.contextTokens === null ? '' : ` · context ~${Math.ceil(snapshot.contextTokens / 1000)}k tokens`
  return `${labels[snapshot.phase]} · ${Math.floor(snapshot.elapsedMs / 1000)}s elapsed` +
    (quiet >= 15 ? ` · ${quiet}s since activity` : '') + context
}
