/**
 * Self-monitor — evaluates the harness's SLOs against a run report and
 * summarizes health/cost/quality signals. This is the "look" part of the
 * self-improving loop.
 */
import type { HarnessManifest, RunReport, SloResult, HarnessRunRecord } from "../types.ts";

/** Evaluate every SLO in the manifest against a run report. */
export function evaluateSLOs(manifest: HarnessManifest, report: RunReport): SloResult[] {
  return manifest.slos.map((slo) => {
    const observed = report.metrics[slo.metric] ?? 0;
    let met = false;
    switch (slo.op) {
      case "gte": met = observed >= slo.threshold; break;
      case "lte": met = observed <= slo.threshold; break;
      case "lt": met = observed < slo.threshold; break;
      case "gt": met = observed > slo.threshold; break;
    }
    return { sloId: slo.id, met, observed, threshold: slo.threshold, op: slo.op };
  });
}

/** Merge SLO results into a report for downstream logic. */
export function annotate(manifest: HarnessManifest, report: RunReport): RunReport {
  report.sloResults = evaluateSLOs(manifest, report);
  return report;
}

/** True if every SLO is met (no unresolved failures). */
export function healthy(report: RunReport): boolean {
  return report.sloResults.every((s) => s.met);
}

/** Produce a compact health summary string for logging. */
export function summary(report: RunReport): {
  runId: string;
  healthy: boolean;
  passRate: number;
  runtimeMs: number;
  unmetSlo: string[];
} {
  return {
    runId: report.runId,
    healthy: healthy(report),
    passRate: report.metrics.pass_rate ?? 0,
    runtimeMs: report.metrics.runtime_ms ?? 0,
    unmetSlo: report.sloResults.filter((s) => !s.met).map((s) => s.sloId),
  };
}

/** Compute a health score (0–1) from a run report. */
export function healthScore(report: RunReport): number {
  const slos = report.sloResults;
  if (!slos.length) return 1;
  return slos.filter((s) => s.met).length / slos.length;
}

/** Detect degradation: compare recent pass-rate trend against a threshold. */
export function detectDegradation(history: HarnessRunRecord[], windowSize = 5): {
  degrading: boolean;
  trend: number;
  confidence: number;
} {
  if (history.length < 2) return { degrading: false, trend: 0, confidence: 0 };
  const recent = history.slice(-windowSize);
  const passRates = recent.map((r) => r.passRate);
  // Simple linear regression slope
  const n = passRates.length;
  const xMean = (n - 1) / 2;
  const yMean = passRates.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (passRates[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return {
    degrading: slope < -0.05, // pass rate dropping by more than 5% per run
    trend: Math.round(slope * 1000) / 1000,
    confidence: Math.min(n / windowSize, 1),
  };
}

/** Compute average runtime from recent history. */
export function averageRuntime(history: HarnessRunRecord[], windowSize = 10): number {
  if (!history.length) return 0;
  const recent = history.slice(-windowSize);
  return Math.round(recent.reduce((a, b) => a + b.durationMs, 0) / recent.length);
}

/** Check if runtime is trending upward (getting slower). */
export function isRuntimeDegrading(history: HarnessRunRecord[], windowSize = 5): boolean {
  if (history.length < windowSize) return false;
  const recent = history.slice(-windowSize);
  const first = recent.slice(0, Math.floor(windowSize / 2));
  const last = recent.slice(Math.floor(windowSize / 2));
  const avgFirst = first.reduce((a, b) => a + b.durationMs, 0) / first.length;
  const avgLast = last.reduce((a, b) => a + b.durationMs, 0) / last.length;
  // Degrading if last half is >50% slower than first half
  return avgLast > avgFirst * 1.5;
}
