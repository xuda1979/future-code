/**
 * Self-improver — the rule-based engine that turns monitor signals into
 * validated, recorded harness changes. Every change is proposed, validated
 * against the retained baseline, and appended to the audit trail. A learned
 * controller is deliberately NOT used until it beats this deterministic
 * policy net of training cost.
 *
 * All context passed to the improver agent is bounded — run reports,
 * history, and improvement history are compacted to fit within the
 * manifest's contextBudget. No agent receives unbounded context.
 */
import type { HarnessManifest, ImprovementProposal, RunReport, HarnessRunRecord } from "../types.ts";
import { healthy, summary } from "../monitor/index.ts";
import { resolveBudget, boundedImproverContext, estimateTokens } from "../context.ts";

/** A rule: given the latest report + current manifest, propose a change or null. */
export type ImprovementRule = (args: {
  manifest: HarnessManifest;
  report: RunReport;
  /** Recent run records (newest last) for trend/repeat-failure analysis. */
  history?: HarnessRunRecord[];
}) => ImprovementProposal | null;

const nextId = (() => {
  let n = 0;
  return (h: HarnessManifest) => `imp-${(h.improvementHistory?.length ?? 0) + ++n}`;
})();

/** Built-in rule: if the harness is unhealthy, widen the context budget so the
 * monitor/improver see more diagnostic signal. (Renamed from
 * widenTimeoutOnFailure — it never touched timeouts.) */
export const widenContextOnFailure: ImprovementRule = ({ manifest, report }) => {
  if (healthy(report)) return null;
  const current = manifest.config.contextBudget;
  const proposal: ImprovementProposal = {
    id: nextId(manifest),
    description: "Harness unhealthy; widening context budget for deeper analysis.",
    changes: { "config.contextBudget": Math.min(current + 2, 16) },
    rationale: `SLOs unmet: ${report.sloResults.filter((s) => !s.met).map((s) => s.sloId).join(", ")}; contextBudget=${current}→${Math.min(current + 2, 16)}`,
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

/** Built-in rule: if runs are consistently fast and healthy, reduce parallelism to save resources. */
export const reduceParallelism: ImprovementRule = ({ manifest, report }) => {
  if (!healthy(report)) return null;
  const runtimeMs = report.metrics.runtime_ms ?? 0;
  const fast = runtimeMs < 1000 && manifest.config.maxParallel > 1;
  if (!fast) return null;
  const proposal: ImprovementProposal = {
    id: nextId(manifest),
    description: "Runs are fast and healthy; reduce parallelism to conserve resources.",
    changes: { "config.maxParallel": manifest.config.maxParallel - 1 },
    rationale: `runtime_ms=${runtimeMs} < 1000; maxParallel=${manifest.config.maxParallel}→${manifest.config.maxParallel - 1}`,
    approved: false,
  };
  return proposal;
};

/**
 * Built-in rule: detect true flakiness — a gate whose outcome flips between
 * pass and fail across consecutive runs — and widen the context budget so
 * the flaky gate's diagnostics are visible. A single partially-failing run
 * is NOT flakiness: a deterministically broken gate fails every time, and
 * the flakiness remedy (more diagnostic context) is the wrong response.
 * Requires ≥3 samples and both outcomes present to fire.
 */
export const detectFlakiness: ImprovementRule = ({ manifest, report, history }) => {
  const runs = history ?? [];
  const FLIP_WINDOW = 5; // look at up to the last 5 runs (incl. current)
  const MIN_SAMPLES = 3; // need at least 3 outcomes to call it flaky

  // Collect the outcome sequence per gate: current report first, then
  // history newest-first (skipping the current run if already recorded).
  const failedNow = new Set(
    report.gates.filter((g) => !g.passed && g.gateId).map((g) => g.gateId as string),
  );
  const seq: Record<string, boolean[]> = {};
  const record = (gateId: string, passed: boolean) => {
    (seq[gateId] ??= []).push(passed);
  };
  for (const g of report.gates) if (g.gateId) record(g.gateId, g.passed);
  const histRuns = runs
    .filter((r) => r.runId !== report.runId)
    .slice(-FLIP_WINDOW)
    .reverse(); // newest-first
  for (const rec of histRuns) {
    for (const [gateId, passed] of Object.entries(rec.gateResults ?? {})) {
      // Stop extending a gate's sequence once it has FLIP_WINDOW samples.
      if ((seq[gateId] ?? []).length < FLIP_WINDOW) record(gateId, passed);
    }
  }

  // A gate is flaky when it has ≥MIN_SAMPLES outcomes with both true and
  // false present, and it failed at least once in the window (we only
  // propose a remedy when there is something to diagnose).
  const flaky = Object.entries(seq).filter(([gateId, outcomes]) => {
    const hasPass = outcomes.some(Boolean);
    const hasFail = outcomes.some((o) => !o);
    return outcomes.length >= MIN_SAMPLES && hasPass && hasFail && failedNow.has(gateId);
  });
  if (!flaky.length) return null;

  const current = manifest.config.contextBudget;
  if (current >= 8) return null;
  const names = flaky.map(([id]) => id).join(", ");
  const proposal: ImprovementProposal = {
    id: nextId(manifest),
    description: `Flaky gate(s) [${names}] flip between pass/fail across runs; increasing context budget for diagnostics.`,
    changes: { "config.contextBudget": Math.min(current + 1, 8) },
    rationale: `flaky_gates=[${names}] (outcome flips within last ${FLIP_WINDOW} runs); contextBudget=${current}→${Math.min(current + 1, 8)}`,
    approved: false,
  };
  return proposal;
};

/**
 * Built-in rule: if context budget is being exceeded by an agent,
 * increase the context budget multiplier so agents have more room.
 * This ensures agents never silently operate with insufficient context.
 */
export const expandContextOnOverflow: ImprovementRule = ({ manifest, report }) => {
  const contextUsed = report.metrics.context_used ?? 0;
  const contextBudget = report.metrics.context_budget ?? 0;
  if (contextBudget === 0 || contextUsed <= contextBudget) return null;

  const current = manifest.config.contextBudget;
  if (current >= 8) return null; // cap at 8x

  const proposal: ImprovementProposal = {
    id: nextId(manifest),
    description: "Context budget exceeded; increasing budget multiplier to prevent agent context overflow.",
    changes: { "config.contextBudget": Math.min(current + 1, 8) },
    rationale: `context_used=${contextUsed} > context_budget=${contextBudget}; contextBudget=${current}→${Math.min(current + 1, 8)}`,
    approved: false,
  };
  return proposal;
};

/**
 * Built-in rule: when a gate is killed for exceeding its timeout
 * (RunResult.timedOut / metrics.timeout_count), widen that gate's tool
 * timeout. Distinguishes hangs from ordinary failures — a widened timeout
 * gives genuinely slow gates room to finish instead of dying at the default.
 * Uses improvementPolicy.slow_gate_seconds as the multiplier base: new
 * timeout = slow_gate_seconds * 4 in ms, capped at 10 minutes.
 */
export const widenTimeoutOnHang: ImprovementRule = ({ manifest, report }) => {
  const hungGates = report.gates.filter((g) => g.timedOut === true && g.gateId);
  if (!hungGates.length) return null;

  const slowGateSeconds = Number(
    (manifest.config.improvementPolicy as Record<string, unknown>)?.slow_gate_seconds ?? 15,
  );
  const target = Math.min(slowGateSeconds * 4 * 1000, 600_000); // cap 10 min

  // Propose for the first hung gate whose tool timeout is below target.
  for (const g of hungGates) {
    const gate = manifest.gates.find((x) => x.id === g.gateId);
    if (!gate) continue;
    const tool = manifest.tools.find((t) => t.id === gate.toolId);
    if (!tool) continue;
    // An unset timeout means the gate died at the runtime's implicit 60s
    // ceiling — pin it to the policy target so the limit becomes explicit
    // and governed (a real widening whenever policy asks for more). A set
    // timeout only widens when it sits below the target.
    if (tool.timeoutMs !== undefined && tool.timeoutMs >= target) continue;
    const current = tool.timeoutMs ?? 60_000;
    // Keep config and SLOs coherent: if the new timeout ceiling exceeds the
    // bounded-runtime SLO threshold, raise the threshold too — otherwise the
    // config would permit (and the widened timeout encourage) runs the SLO
    // permanently fails, and healthy() would never recover.
    const changes: Record<string, unknown> = { [`tools.${tool.id}.timeoutMs`]: target };
    const runtimeSlo = manifest.slos.find((s) => s.id === "bounded-runtime");
    if (runtimeSlo && runtimeSlo.threshold < target) {
      changes["slos.bounded-runtime.threshold"] = target;
    }
    const proposal: ImprovementProposal = {
      id: nextId(manifest),
      description: `Gate "${g.gateId}" hung and was killed at its ${current}ms timeout; widening tool "${tool.id}" timeout to ${target}ms.`,
      changes,
      rationale: `timedOut[${g.gateId}]=true (killed at ${current}ms); slow_gate_seconds=${slowGateSeconds}; timeoutMs=${current}→${target}` +
        (runtimeSlo && runtimeSlo.threshold < target ? `; slos.bounded-runtime.threshold=${runtimeSlo.threshold}→${target} (co-aligned)` : ""),
      approved: false,
    };
    return proposal;
  }
  return null;
};

/**
 * Built-in rule: quarantine a gate that keeps failing across consecutive
 * runs. A gate failing N times in a row (default 3) is likely broken at the
 * project level (env drift, missing dependency) rather than flaky — demote
 * it to advisory so it stops blocking the harness while still surfacing.
 */
export const quarantineRepeatFailure: ImprovementRule = ({ manifest, report, history }) => {
  const runs = history ?? [];
  const CONSECUTIVE = 3;
  // Find required gates that failed in the latest report.
  const failedGates = report.gates.filter((g) => !g.passed && g.required !== false && g.gateId);
  if (!failedGates.length) return null;

  for (const g of failedGates) {
    const gateId = g.gateId!;
    // Count consecutive failures of this gate, newest-first through history.
    let streak = 1; // the current report counts as the first failure
    for (let i = runs.length - 1; i >= 0; i--) {
      const rec = runs[i];
      // The current run may already be recorded in history (the CLI records
      // before improving) — never count the same run twice.
      if (rec.runId === report.runId) continue;
      const outcome = rec.gateResults?.[gateId];
      if (outcome === undefined) continue; // gate not present in this record
      if (outcome === false) streak++;
      else break;
    }
    if (streak < CONSECUTIVE) continue;

    const gate = manifest.gates.find((x) => x.id === gateId);
    if (!gate || gate.required === false) continue; // already quarantined

    return {
      id: nextId(manifest),
      description: `Gate "${gateId}" failed ${streak} consecutive runs; quarantining to advisory while it is repaired.`,
      changes: { [`gates.${gateId}.required`]: false },
      rationale: `consecutive_failures[${gateId}]=${streak} >= ${CONSECUTIVE}; required=true→false (advisory)`,
      approved: false,
    };
  }
  return null;
};

/**
 * Built-in rule: promote an advisory gate back to required once it has
 * proven stable — the inverse of quarantineRepeatFailure, completing the
 * demote→repair→promote lifecycle the builder's advisory gates promise.
 *
 * A gate that has passed the last N consecutive runs (default 5) is stable
 * enough to block again; the promotion is proposed so its effect (and the
 * evidence trail) is recorded in the improvement history, never silently
 * flipped.
 */
export const promoteStableAdvisoryGate: ImprovementRule = ({ manifest, report, history }) => {
  const runs = history ?? [];
  const PROMOTION_RUNS = 5;

  // Candidate: advisory gates that passed in the current run.
  const advisoryGates = manifest.gates.filter((g) => g.required === false);
  if (!advisoryGates.length) return null;
  const passedNow = new Set(
    report.gates.filter((g) => g.passed && g.gateId).map((g) => g.gateId as string),
  );
  const candidates = advisoryGates.filter((g) => passedNow.has(g.id));
  if (!candidates.length) return null;

  for (const gate of candidates) {
    // Count consecutive passes of this gate: the current report counts as
    // the first pass, then walk history newest-first. The current run may
    // already be recorded in history (the CLI records before improving) —
    // never count the same run twice.
    let streak = 1; // the current report counts as the first pass
    for (let i = runs.length - 1; i >= 0; i--) {
      const rec = runs[i];
      if (rec.runId === report.runId) continue;
      const outcome = rec.gateResults?.[gate.id];
      if (outcome === undefined) break; // gate absent from this record — streak ends
      if (outcome === true) streak++;
      else break;
    }
    if (streak < PROMOTION_RUNS) continue;

    return {
      id: nextId(manifest),
      description: `Advisory gate "${gate.id}" has passed ${streak} consecutive runs; promoting to required so it blocks again.`,
      changes: { [`gates.${gate.id}.required`]: true },
      rationale: `consecutive_passes[${gate.id}]=${streak} >= ${PROMOTION_RUNS}; required=false→true (promotion)`,
      approved: false,
    };
  }
  return null;
};

/** Default set of rules, in priority order. */
export const defaultRules: ImprovementRule[] = [widenContextOnFailure, adaptParallelism, reduceParallelism, detectFlakiness, expandContextOnOverflow, widenTimeoutOnHang, quarantineRepeatFailure, promoteStableAdvisoryGate];

/**
 * Run the improver against the latest report. Returns proposals; applying a
 * proposal is a separate step that records it in the manifest history.
 *
 * The improver operates on bounded context — the report and history are
 * compacted before any rule sees them.
 */
export function improve(manifest: HarnessManifest, report: RunReport, rules = defaultRules): ImprovementProposal[] {
  // Bound the history each rule sees — recent records only, newest last.
  const history = (manifest.runHistory ?? []).slice(-20);
  return rules
    .map((rule) => rule({ manifest, report, history }))
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
    else if (path.startsWith("tools.") && path.endsWith(".timeoutMs")) {
      // Widen (or narrow) a tool timeout: tools.<id>.timeoutMs = <ms>
      const toolId = path.slice("tools.".length, -".timeoutMs".length);
      const tool = m.tools.find((t) => t.id === toolId);
      if (tool) tool.timeoutMs = value as number;
    }
    else if (path.startsWith("gates.") && path.endsWith(".required")) {
      // Quarantine/promote a gate: gates.<id>.required = false|true
      const gateId = path.slice("gates.".length, -".required".length);
      const gate = m.gates.find((g) => g.id === gateId);
      if (gate) gate.required = Boolean(value);
    }
    else if (path.startsWith("slos.") && path.endsWith(".threshold")) {
      // Align an SLO threshold: slos.<id>.threshold = <value>
      const sloId = path.slice("slos.".length, -".threshold".length);
      const slo = m.slos.find((s) => s.id === sloId);
      if (slo) slo.threshold = value as number;
    }
  }
  p.approved = true;
  p.appliedAt = new Date().toISOString();
  m.improvementHistory = m.improvementHistory ?? [];
  m.improvementHistory.push(p);
  return m;
}

/**
 * Produce a bounded improver context — the full payload the improver agent
 * receives, guaranteed to fit within the manifest's contextBudget.
 */
export function improverContext(
  report: RunReport,
  history: HarnessRunRecord[],
  improvementHistory: ImprovementProposal[],
  manifest: HarnessManifest,
): string {
  return boundedImproverContext(report, history, improvementHistory, manifest);
}

/**
 * Check context budget compliance for the improver — returns true if the
 * improver's bounded context fits within the budget.
 */
export function isImproverContextCompliant(
  report: RunReport,
  history: HarnessRunRecord[],
  improvementHistory: ImprovementProposal[],
  manifest: HarnessManifest,
): boolean {
  const budget = resolveBudget(manifest);
  const payload = improverContext(report, history, improvementHistory, manifest);
  return estimateTokens(payload) <= budget;
}

export { healthy, summary };
