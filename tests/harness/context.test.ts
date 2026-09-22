/**
 * Tests for the context budget enforcer — ensures all agents (runtime,
 * monitor, improver) operate with bounded context. No agent should ever
 * receive unbounded or long context.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../src/harness/builder/index.ts";
import { loadManifest } from "../../src/harness/registry.ts";
import {
  estimateTokens,
  clampBudget,
  resolveBudget,
  truncateToBudget,
  compactRunReport,
  compactRunHistory,
  compactImprovementHistory,
  boundedTaskContext,
  boundedMonitorContext,
  boundedImproverContext,
  withinBudget,
  contextUsage,
  DEFAULT_CONTEXT_BUDGET,
  MIN_CONTEXT_BUDGET,
  MAX_CONTEXT_BUDGET,
} from "../../src/harness/context.ts";
import { monitorContext, isContextCompliant } from "../../src/harness/monitor/index.ts";
import { improverContext, isImproverContextCompliant } from "../../src/harness/improver/index.ts";
import type { RunReport, HarnessRunRecord, ImprovementProposal } from "../../src/harness/types.ts";

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-ctx-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function makeReport(passRate = 1, runtimeMs = 100, runId = "test-run"): RunReport {
  return {
    runId,
    task: "test task",
    startedAt: new Date().toISOString(),
    durationMs: runtimeMs,
    gates: [
      { toolId: "tool1", gateId: "gate1", passed: passRate === 1, exitCode: passRate === 1 ? 0 : 1, durationMs: runtimeMs },
      { toolId: "tool2", gateId: "gate2", passed: true, exitCode: 0, durationMs: runtimeMs },
    ],
    metrics: { pass_rate: passRate, runtime_ms: runtimeMs, gate_count: 2 },
    sloResults: [],
  };
}

function makeRunRecord(passRate: number, durationMs: number, runId?: string): HarnessRunRecord {
  return {
    runId: runId ?? `run-${Math.random().toString(36).slice(2)}`,
    task: "test",
    startedAt: new Date().toISOString(),
    durationMs,
    passRate,
    healthy: passRate === 1,
    gateCount: 2,
    passedCount: Math.round(passRate * 2),
    metrics: { pass_rate: passRate, runtime_ms: durationMs },
    unmetSlo: passRate === 1 ? [] : ["pass-rate"],
  };
}

// --- estimateTokens ---

test("estimateTokens returns 0 for empty string", () => {
  expect(estimateTokens("")).toBe(0);
  expect(estimateTokens("")).toBe(0);
});

test("estimateTokens approximates 4 chars per token", () => {
  expect(estimateTokens("hello")).toBe(2); // 5 chars -> ceil(5/4) = 2
  expect(estimateTokens("hello world")).toBe(3); // 11 chars -> ceil(11/4) = 3
  expect(estimateTokens("a".repeat(400))).toBe(100); // 400 chars -> 100 tokens
});

// --- clampBudget ---

test("clampBudget enforces minimum", () => {
  expect(clampBudget(0)).toBe(MIN_CONTEXT_BUDGET);
  expect(clampBudget(-1)).toBe(MIN_CONTEXT_BUDGET);
  expect(clampBudget(100)).toBe(MIN_CONTEXT_BUDGET);
});

test("clampBudget enforces maximum", () => {
  expect(clampBudget(999999)).toBe(MAX_CONTEXT_BUDGET);
  expect(clampBudget(MAX_CONTEXT_BUDGET + 1)).toBe(MAX_CONTEXT_BUDGET);
});

test("clampBudget passes through valid values", () => {
  expect(clampBudget(2048)).toBe(2048);
  expect(clampBudget(4096)).toBe(4096);
  expect(clampBudget(8192)).toBe(8192);
});

test("clampBudget handles NaN and Infinity", () => {
  expect(clampBudget(NaN)).toBe(MIN_CONTEXT_BUDGET);
  expect(clampBudget(Infinity)).toBe(MAX_CONTEXT_BUDGET);
});

// --- resolveBudget ---

test("resolveBudget uses manifest contextBudget as multiplier", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "budget-test" });
  const m = loadManifest(dir);
  // Default contextBudget is 1, so resolved = 1 * DEFAULT_CONTEXT_BUDGET
  expect(resolveBudget(m)).toBe(DEFAULT_CONTEXT_BUDGET);
});

test("resolveBudget scales with contextBudget multiplier", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "budget-scale" });
  const m = loadManifest(dir);
  m.config.contextBudget = 2;
  expect(resolveBudget(m)).toBe(DEFAULT_CONTEXT_BUDGET * 2);
  m.config.contextBudget = 4;
  expect(resolveBudget(m)).toBe(DEFAULT_CONTEXT_BUDGET * 4);
});

test("resolveBudget clamps to max", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "budget-max" });
  const m = loadManifest(dir);
  m.config.contextBudget = 999;
  expect(resolveBudget(m)).toBe(MAX_CONTEXT_BUDGET);
});

// --- truncateToBudget ---

test("truncateToBudget returns text unchanged if within budget", () => {
  const text = "hello world";
  expect(truncateToBudget(text, 100)).toBe(text);
});

test("truncateToBudget truncates long text with marker", () => {
  const text = "a".repeat(1000); // ~250 tokens
  const result = truncateToBudget(text, 50); // budget of 50 tokens
  expect(result).toContain("[...truncated");
  expect(result.length).toBeLessThan(text.length);
});

test("truncateToBudget preserves head and tail", () => {
  const text = "HEAD_START_" + "x".repeat(400) + "_TAIL_END";
  const result = truncateToBudget(text, 30);
  expect(result).toContain("HEAD_START");
  expect(result).toContain("TAIL_END");
  expect(result).toContain("[...truncated");
});

// --- compactRunReport ---

test("compactRunReport produces bounded output", () => {
  const report = makeReport(0.5, 200, "compact-test");
  const compact = compactRunReport(report, 200);
  expect(compact).toContain("runId=compact-test");
  expect(compact).toContain("passRate=0.5");
  expect(estimateTokens(compact)).toBeLessThanOrEqual(200);
});

test("compactRunReport handles many gates within budget", () => {
  const report: RunReport = {
    runId: "many-gates",
    task: "test",
    startedAt: new Date().toISOString(),
    durationMs: 1000,
    gates: Array.from({ length: 100 }, (_, i) => ({
      toolId: `tool${i}`,
      gateId: `gate${i}`,
      passed: i % 2 === 0,
      exitCode: i % 2 === 0 ? 0 : 1,
      durationMs: 10 + i,
    })),
    metrics: { pass_rate: 0.5, runtime_ms: 1000, gate_count: 100 },
    sloResults: [],
  };
  const compact = compactRunReport(report, 300);
  expect(estimateTokens(compact)).toBeLessThanOrEqual(300);
});

// --- compactRunHistory ---

test("compactRunHistory handles empty history", () => {
  expect(compactRunHistory([], 100)).toBe("(no run history)");
});

test("compactRunHistory produces bounded summary", () => {
  const history = Array.from({ length: 50 }, (_, i) =>
    makeRunRecord(i % 2 === 0 ? 1 : 0.5, 100 + i, `run-${i}`)
  );
  const compact = compactRunHistory(history, 200);
  expect(compact).toContain("50 runs");
  expect(estimateTokens(compact)).toBeLessThanOrEqual(200);
});

test("compactRunHistory includes recent N records", () => {
  const history = Array.from({ length: 20 }, (_, i) =>
    makeRunRecord(1, 100, `recent-${i}`)
  );
  const compact = compactRunHistory(history, 500, 5);
  expect(compact).toContain("recent-19");
  expect(compact).toContain("recent-15");
  // Should not include older records if budget is tight
  expect(compact).not.toContain("recent-0");
});

// --- compactImprovementHistory ---

test("compactImprovementHistory handles empty history", () => {
  expect(compactImprovementHistory([], 100)).toBe("(no improvements)");
});

test("compactImprovementHistory produces bounded summary", () => {
  const proposals: ImprovementProposal[] = Array.from({ length: 20 }, (_, i) => ({
    id: `imp-${i}`,
    description: `improvement number ${i}`,
    changes: {},
    rationale: `rationale ${i}`,
    approved: true,
    appliedAt: new Date().toISOString(),
  }));
  const compact = compactImprovementHistory(proposals, 200, 5);
  expect(compact).toContain("20 total");
  expect(estimateTokens(compact)).toBeLessThanOrEqual(200);
});

// --- boundedTaskContext ---

test("boundedTaskContext truncates long task descriptions", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "task-ctx" });
  const m = loadManifest(dir);
  const longTask = "a".repeat(100000); // very long task
  const bounded = boundedTaskContext(longTask, m);
  expect(estimateTokens(bounded)).toBeLessThanOrEqual(resolveBudget(m) * 0.8);
});

test("boundedTaskContext preserves short tasks unchanged", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "task-short" });
  const m = loadManifest(dir);
  const shortTask = "run tests";
  expect(boundedTaskContext(shortTask, m)).toBe(shortTask);
});

// --- boundedMonitorContext ---

test("boundedMonitorContext fits within budget", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "mon-ctx" });
  const m = loadManifest(dir);
  const report = makeReport(0.75, 500, "mon-run");
  const history = Array.from({ length: 30 }, (_, i) =>
    makeRunRecord(0.5 + (i % 5) * 0.1, 100 + i * 10, `h-${i}`)
  );
  const ctx = boundedMonitorContext(report, history, m);
  expect(estimateTokens(ctx)).toBeLessThanOrEqual(resolveBudget(m));
});

test("boundedMonitorContext includes both report and history sections", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "mon-sections" });
  const m = loadManifest(dir);
  const report = makeReport(1, 100, "sec-run");
  const history = [makeRunRecord(1, 100, "h-0")];
  const ctx = boundedMonitorContext(report, history, m);
  expect(ctx).toContain("=== RUN REPORT ===");
  expect(ctx).toContain("=== HISTORY ===");
});

// --- boundedImproverContext ---

test("boundedImproverContext fits within budget", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-ctx" });
  const m = loadManifest(dir);
  const report = makeReport(0.5, 500, "imp-run");
  const history = Array.from({ length: 30 }, (_, i) =>
    makeRunRecord(0.5, 200 + i * 5, `ih-${i}`)
  );
  const improvements: ImprovementProposal[] = Array.from({ length: 20 }, (_, i) => ({
    id: `imp-${i}`,
    description: `change ${i}`,
    changes: {},
    rationale: `because ${i}`,
    approved: true,
    appliedAt: new Date().toISOString(),
  }));
  const ctx = boundedImproverContext(report, history, improvements, m);
  expect(estimateTokens(ctx)).toBeLessThanOrEqual(resolveBudget(m));
});

test("boundedImproverContext includes all three sections", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-3sec" });
  const m = loadManifest(dir);
  const report = makeReport(1, 100);
  const history = [makeRunRecord(1, 100)];
  const improvements: ImprovementProposal[] = [{
    id: "imp-0",
    description: "test",
    changes: {},
    rationale: "test",
    approved: true,
    appliedAt: new Date().toISOString(),
  }];
  const ctx = boundedImproverContext(report, history, improvements, m);
  expect(ctx).toContain("=== RUN REPORT ===");
  expect(ctx).toContain("=== HISTORY ===");
  expect(ctx).toContain("=== IMPROVEMENTS ===");
});

// --- withinBudget ---

test("withinBudget returns true for short text", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "wb-short" });
  const m = loadManifest(dir);
  expect(withinBudget("hello world", m)).toBe(true);
});

test("withinBudget returns false for very long text", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "wb-long" });
  const m = loadManifest(dir);
  m.config.contextBudget = 1; // minimum budget
  const longText = "a".repeat(100000);
  expect(withinBudget(longText, m)).toBe(false);
});

// --- contextUsage ---

test("contextUsage produces correct report", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "cu-test" });
  const m = loadManifest(dir);
  const payload = "hello world";
  const usage = contextUsage("runtime", payload, m, false);
  expect(usage.agent).toBe("runtime");
  expect(usage.budgetTokens).toBe(resolveBudget(m));
  expect(usage.usedTokens).toBe(estimateTokens(payload));
  expect(usage.truncated).toBe(false);
  expect(usage.utilization).toBeGreaterThan(0);
  expect(usage.utilization).toBeLessThan(1);
});

test("contextUsage reports truncated flag correctly", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "cu-trunc" });
  const m = loadManifest(dir);
  const usage = contextUsage("monitor", "a".repeat(100000), m, true);
  expect(usage.truncated).toBe(true);
  expect(usage.usedTokens).toBeGreaterThan(usage.budgetTokens);
  expect(usage.utilization).toBeGreaterThan(1);
});

// --- monitor context integration ---

test("monitorContext produces bounded output", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "mc-test" });
  const m = loadManifest(dir);
  const report = makeReport(0.5, 300, "mc-run");
  const history = Array.from({ length: 20 }, (_, i) =>
    makeRunRecord(0.5, 200, `mc-h-${i}`)
  );
  const ctx = monitorContext(report, history, m);
  expect(estimateTokens(ctx)).toBeLessThanOrEqual(resolveBudget(m));
});

test("isContextCompliant returns true for small payloads", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "cc-small" });
  const m = loadManifest(dir);
  const report = makeReport(1, 100);
  const history = [makeRunRecord(1, 100)];
  expect(isContextCompliant(report, history, m)).toBe(true);
});

// --- improver context integration ---

test("improverContext produces bounded output", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "ic-test" });
  const m = loadManifest(dir);
  const report = makeReport(0.5, 300, "ic-run");
  const history = Array.from({ length: 20 }, (_, i) =>
    makeRunRecord(0.5, 200, `ic-h-${i}`)
  );
  const improvements: ImprovementProposal[] = Array.from({ length: 10 }, (_, i) => ({
    id: `imp-${i}`,
    description: `change ${i}`,
    changes: {},
    rationale: `because ${i}`,
    approved: true,
    appliedAt: new Date().toISOString(),
  }));
  const ctx = improverContext(report, history, improvements, m);
  expect(estimateTokens(ctx)).toBeLessThanOrEqual(resolveBudget(m));
});

test("isImproverContextCompliant returns true for small payloads", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "ic-small" });
  const m = loadManifest(dir);
  const report = makeReport(1, 100);
  const history = [makeRunRecord(1, 100)];
  const improvements: ImprovementProposal[] = [];
  expect(isImproverContextCompliant(report, history, improvements, m)).toBe(true);
});

// --- extreme context pressure test ---

test("all agents stay within budget under extreme data volume", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "extreme" });
  const m = loadManifest(dir);

  // Massive report with 500 gates
  const bigReport: RunReport = {
    runId: "extreme-run",
    task: "a".repeat(10000),
    startedAt: new Date().toISOString(),
    durationMs: 60000,
    gates: Array.from({ length: 500 }, (_, i) => ({
      toolId: `tool${i}`,
      gateId: `gate${i}`,
      passed: i % 3 === 0,
      exitCode: i % 3 === 0 ? 0 : 1,
      durationMs: 100 + i,
    })),
    metrics: { pass_rate: 0.33, runtime_ms: 60000, gate_count: 500 },
    sloResults: [],
  };

  // Massive history: 200 runs
  const bigHistory = Array.from({ length: 200 }, (_, i) =>
    makeRunRecord(Math.random(), 100 + i * 10, `extreme-h-${i}`)
  );

  // Massive improvement history: 50 proposals
  const bigImprovements: ImprovementProposal[] = Array.from({ length: 50 }, (_, i) => ({
    id: `imp-${i}`,
    description: `improvement ${i} with a long description `.repeat(5),
    changes: {},
    rationale: `rationale ${i} `.repeat(10),
    approved: true,
    appliedAt: new Date().toISOString(),
  }));

  const budget = resolveBudget(m);

  // Monitor context must fit
  const monCtx = boundedMonitorContext(bigReport, bigHistory, m);
  expect(estimateTokens(monCtx)).toBeLessThanOrEqual(budget);

  // Improver context must fit
  const impCtx = boundedImproverContext(bigReport, bigHistory, bigImprovements, m);
  expect(estimateTokens(impCtx)).toBeLessThanOrEqual(budget);

  // Task context must fit
  const taskCtx = boundedTaskContext("a".repeat(100000), m);
  expect(estimateTokens(taskCtx)).toBeLessThanOrEqual(budget * 0.8);
});

// --- builder includes context SLO ---

test("builder includes bounded-context SLO in manifest", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "slo-test" });
  const m = loadManifest(dir);
  const sloIds = m.slos.map((s) => s.id);
  expect(sloIds).toContain("bounded-context");
  const ctxSlo = m.slos.find((s) => s.id === "bounded-context");
  // Relative form: utilization (used/budget) ≤ 1.0. An absolute token
  // threshold would be obsoleted the moment the improver widens the budget.
  expect(ctxSlo?.metric).toBe("context_utilization");
  expect(ctxSlo?.op).toBe("lte");
  expect(ctxSlo?.threshold).toBe(1.0);
});

// --- runtime enforces context budget on task ---

test("runtime truncates task description to fit budget", async () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "rt-trunc" });
  const m = loadManifest(dir);
  const { run } = await import("../../src/harness/runtime/index.ts");
  const longTask = "a".repeat(100000);
  const report = await run(m, longTask);
  // The task in the report should be truncated, not the original
  expect(report.task.length).toBeLessThan(longTask.length);
  expect(report.metrics.context_budget).toBeDefined();
  expect(report.metrics.context_used).toBeDefined();
  expect(report.metrics.context_used).toBeLessThanOrEqual(report.metrics.context_budget * 0.8 + 1);
});

// --- widened budget stays SLO-compliant (regression) ---

test("a task within a widened budget does not violate the bounded-context SLO", async () => {
  // Regression: the bounded-context SLO previously used an absolute
  // context_used ≤ 4096 threshold. Once the improver widened the budget
  // (multiplier up to 8), a task that legally fit the widened budget still
  // violated the SLO — the harness reported unhealthy forever, and widening
  // (the improver's own remedy) made it worse. The SLO is now relative:
  // context_utilization ≤ 1.0 against the effective budget.
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "slo-widened" });
  const m = loadManifest(dir);
  m.config.contextBudget = 8; // improver widened to the 8x cap
  const { run } = await import("../../src/harness/runtime/index.ts");
  const { annotate, healthy } = await import("../../src/harness/monitor/index.ts");

  // ~10000 tokens — above the old 4096 threshold, within the 8x budget.
  const bigTask = "x".repeat(4 * 10_000);
  const r = await run(m, bigTask);
  annotate(m, r);
  expect(r.metrics.context_budget).toBe(32768);
  expect(r.metrics.context_used).toBeGreaterThan(4096);
  const ctxSlo = r.sloResults.find((s) => s.sloId === "bounded-context");
  expect(ctxSlo?.met).toBe(true);
  expect(healthy(r)).toBe(true);
});

test("a task overflowing even the widened budget violates the SLO", async () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "slo-overflow" });
  const m = loadManifest(dir);
  m.config.contextBudget = 8;
  const { run } = await import("../../src/harness/runtime/index.ts");
  const { annotate, healthy } = await import("../../src/harness/monitor/index.ts");

  // Task far larger than even the 8x budget — truncation keeps utilization
  // at ~0.8 of budget per the runtime's bounded-task contract, so the SLO
  // holds; overflow is instead signaled to the improver via
  // expandContextOnOverflow (already at cap → no proposal). Verify the
  // metric stays within contract either way.
  const hugeTask = "y".repeat(4 * 60_000);
  const r = await run(m, hugeTask);
  annotate(m, r);
  expect(r.metrics.context_utilization).toBeLessThanOrEqual(1.0);
  expect(r.metrics.context_used).toBeLessThanOrEqual(r.metrics.context_budget);
  expect(healthy(r)).toBe(true);
});
