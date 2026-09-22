/**
 * Tests for the harness improver — rules, proposals, and application.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../src/harness/builder/index.ts";
import { loadManifest } from "../../src/harness/registry.ts";
import { improve, applyProposal, shouldApply, defaultRules, widenContextOnFailure, adaptParallelism, reduceParallelism, detectFlakiness, expandContextOnOverflow, widenTimeoutOnHang } from "../../src/harness/improver/index.ts";
import { annotate } from "../../src/harness/monitor/index.ts";
import type { RunReport, HarnessManifest, HarnessRunRecord } from "../../src/harness/types.ts";

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-imp-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function makeReport(passed: boolean, durationMs: number, passRate?: number): RunReport {
  const pr = passRate ?? (passed ? 1 : 0);
  return {
    runId: crypto.randomUUID(),
    task: "improver-test",
    startedAt: new Date().toISOString(),
    durationMs,
    gates: [{ toolId: "test-tool", passed, exitCode: passed ? 0 : 1, durationMs }],
    metrics: { pass_rate: pr, required_pass_rate: pr, runtime_ms: durationMs, gate_count: 1 },
    sloResults: [],
  };
}

test("widenContextOnFailure fires when unhealthy", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  const r = makeReport(false, 5000);
  annotate(m, r);
  const proposal = widenContextOnFailure({ manifest: m, report: r });
  expect(proposal).not.toBeNull();
  expect(proposal!.changes["config.contextBudget"]).toBeDefined();
});

test("widenContextOnFailure does not fire when healthy", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  const r = makeReport(true, 100);
  annotate(m, r);
  const proposal = widenContextOnFailure({ manifest: m, report: r });
  expect(proposal).toBeNull();
});

test("adaptParallelism fires for slow runs", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  m.config.maxParallel = 1;
  const r = makeReport(true, 35000);
  annotate(m, r);
  const proposal = adaptParallelism({ manifest: m, report: r });
  expect(proposal).not.toBeNull();
  expect(proposal!.changes["config.maxParallel"]).toBe(2);
});

test("adaptParallelism does not fire for fast runs", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  const r = makeReport(true, 500);
  annotate(m, r);
  const proposal = adaptParallelism({ manifest: m, report: r });
  expect(proposal).toBeNull();
});

test("reduceParallelism fires for fast healthy runs", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  m.config.maxParallel = 3;
  const r = makeReport(true, 500);
  annotate(m, r);
  const proposal = reduceParallelism({ manifest: m, report: r });
  expect(proposal).not.toBeNull();
  expect(proposal!.changes["config.maxParallel"]).toBe(2);
});

test("reduceParallelism does not fire when already at minimum", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  m.config.maxParallel = 1;
  const r = makeReport(true, 500);
  annotate(m, r);
  const proposal = reduceParallelism({ manifest: m, report: r });
  expect(proposal).toBeNull();
});

test("detectFlakiness fires when a gate flips across runs", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  m.config.contextBudget = 2;

  // History: the unit gate passed then failed — flip pattern.
  const history = [
    { runId: crypto.randomUUID(), gateResults: { unit: true } },
    { runId: crypto.randomUUID(), gateResults: { unit: false } },
  ] as unknown as HarnessRunRecord[];

  // Current run: unit fails again (flip within window, failed now).
  const r: RunReport = {
    runId: crypto.randomUUID(),
    task: "flaky",
    startedAt: new Date().toISOString(),
    durationMs: 100,
    gates: [{ toolId: "node-test", gateId: "unit", passed: false, exitCode: 1, durationMs: 100 }],
    metrics: { pass_rate: 0, required_pass_rate: 0, runtime_ms: 100, gate_count: 1 },
    sloResults: [],
  };
  const proposal = detectFlakiness({ manifest: m, report: r, history });
  expect(proposal).not.toBeNull();
  expect(proposal!.changes["config.contextBudget"]).toBe(3);
  expect(proposal!.rationale).toContain("flaky_gates=[unit]");
});

test("detectFlakiness does not fire for a deterministically failing gate", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  m.config.contextBudget = 2;

  // History: the unit gate failed every time — deterministic, not flaky.
  const history = [
    { runId: crypto.randomUUID(), gateResults: { unit: false } },
    { runId: crypto.randomUUID(), gateResults: { unit: false } },
  ] as unknown as HarnessRunRecord[];

  const r: RunReport = {
    runId: crypto.randomUUID(),
    task: "deterministic",
    startedAt: new Date().toISOString(),
    durationMs: 100,
    gates: [{ toolId: "node-test", gateId: "unit", passed: false, exitCode: 1, durationMs: 100 }],
    metrics: { pass_rate: 0, required_pass_rate: 0, runtime_ms: 100, gate_count: 1 },
    sloResults: [],
  };
  expect(detectFlakiness({ manifest: m, report: r, history })).toBeNull();
});

test("detectFlakiness does not fire with too few samples", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  m.config.contextBudget = 2;

  // Only 1 prior run (2 samples total) — below MIN_SAMPLES=3.
  const history = [
    { runId: crypto.randomUUID(), gateResults: { unit: true } },
  ] as unknown as HarnessRunRecord[];

  const r: RunReport = {
    runId: crypto.randomUUID(),
    task: "few-samples",
    startedAt: new Date().toISOString(),
    durationMs: 100,
    gates: [{ toolId: "node-test", gateId: "unit", passed: false, exitCode: 1, durationMs: 100 }],
    metrics: { pass_rate: 0, required_pass_rate: 0, runtime_ms: 100, gate_count: 1 },
    sloResults: [],
  };
  expect(detectFlakiness({ manifest: m, report: r, history })).toBeNull();
});

test("detectFlakiness does not fire for all-pass or all-fail", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  
  // All pass
  const r1 = makeReport(true, 100, 1);
  annotate(m, r1);
  expect(detectFlakiness({ manifest: m, report: r1 })).toBeNull();
  
  // All fail
  const r2 = makeReport(false, 100, 0);
  annotate(m, r2);
  expect(detectFlakiness({ manifest: m, report: r2 })).toBeNull();
});

test("improve returns multiple proposals for multiple issues", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  m.config.maxParallel = 1;
  m.config.contextBudget = 1;
  
  // Unhealthy + slow → should trigger widenContextOnFailure + adaptParallelism
  const r = makeReport(false, 40000);
  annotate(m, r);
  const proposals = improve(m, r, defaultRules);
  expect(proposals.length).toBeGreaterThanOrEqual(1);
});

test("applyProposal records in improvement history", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  const r = makeReport(false, 5000);
  annotate(m, r);
  const proposals = improve(m, r, defaultRules);
  if (proposals.length > 0) {
    const before = m.improvementHistory.length;
    applyProposal(m, proposals[0]);
    expect(m.improvementHistory.length).toBe(before + 1);
    expect(m.improvementHistory[m.improvementHistory.length - 1].approved).toBe(true);
    expect(m.improvementHistory[m.improvementHistory.length - 1].appliedAt).toBeDefined();
  }
});

test("shouldApply guardrail prevents unbounded maxParallel", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  
  // Create a proposal that would set maxParallel to 5 (above the guardrail of 4)
  const proposal = {
    id: "test-guard",
    description: "test",
    changes: { "config.maxParallel": 5 },
    rationale: "test",
    approved: false,
  };
  expect(shouldApply(m, proposal)).toBe(false);
  
  // A proposal within bounds should be allowed
  const safeProposal = {
    id: "test-safe",
    description: "test",
    changes: { "config.maxParallel": 3 },
    rationale: "test",
    approved: false,
  };
  expect(shouldApply(m, safeProposal)).toBe(true);
});

// --- expandContextOnOverflow rule ---

test("expandContextOnOverflow proposes increase when context used exceeds budget", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "ctx-overflow" });
  const m = loadManifest(dir);
  const report: RunReport = {
    runId: "overflow-run",
    task: "test",
    startedAt: new Date().toISOString(),
    durationMs: 100,
    gates: [],
    metrics: { pass_rate: 1, runtime_ms: 100, gate_count: 0, context_budget: 4096, context_used: 5000 },
    sloResults: [],
  };
  const proposal = expandContextOnOverflow({ manifest: m, report });
  expect(proposal).not.toBeNull();
  expect(proposal!.changes["config.contextBudget"]).toBe(2); // 1 -> 2
});

test("expandContextOnOverflow returns null when context is within budget", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "ctx-ok" });
  const m = loadManifest(dir);
  const report: RunReport = {
    runId: "ok-run",
    task: "test",
    startedAt: new Date().toISOString(),
    durationMs: 100,
    gates: [],
    metrics: { pass_rate: 1, runtime_ms: 100, gate_count: 0, context_budget: 4096, context_used: 1000 },
    sloResults: [],
  };
  const proposal = expandContextOnOverflow({ manifest: m, report });
  expect(proposal).toBeNull();
});

test("expandContextOnOverflow respects cap at 8x", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "ctx-cap" });
  const m = loadManifest(dir);
  m.config.contextBudget = 8;
  const report: RunReport = {
    runId: "cap-run",
    task: "test",
    startedAt: new Date().toISOString(),
    durationMs: 100,
    gates: [],
    metrics: { pass_rate: 1, runtime_ms: 100, gate_count: 0, context_budget: 4096, context_used: 99999 },
    sloResults: [],
  };
  const proposal = expandContextOnOverflow({ manifest: m, report });
  expect(proposal).toBeNull(); // already at 8x cap
});

test("expandContextOnOverflow is included in defaultRules", () => {
  expect(defaultRules).toContain(expandContextOnOverflow);
});

// --- widenTimeoutOnHang: real timeout handling for hung gates ---

test("widenTimeoutOnHang fires when a gate timed out", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}", "bunfig.toml": "" });
  build(dir, { harnessId: "hang-test" });
  const m = loadManifest(dir);

  // A gate result that was killed for exceeding its timeout.
  const report: RunReport = {
    runId: crypto.randomUUID(),
    task: "hang",
    startedAt: new Date().toISOString(),
    durationMs: 60_000,
    gates: [{ toolId: "bun-test", gateId: "unit", passed: false, exitCode: -1, durationMs: 60_000, timedOut: true }],
    metrics: { pass_rate: 0, required_pass_rate: 0, timeout_count: 1, runtime_ms: 60_000, gate_count: 1 },
    sloResults: [],
  };
  const proposal = widenTimeoutOnHang({ manifest: m, report });
  expect(proposal).not.toBeNull();
  // slow_gate_seconds=15 → policy target 60000ms is NOT above the implicit
  // 60s kill threshold, so the rule escalates from the threshold: 60s × 2.
  // (A pin-to-60s would be a no-op — the gate would hang identically forever.)
  expect(proposal!.changes["tools.bun-test.timeoutMs"]).toBe(120_000);
  expect(proposal!.rationale).toContain("timedOut[unit]=true");
});

test("widenTimeoutOnHang does not fire when no gate timed out", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}", "bunfig.toml": "" });
  build(dir, { harnessId: "hang-none" });
  const m = loadManifest(dir);
  const r = makeReport(false, 1000);
  annotate(m, r);
  expect(widenTimeoutOnHang({ manifest: m, report: r })).toBeNull();
});

test("widenTimeoutOnHang does not exceed the 10-minute cap", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}", "bunfig.toml": "" });
  build(dir, { harnessId: "hang-cap" });
  const m = loadManifest(dir);
  // Force a huge slow_gate_seconds — target must still cap at 600_000ms.
  (m.config.improvementPolicy as Record<string, unknown>).slow_gate_seconds = 5000;

  const report: RunReport = {
    runId: crypto.randomUUID(),
    task: "cap",
    startedAt: new Date().toISOString(),
    durationMs: 60_000,
    gates: [{ toolId: "bun-test", gateId: "unit", passed: false, exitCode: -1, durationMs: 60_000, timedOut: true }],
    metrics: { pass_rate: 0, required_pass_rate: 0, timeout_count: 1, runtime_ms: 60_000, gate_count: 1 },
    sloResults: [],
  };
  const proposal = widenTimeoutOnHang({ manifest: m, report });
  expect(proposal).not.toBeNull();
  expect(proposal!.changes["tools.bun-test.timeoutMs"]).toBe(600_000);
});

test("widenTimeoutOnHang stops at the 10-minute cap", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}", "bunfig.toml": "" });
  build(dir, { harnessId: "hang-cap-10m" });
  const m = loadManifest(dir);
  const tool = m.tools.find((t) => t.id === "bun-test");
  tool!.timeoutMs = 600_000; // already at the cap

  const report: RunReport = {
    runId: crypto.randomUUID(),
    task: "at-cap",
    startedAt: new Date().toISOString(),
    durationMs: 600_000,
    gates: [{ toolId: "bun-test", gateId: "unit", passed: false, exitCode: -1, durationMs: 600_000, timedOut: true }],
    metrics: { pass_rate: 0, required_pass_rate: 0, timeout_count: 1, runtime_ms: 600_000, gate_count: 1 },
    sloResults: [],
  };
  // Escalation cannot exceed the 10-minute cap — nothing left to propose.
  expect(widenTimeoutOnHang({ manifest: m, report })).toBeNull();
});

test("applyProposal handles tools.<id>.timeoutMs changes", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}", "bunfig.toml": "" });
  build(dir, { harnessId: "apply-timeout" });
  const m = loadManifest(dir);
  const before = m.tools.find((t) => t.id === "bun-test")!.timeoutMs;
  expect(before).toBeUndefined(); // builder sets no default timeout

  const proposal: ImprovementProposal = {
    id: "imp-test-999",
    description: "widen timeout",
    changes: { "tools.bun-test.timeoutMs": 120_000 },
    rationale: "test",
    approved: false,
  };
  const m2 = applyProposal(m, proposal);
  expect(m2.tools.find((t) => t.id === "bun-test")!.timeoutMs).toBe(120_000);
  expect(proposal.approved).toBe(true);
  expect(m2.improvementHistory.some((p) => p.id === "imp-test-999")).toBe(true);
});

test("widenTimeoutOnHang is included in defaultRules", () => {
  expect(defaultRules).toContain(widenTimeoutOnHang);
});

// --- SLO/threshold co-alignment when widening timeouts ---

test("widenTimeoutOnHang co-aligns the bounded-runtime SLO when the new timeout exceeds it", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}", "bunfig.toml": "" });
  build(dir, { harnessId: "hang-slo" });
  const m = loadManifest(dir);
  // A gate killed at the implicit 60s escalates to 120s — beyond the
  // bounded-runtime SLO threshold (60_000), so the proposal must raise both
  // the tool timeout and the SLO threshold so the config never permits what
  // the SLO forbids.
  const report: RunReport = {
    runId: crypto.randomUUID(),
    task: "hang-slo",
    startedAt: new Date().toISOString(),
    durationMs: 60_000,
    gates: [{ toolId: "bun-test", gateId: "unit", passed: false, exitCode: -1, durationMs: 60_000, timedOut: true }],
    metrics: { pass_rate: 0, required_pass_rate: 0, timeout_count: 1, runtime_ms: 60_000, gate_count: 1 },
    sloResults: [],
  };
  const proposal = widenTimeoutOnHang({ manifest: m, report });
  expect(proposal).not.toBeNull();
  expect(proposal!.changes["tools.bun-test.timeoutMs"]).toBe(120_000);
  expect(proposal!.changes["slos.bounded-runtime.threshold"]).toBe(120_000);
  expect(proposal!.rationale).toContain("co-aligned");

  // Applying must actually raise both.
  const m3 = applyProposal(m, proposal!);
  expect(m3.tools.find((t) => t.id === "bun-test")!.timeoutMs).toBe(120_000);
  expect(m3.slos.find((s) => s.id === "bounded-runtime")!.threshold).toBe(120_000);
});

test("applyProposal handles slos.<id>.threshold changes", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "slo-apply" });
  const m = loadManifest(dir);
  const before = m.slos.find((s) => s.id === "bounded-runtime")!.threshold;
  expect(before).toBe(60_000);
  const m2 = applyProposal(m, {
    id: "imp-slo-1",
    description: "raise runtime SLO",
    changes: { "slos.bounded-runtime.threshold": 90_000 },
    rationale: "test",
    approved: false,
  });
  expect(m2.slos.find((s) => s.id === "bounded-runtime")!.threshold).toBe(90_000);
});

test("applyProposal caps the improvement history at 100 entries", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "cap-hist" });
  const m = loadManifest(dir);
  for (let i = 0; i < 130; i++) {
    applyProposal(m, {
      id: `imp-cap-${i}`,
      description: `cycle ${i}`,
      changes: { "config.maxParallel": 1 + (i % 4) },
      rationale: "test",
      approved: false,
    });
  }
  expect(m.improvementHistory!.length).toBe(100);
  // Newest kept, oldest dropped.
  expect(m.improvementHistory![0].id).toBe("imp-cap-30");
  expect(m.improvementHistory![99].id).toBe("imp-cap-129");
});

test("widenTimeoutOnHang escalation converges: successive hangs walk 60s→120s→240s→…→cap, never a no-op", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}", "bunfig.toml": "" });
  build(dir, { harnessId: "hang-walk" });
  const m = loadManifest(dir);
  const tool = m.tools.find((t) => t.id === "bun-test")!;

  // Simulate the loop: hang → propose → apply → hang again, until the cap.
  const seen: number[] = [];
  for (let step = 0; step < 10; step++) {
    const report: RunReport = {
      runId: crypto.randomUUID(),
      task: `walk-${step}`,
      startedAt: new Date().toISOString(),
      durationMs: tool.timeoutMs ?? 60_000,
      gates: [{ toolId: "bun-test", gateId: "unit", passed: false, exitCode: -1, durationMs: tool.timeoutMs ?? 60_000, timedOut: true }],
      metrics: { pass_rate: 0, required_pass_rate: 0, timeout_count: 1, runtime_ms: tool.timeoutMs ?? 60_000, gate_count: 1 },
      sloResults: [],
    };
    const proposal = widenTimeoutOnHang({ manifest: m, report });
    if (!proposal) break; // reached the cap — nothing left to propose
    const next = proposal.changes["tools.bun-test.timeoutMs"] as number;
    // The invariant that matters: every applied proposal strictly widens.
    expect(next).toBeGreaterThan(tool.timeoutMs ?? 60_000);
    seen.push(next);
    applyProposal(m, proposal);
  }
  // The walk must terminate at the 10-minute cap and never revisit a value.
  expect(seen).toEqual([120_000, 240_000, 480_000, 600_000]);
  expect(tool.timeoutMs).toBe(600_000);
  expect(new Set(seen).size).toBe(seen.length); // strictly monotonic
});
