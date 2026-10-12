/** Coordinator-local hints only. Transport ceilings and durable tool admissions
 * remain authoritative; observed RPC timings never certify a tool result. */
export type BatchKind = "read" | "workspace-write";
interface Window { target: number; successful: number; latencies: number[]; failures: number }
export interface BatchSizingFeedback { target: number; p95Ms: number; failures: number }
/** Adapt per worker and effect class; the surrounding replay protocol owns failover. */
export class AdaptiveBatchSizing {
  private readonly windows = new Map<string, Window>();
  private readonly sampleSize = 8;
  private key(worker: string, kind: BatchKind): string { return worker + "\0" + kind; }
  width(worker: string, kind: BatchKind, byteSafeMax: number): number {
    const cap = Math.max(1, Math.min(32, Math.floor(byteSafeMax)));
    return Math.max(1, Math.min(cap, this.windows.get(this.key(worker, kind))?.target ?? cap));
  }
  observe(worker: string, kind: BatchKind, sample: {
    calls: number; durationMs: number; byteSafeMax: number; timeoutMs: number; ok: boolean;
  }): BatchSizingFeedback {
    const key = this.key(worker, kind);
    const cap = Math.max(1, Math.min(32, Math.floor(sample.byteSafeMax)));
    let window = this.windows.get(key);
    if (!window) { window = { target: cap, successful: 0, latencies: [], failures: 0 }; this.windows.set(key, window); }
    const duration = Number.isFinite(sample.durationMs) ? Math.max(0, sample.durationMs) : sample.timeoutMs;
    window.latencies.push(duration);
    if (window.latencies.length > this.sampleSize) window.latencies.shift();
    const sorted = [...window.latencies].sort((a, b) => a - b);
    const p95Ms = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
    const current = this.width(worker, kind, cap);
    // RPC failures are a proxy for network degradation, not measured packet loss.
    const pressured = !sample.ok || (sample.calls > 1 && duration >= sample.timeoutMs * 0.8);
    if (pressured) {
      if (!sample.ok) window.failures++;
      window.target = Math.max(1, Math.floor(current / 2));
      window.successful = 0;
    } else if (current < cap) {
      window.successful++;
      if (window.successful >= 2 && p95Ms < sample.timeoutMs * 0.8) {
        window.target = Math.min(cap, Math.max(current + 1, Math.ceil(current * 1.5)));
        window.successful = 0;
      }
    } else window.successful = 0;
    return { target: this.width(worker, kind, cap), p95Ms, failures: window.failures };
  }
}
