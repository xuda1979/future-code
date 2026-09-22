/**
 * Context budget enforcer — ensures all agents (runtime, monitor, improver)
 * operate with bounded context. No agent should ever receive unbounded or
 * long context; everything that flows into an agent is capped, truncated,
 * or summarized to fit within the manifest's contextBudget.
 *
 * This module is the single chokepoint for context length enforcement.
 */

import type { HarnessManifest, HarnessRunRecord, RunReport, ImprovementProposal, RunResult } from "./types.ts";

/** Default context budget (in approximate tokens) when manifest doesn't specify. */
export const DEFAULT_CONTEXT_BUDGET = 4096;

/** Minimum context budget — agents always get at least this much. */
export const MIN_CONTEXT_BUDGET = 512;

/** Maximum context budget — even if config says more, we cap it. */
export const MAX_CONTEXT_BUDGET = 32768;

/**
 * Estimate the token footprint of a string.
 * Uses a simple heuristic: ~4 chars per token (industry rough average).
 * This is intentionally lightweight — no model tokenizer dependency.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Clamp a context budget to valid bounds. */
export function clampBudget(budget: number): number {
  if (Number.isNaN(budget) || budget < MIN_CONTEXT_BUDGET) return MIN_CONTEXT_BUDGET;
  if (budget === Infinity || budget > MAX_CONTEXT_BUDGET) return MAX_CONTEXT_BUDGET;
  return Math.floor(budget);
}

/** Resolve the effective context budget from a manifest. */
export function resolveBudget(manifest: HarnessManifest): number {
  const raw = manifest.config?.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  // contextBudget in the manifest is a multiplier; base is DEFAULT_CONTEXT_BUDGET
  const computed = raw * DEFAULT_CONTEXT_BUDGET;
  return clampBudget(computed);
}

/**
 * Truncate text to fit within a token budget, keeping head and tail.
 * Inserts a "[...truncated N tokens...]" marker in the middle.
 */
export function truncateToBudget(text: string, budgetTokens: number): string {
  const tokens = estimateTokens(text);
  if (tokens <= budgetTokens) return text;

  // Reserve space for the truncation marker itself
  const marker = `\n[...truncated ~${tokens - budgetTokens} tokens...]\n`;
  const markerTokens = estimateTokens(marker);
  let effectiveBudget = Math.max(budgetTokens - markerTokens, 1);

  // Keep 60% head, 40% tail of the effective budget
  let headBudget = Math.floor(effectiveBudget * 0.6);
  let tailBudget = effectiveBudget - headBudget;
  let headChars = headBudget * 4;
  let tailChars = tailBudget * 4;

  let result = text.slice(0, headChars) + marker + text.slice(-tailChars);

  // Safety: if result still exceeds budget (due to rounding), trim tail
  while (estimateTokens(result) > budgetTokens && tailChars > 0) {
    tailChars -= 4;
    result = text.slice(0, headChars) + marker + text.slice(-tailChars);
  }

  return result;
}

/**
 * Summarize a run report into a compact context-safe representation.
 * Instead of passing the full report (which can be huge with many gates),
 * we produce a compact summary that fits within the budget.
 */
export function compactRunReport(report: RunReport, budgetTokens: number): string {
  const lines: string[] = [
    `runId=${report.runId}`,
    `task=${report.task}`,
    `durationMs=${report.durationMs}`,
    `gateCount=${report.gates.length}`,
    `passRate=${report.metrics.pass_rate ?? 0}`,
  ];

  // Summarize gate results — only id, passed, exitCode, duration
  for (const g of report.gates) {
    lines.push(`  gate:${g.toolId} passed=${g.passed} exit=${g.exitCode} ms=${g.durationMs}`);
  }

  // SLO results (compact)
  for (const s of report.sloResults) {
    lines.push(`  slo:${s.sloId} met=${s.met} observed=${s.observed}`);
  }

  const full = lines.join("\n");
  return truncateToBudget(full, budgetTokens);
}

/**
 * Compact a list of run records into a bounded summary for the monitor/improver.
 * Instead of passing all history records (which grows unbounded), we produce
 * a statistical summary + recent N records, capped to the budget.
 */
export function compactRunHistory(
  history: HarnessRunRecord[],
  budgetTokens: number,
  recentN = 10,
): string {
  if (history.length === 0) return "(no run history)";

  const total = history.length;
  const passed = history.filter((r) => r.healthy).length;
  const avgPassRate = history.reduce((a, b) => a + b.passRate, 0) / total;
  const avgRuntime = history.reduce((a, b) => a + b.durationMs, 0) / total;
  const lastRun = history[history.length - 1];

  const lines: string[] = [
    `history: ${total} runs, ${passed} healthy, avgPassRate=${avgPassRate.toFixed(3)}, avgRuntimeMs=${Math.round(avgRuntime)}`,
    `lastRun: id=${lastRun.runId} passRate=${lastRun.passRate} healthy=${lastRun.healthy} ms=${lastRun.durationMs}`,
  ];

  // Include recent N records (or fewer if history is short)
  const recent = history.slice(-Math.min(recentN, total));
  for (const r of recent) {
    lines.push(`  run:${r.runId} pass=${r.passRate} ok=${r.healthy} ms=${r.durationMs} unmet=${r.unmetSlo.length}`);
  }

  const full = lines.join("\n");
  return truncateToBudget(full, budgetTokens);
}

/**
 * Compact improvement history into a bounded summary.
 * Only keeps the most recent proposals and a count of total proposals.
 */
export function compactImprovementHistory(
  history: ImprovementProposal[],
  budgetTokens: number,
  recentN = 5,
): string {
  if (history.length === 0) return "(no improvements)";

  const lines: string[] = [`improvements: ${history.length} total`];

  const recent = history.slice(-Math.min(recentN, history.length));
  for (const p of recent) {
    lines.push(`  ${p.id}: ${p.description} approved=${p.approved} at=${p.appliedAt ?? "n/a"}`);
  }

  const full = lines.join("\n");
  return truncateToBudget(full, budgetTokens);
}

/**
 * Build a bounded context payload for the runtime agent.
 * This is what the runtime passes to each gate execution — never the full task,
 * always a budget-compliant slice.
 */
export function boundedTaskContext(
  task: string,
  manifest: HarnessManifest,
  budgetTokens?: number,
): string {
  const budget = budgetTokens ?? resolveBudget(manifest);
  // Reserve 20% for gate metadata, 80% for the task itself
  const taskBudget = Math.floor(budget * 0.8);
  return truncateToBudget(task, taskBudget);
}

/**
 * Build a bounded context payload for the monitor agent.
 * Combines the latest run report + compacted history, all within budget.
 */
export function boundedMonitorContext(
  report: RunReport,
  history: HarnessRunRecord[],
  manifest: HarnessManifest,
  budgetTokens?: number,
): string {
  const budget = budgetTokens ?? resolveBudget(manifest);
  // Split: 40% for report, 40% for history, 20% for overhead
  const reportBudget = Math.floor(budget * 0.4);
  const historyBudget = Math.floor(budget * 0.4);

  const reportCompact = compactRunReport(report, reportBudget);
  const historyCompact = compactRunHistory(history, historyBudget);

  return `=== RUN REPORT ===\n${reportCompact}\n\n=== HISTORY ===\n${historyCompact}`;
}

/**
 * Build a bounded context payload for the improver agent.
 * Combines the monitor summary + compacted improvement history, within budget.
 */
export function boundedImproverContext(
  report: RunReport,
  history: HarnessRunRecord[],
  improvementHistory: ImprovementProposal[],
  manifest: HarnessManifest,
  budgetTokens?: number,
): string {
  const budget = budgetTokens ?? resolveBudget(manifest);
  // Split: 30% report, 30% history, 30% improvements, 10% overhead
  const reportBudget = Math.floor(budget * 0.3);
  const historyBudget = Math.floor(budget * 0.3);
  const improvementBudget = Math.floor(budget * 0.3);

  const reportCompact = compactRunReport(report, reportBudget);
  const historyCompact = compactRunHistory(history, historyBudget);
  const improvementsCompact = compactImprovementHistory(improvementHistory, improvementBudget);

  return [
    "=== RUN REPORT ===",
    reportCompact,
    "",
    "=== HISTORY ===",
    historyCompact,
    "",
    "=== IMPROVEMENTS ===",
    improvementsCompact,
  ].join("\n");
}

/**
 * Check whether a given text would fit within the manifest's context budget.
 * Returns true if within budget, false if it would need truncation.
 */
export function withinBudget(text: string, manifest: HarnessManifest): boolean {
  return estimateTokens(text) <= resolveBudget(manifest);
}

/**
 * Context budget report — a structured summary of how much context
 * each agent is consuming, for observability and SLO enforcement.
 */
export interface ContextUsageReport {
  agent: string;
  budgetTokens: number;
  usedTokens: number;
  utilization: number;
  truncated: boolean;
}

/** Compute a context usage report for a given agent's payload. */
export function contextUsage(
  agent: string,
  payload: string,
  manifest: HarnessManifest,
  truncated: boolean,
): ContextUsageReport {
  const budget = resolveBudget(manifest);
  const used = estimateTokens(payload);
  return {
    agent,
    budgetTokens: budget,
    usedTokens: used,
    utilization: budget > 0 ? used / budget : 0,
    truncated,
  };
}
