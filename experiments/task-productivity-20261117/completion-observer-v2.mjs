import { performance } from 'node:perf_hooks';

// Timer callbacks cannot preempt a synchronous subprocess or a blocked loop.
export function observeTaskCompletion(startedAt, cutoffMs, independentCheck) {
  const completionWallMs = performance.now() - startedAt;
  return completionWallMs > cutoffMs ? {
    verdict: 'CENSORED', completionWallMs: null, independentCheck: null,
    lateCompletionWallMs: completionWallMs, lateIndependentCheck: independentCheck,
  } : { verdict: 'PASS', completionWallMs, independentCheck };
}
