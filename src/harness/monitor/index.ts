/**
 * Self-monitor — evaluates the harness's SLOs against a run report and
 * summarizes health/cost/quality signals. This is the "look" part of the
 * self-improving loop.
 */
import type { HarnessManifest, RunReport, SloResult } from "../types.ts";

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
