/** One optional display task per owner. Never wait for it on the work path.
 * A cancelled but uncooperative task still owns its slot until it settles. */
export class OpportunisticTask<T> {
  private job: {
    controller: AbortController
    settled: boolean
    discarded: boolean
    value: T | null
    detach: () => void
  } | undefined
  private disposed = false

  start(parent: AbortSignal, work: (signal: AbortSignal) => Promise<T | null>): boolean {
    if (this.disposed || this.job || parent.aborted) return false
    const controller = new AbortController()
    const abort = () => { this.take() }
    const job = { controller, settled: false, discarded: false, value: null as T | null,
      detach: () => parent.removeEventListener('abort', abort) }
    this.job = job
    parent.addEventListener('abort', abort, { once: true })
    const settle = (value: T | null) => {
      job.settled = true
      if (job.discarded) {
        job.detach()
        if (this.job === job) this.job = undefined
      } else job.value = value
    }
    try {
      // Observe rejection immediately, even if nobody ever polls this task.
      void Promise.resolve(work(controller.signal)).then(settle, () => settle(null))
    } catch { settle(null) }
    return true
  }

  /** Return only a ready value, once. Cancel late work without waiting for
   * abort acknowledgement, and reject its eventual output as obsolete. */
  take(): T | null {
    const job = this.job
    if (!job) return null
    const value = job.settled && !job.discarded ? job.value : null
    job.discarded = true
    job.value = null
    job.detach()
    job.controller.abort()
    if (job.settled) this.job = undefined
    return value
  }

  [Symbol.dispose](): void {
    this.disposed = true
    this.take()
  }
}
