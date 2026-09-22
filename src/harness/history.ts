import type { HarnessManifest, HarnessRunRecord, RunReport, SloResult } from "./types.ts";
import { loadManifest, saveManifest } from "./registry.ts";

export const DEFAULT_LIMIT = 100;

export function toRunRecord(report: RunReport): HarnessRunRecord {
  const passed = report.gates.filter((g) => g.passed).length;
  const unmet = report.sloResults.filter((s) => !s.met).map((s) => s.sloId);
  // Per-gate outcomes keyed by gateId — enables repeat-failure analysis
  // in the improver without needing the full report history.
  const gateResults: Record<string, boolean> = {};
  for (const g of report.gates) {
    if (g.gateId) gateResults[g.gateId] = g.passed;
  }
  return {
    runId: report.runId,
    task: report.task,
    startedAt: report.startedAt,
    durationMs: report.durationMs,
    passRate: report.metrics.pass_rate ?? (report.gates.length ? passed / report.gates.length : 0),
    healthy: unmet.length === 0,
    gateCount: report.gates.length,
    passedCount: passed,
    metrics: report.metrics,
    unmetSlo: unmet,
    gateResults,
  };
}

export function recordRun(projectRoot: string, report: RunReport, limit = DEFAULT_LIMIT): HarnessManifest {
  const m = loadManifest(projectRoot);
  const rec = toRunRecord(report);
  m.runHistory = m.runHistory ?? [];
  m.runHistory.push(rec);
  if (m.runHistory.length > limit) m.runHistory = m.runHistory.slice(-limit);
  saveManifest(projectRoot, m);
  return m;
}

export function recentRuns(projectRoot: string, n?: number): HarnessRunRecord[] {
  const m = loadManifest(projectRoot);
  const h = (m.runHistory ?? []).slice();
  return n && n < h.length ? h.slice(-n) : h;
}

export function passRateTrend(projectRoot: string, n = 10): number[] {
  return recentRuns(projectRoot, n).map((r) => r.passRate);
}

export function runtimeTrend(projectRoot: string, n = 10): number[] {
  return recentRuns(projectRoot, n).map((r) => r.durationMs);
}
