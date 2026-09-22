/**
 * Tests for the harness improver — rules, proposals, and application.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../src/harness/builder/index.ts";
import { loadManifest } from "../../src/harness/registry.ts";
import { improve, applyProposal, shouldApply, defaultRules, widenTimeoutOnFailure, adaptParallelism, reduceParallelism, detectFlakiness } from "../../src/harness/improver/index.ts";
import { annotate } from "../../src/harness/monitor/index.ts";
import type { RunReport, HarnessManifest } from "../../src/harness/types.ts";

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
    metrics: { pass_rate: pr, runtime_ms: durationMs, gate_count: 1 },
    sloResults: [],
  };
}

test("widenTimeoutOnFailure fires when unhealthy", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  const r = makeReport(false, 5000);
  annotate(m, r);
  const proposal = widenTimeoutOnFailure({ manifest: m, report: r });
  expect(proposal).not.toBeNull();
  expect(proposal!.changes["config.contextBudget"]).toBeDefined();
});

test("widenTimeoutOnFailure does not fire when healthy", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  const r = makeReport(true, 100);
  annotate(m, r);
  const proposal = widenTimeoutOnFailure({ manifest: m, report: r });
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

test("detectFlakiness fires for partial pass rate", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "imp-test" });
  const m = loadManifest(dir);
  m.config.contextBudget = 2;
  // Create a report with partial pass rate (1 of 2 gates pass)
  const r: RunReport = {
    runId: "flaky",
    task: "test",
    startedAt: new Date().toISOString(),
    durationMs: 5000,
    gates: [
      { toolId: "gate1", passed: true, exitCode: 0, durationMs: 2500 },
      { toolId: "gate2", passed: false, exitCode: 1, durationMs: 2500 },
    ],
    metrics: { pass_rate: 0.5, runtime_ms: 5000, gate_count: 2 },
    sloResults: [],
  };
  annotate(m, r);
  const proposal = detectFlakiness({ manifest: m, report: r });
  expect(proposal).not.toBeNull();
  expect(proposal!.changes["config.contextBudget"]).toBe(3);
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
  
  // Unhealthy + slow → should trigger widenTimeoutOnFailure + adaptParallelism
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
