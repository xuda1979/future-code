import { performance } from 'node:perf_hooks';

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Timer callbacks cannot preempt a synchronous subprocess or a blocked loop.
export function observeTaskCompletion(startedAt, cutoffMs, independentCheck) {
  const completionWallMs = performance.now() - startedAt;
  return completionWallMs > cutoffMs ? {
    verdict: 'CENSORED', completionWallMs: null, independentCheck: null,
    lateCompletionWallMs: completionWallMs, lateIndependentCheck: independentCheck,
  } : { verdict: 'PASS', completionWallMs, independentCheck };
}
