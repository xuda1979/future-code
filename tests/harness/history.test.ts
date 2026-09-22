/**
 * Tests for the harness history module — run record persistence,
 * trend analysis, and run history accumulation.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../src/harness/builder/index.ts";
import { loadManifest } from "../../src/harness/registry.ts";
import { recordRun, recentRuns, passRateTrend, runtimeTrend, toRunRecord } from "../../src/harness/history.ts";
import type { RunReport, HarnessManifest } from "../../src/harness/types.ts";

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-hist-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function makeReport(passed: boolean, durationMs: number, runId?: string): RunReport {
  return {
    runId: runId ?? crypto.randomUUID(),
    task: "test",
    startedAt: new Date().toISOString(),
    durationMs,
    gates: [{ toolId: "test-tool", passed, exitCode: passed ? 0 : 1, durationMs }],
    metrics: { pass_rate: passed ? 1 : 0, runtime_ms: durationMs, gate_count: 1 },
    sloResults: [],
  };
}

test("toRunRecord converts a RunReport correctly", () => {
  const report = makeReport(true, 100, "run-1");
  const rec = toRunRecord(report);
  expect(rec.runId).toBe("run-1");
  expect(rec.task).toBe("test");
  expect(rec.passRate).toBe(1);
  expect(rec.durationMs).toBe(100);
  expect(rec.gateCount).toBe(1);
  expect(rec.passedCount).toBe(1);
});

test("recordRun persists to manifest on disk", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "hist-test" });
  
  const r1 = makeReport(true, 50, "run-a");
  recordRun(dir, r1);
  
  const m = loadManifest(dir);
  expect(m.runHistory.length).toBe(1);
  expect(m.runHistory[0].runId).toBe("run-a");
  expect(m.runHistory[0].passedCount).toBe(1);
});

test("recordRun accumulates multiple runs", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "hist-test" });
  
  recordRun(dir, makeReport(true, 50, "run-1"));
  recordRun(dir, makeReport(true, 60, "run-2"));
  recordRun(dir, makeReport(false, 70, "run-3"));
  
  const m = loadManifest(dir);
  expect(m.runHistory.length).toBe(3);
  expect(m.runHistory[0].runId).toBe("run-1");
  expect(m.runHistory[1].runId).toBe("run-2");
  expect(m.runHistory[2].runId).toBe("run-3");
  expect(m.runHistory[2].passedCount).toBe(0);
});

test("recentRuns returns last N runs", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "hist-test" });
  
  for (let i = 0; i < 5; i++) {
    recordRun(dir, makeReport(true, 50 + i * 10, `run-${i}`));
  }
  
  const recent = recentRuns(dir, 3);
  expect(recent.length).toBe(3);
  expect(recent[0].runId).toBe("run-2");
  expect(recent[2].runId).toBe("run-4");
});

test("passRateTrend extracts pass rate history", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "hist-test" });
  
  recordRun(dir, makeReport(true, 50, "r1"));  // pass_rate=1
  recordRun(dir, makeReport(false, 60, "r2")); // pass_rate=0
  recordRun(dir, makeReport(true, 70, "r3"));  // pass_rate=1
  
  const trend = passRateTrend(dir, 10);
  expect(trend).toEqual([1, 0, 1]);
});

test("runtimeTrend extracts runtime history", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "hist-test" });
  
  recordRun(dir, makeReport(true, 50, "r1"));
  recordRun(dir, makeReport(true, 100, "r2"));
  recordRun(dir, makeReport(true, 150, "r3"));
  
  const trend = runtimeTrend(dir, 10);
  expect(trend).toEqual([50, 100, 150]);
});

test("recordRun respects default limit of 100", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "hist-test" });
  
  for (let i = 0; i < 110; i++) {
    recordRun(dir, makeReport(true, 50, `run-${i}`));
  }
  
  const m = loadManifest(dir);
  expect(m.runHistory.length).toBe(100);
  // First 10 should be trimmed, last 100 kept
  expect(m.runHistory[0].runId).toBe("run-10");
  expect(m.runHistory[99].runId).toBe("run-109");
});

// --- defensive health recording ---

test("toRunRecord derives health from required gates when SLOs are not annotated", () => {
  // A caller that skips annotate() must never record a fully-failing run
  // as healthy — health falls back to required-gate outcomes.
  const failing: RunReport = {
    runId: "no-anno-fail",
    task: "t",
    startedAt: new Date().toISOString(),
    durationMs: 10,
    gates: [
      { toolId: "node-test", gateId: "unit", passed: false, exitCode: 1, durationMs: 5, required: true },
    ],
    metrics: { pass_rate: 0, required_pass_rate: 0, runtime_ms: 10, gate_count: 1 },
    sloResults: [], // unannotated
  };
  const rec = toRunRecord(failing);
  expect(rec.healthy).toBe(false);

  const passing: RunReport = {
    ...failing,
    runId: "no-anno-pass",
    gates: [{ toolId: "node-test", gateId: "unit", passed: true, exitCode: 0, durationMs: 5, required: true }],
    metrics: { pass_rate: 1, required_pass_rate: 1, runtime_ms: 10, gate_count: 1 },
  };
  const rec2 = toRunRecord(passing);
  expect(rec2.healthy).toBe(true);

  // An advisory gate failing alone does not imply unhealthy.
  const advisoryFail: RunReport = {
    ...failing,
    runId: "no-anno-adv",
    gates: [
      { toolId: "node-test", gateId: "unit", passed: true, exitCode: 0, durationMs: 5, required: true },
      { toolId: "typecheck", gateId: "typecheck", passed: false, exitCode: 2, durationMs: 5, required: false },
    ],
  };
  const rec3 = toRunRecord(advisoryFail);
  expect(rec3.healthy).toBe(true);
});

test("toRunRecord keeps SLO-derived health when annotated", () => {
  const report: RunReport = {
    runId: "anno",
    task: "t",
    startedAt: new Date().toISOString(),
    durationMs: 10,
    gates: [{ toolId: "node-test", gateId: "unit", passed: true, exitCode: 0, durationMs: 5, required: true }],
    metrics: { pass_rate: 1, required_pass_rate: 1, runtime_ms: 10, gate_count: 1, context_utilization: 2.0 },
    sloResults: [{ sloId: "bounded-context", met: false, observed: 2.0, threshold: 1.0, op: "lte" }],
  };
  const rec = toRunRecord(report);
  expect(rec.healthy).toBe(false);
  expect(rec.unmetSlo).toEqual(["bounded-context"]);
});
