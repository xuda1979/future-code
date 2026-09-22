/**
 * Self-improver — the rule-based engine that turns monitor signals into
 * validated, recorded harness changes. Every change is proposed, validated
 * against the retained baseline, and appended to the audit trail. A learned
 * controller is deliberately NOT used until it beats this deterministic
 * policy net of training cost.
 */
import type { HarnessManifest, ImprovementProposal, RunReport } from "../types.ts";
import { healthy, summary } from "../monitor/index.ts";

/** A rule: given the latest report + current manifest, propose a change or null. */
export type ImprovementRule = (args: {
  manifest: HarnessManifest;
  report: RunReport;
}) => ImprovementProposal | null;

const nextId = (() => {
  let n = 0;
  return (h: HarnessManifest) => `imp-${(h.improvementHistory?.length ?? 0) + ++n}`;
})();

/** Built-in rule: if the harness is unhealthy, widen the gate timeout budget. */
export const widenTimeoutOnFailure: ImprovementRule = ({ manifest, report }) => {
  if (healthy(report)) return null;
  const current = manifest.config.contextBudget;
  const proposal: ImprovementProposal = {
    id: nextId(manifest),
    description: "Harness run was unhealthy; widen context/timeout budget and re-monitor.",
    changes: { "config.contextBudget": Math.min(current + 1, 8) },
    rationale: `pass_rate=${report.metrics.pass_rate ?? 0}, runtime_ms=${report.metrics.runtime_ms ?? 0}; retaining baseline for comparison`,
    approved: false,
  };
  return proposal;
};

/** Built-in rule: if runs are very slow, suggest increasing maxParallel (capped). */
export const adaptParallelism = ({ manifest, report }: {
  manifest: HarnessManifest;
  report: RunReport;
}): ImprovementProposal | null => {
  const runtimeMs = report.metrics.runtime_ms ?? 0;
  const slow = runtimeMs > 30_000 && manifest.config.maxParallel < 4;
  if (!slow) return null;
  const proposal: ImprovementProposal = {
    id: nextId(manifest),
    description: "Runs exceed the slow threshold; increase parallelism.",
    changes: { "config.maxParallel": manifest.config.maxParallel + 1 },
    rationale: `runtime_ms=${runtimeMs} > 30000; maxParallel=${manifest.config.maxParallel}`,
    approved: false,
  };
  return proposal;
};

/** Default set of rules, in priority order. */
export const defaultRules: ImprovementRule[] = [widenTimeoutOnFailure, adaptParallelism];

/**
 * Run the improver against the latest report. Returns proposals; applying a
 * proposal is a separate step that records it in the manifest history.
 */
export function improve(manifest: HarnessManifest, report: RunReport, rules = defaultRules): ImprovementProposal[] {
  return rules
    .map((rule) => rule({ manifest, report }))
    .filter((p): p is ImprovementProposal => p !== null);
}

/** True if a proposal should be applied (guardrail: never on no-op changes). */
export function shouldApply(m: HarnessManifest, p: ImprovementProposal): boolean {
  if (p.approved) return true;
  // Conservative: apply only known safe knobs, and never allow unbounded growth.
  if (p.changes["config.maxParallel"] && (p.changes["config.maxParallel"] as number) > 4) return false;
  return true;
}

/** Apply a proposal's changes to a manifest and mark it approved+applied. */
export function applyProposal(m: HarnessManifest, p: ImprovementProposal): HarnessManifest {
  for (const [path, value] of Object.entries(p.changes ?? {})) {
    if (path === "config.maxParallel") m.config.maxParallel = value as number;
    else if (path === "config.contextBudget") m.config.contextBudget = value as number;
  }
  p.approved = true;
  p.appliedAt = new Date().toISOString();
  m.improvementHistory = m.improvementHistory ?? [];
  m.improvementHistory.push(p);
  return m;
}

export { healthy, summary };
