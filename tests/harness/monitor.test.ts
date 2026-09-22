/**
 * Tests for the harness monitor — SLO evaluation, health scoring,
 * degradation detection, and runtime analysis.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../src/harness/builder/index.ts";
import { loadManifest } from "../../src/harness/registry.ts";
import { evaluateSLOs, annotate, healthy, summary, healthScore, detectDegradation, averageRuntime, isRuntimeDegrading } from "../../src/harness/monitor/index.ts";
import type { RunReport, HarnessRunRecord, HarnessManifest } from "../../src/harness/types.ts";

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-mon-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function makeReport(passRate: number, runtimeMs: number): RunReport {
  const passed = passRate >= 1;
  return {
    runId: crypto.randomUUID(),
    task: "monitor-test",
    startedAt: new Date().toISOString(),
    durationMs: runtimeMs,
    gates: [{ toolId: "test", passed, exitCode: passed ? 0 : 1, durationMs: runtimeMs }],
    metrics: { pass_rate: passRate, required_pass_rate: passRate, runtime_ms: runtimeMs, gate_count: 1 },
    sloResults: [],
  };
}

function makeRunRecord(passRate: number, durationMs: number, runId?: string): HarnessRunRecord {
  return {
    runId: runId ?? crypto.randomUUID(),
    task: "test",
    startedAt: new Date().toISOString(),
    durationMs,
    passRate,
    healthy: passRate >= 1,
    gateCount: 1,
    passedCount: passRate >= 1 ? 1 : 0,
    metrics: { pass_rate: passRate, required_pass_rate: passRate, runtime_ms: durationMs, gate_count: 1 },
    unmetSlo: passRate >= 1 ? [] : ["pass-rate"],
  };
}

test("evaluateSLOs correctly evaluates gte operator", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "mon-test" });
  const m = loadManifest(dir);
  const r = makeReport(1, 100);
  const slos = evaluateSLOs(m, r);
  expect(slos.length).toBeGreaterThan(0);
  // pass-rate SLO should be met (pass_rate=1 >= threshold=1)
  const passRateSlo = slos.find((s) => s.sloId === "pass-rate");
  expect(passRateSlo).toBeDefined();
  expect(passRateSlo!.met).toBe(true);
});

test("evaluateSLOs correctly evaluates lte operator", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "mon-test" });
  const m = loadManifest(dir);
  const r = makeReport(1, 100); // runtime 100ms <= 60000ms
  const slos = evaluateSLOs(m, r);
  const runtimeSlo = slos.find((s) => s.sloId === "bounded-runtime");
  expect(runtimeSlo).toBeDefined();
  expect(runtimeSlo!.met).toBe(true);
});

test("evaluateSLOs detects SLO violation", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "mon-test" });
  const m = loadManifest(dir);
  const r = makeReport(0, 70000); // pass_rate=0 (fail), runtime 70s > 60s
  const slos = evaluateSLOs(m, r);
  const passRateSlo = slos.find((s) => s.sloId === "pass-rate");
  expect(passRateSlo!.met).toBe(false);
  const runtimeSlo = slos.find((s) => s.sloId === "bounded-runtime");
  expect(runtimeSlo!.met).toBe(false);
});

test("annotate merges SLO results into report", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "mon-test" });
  const m = loadManifest(dir);
  const r = makeReport(1, 100);
  annotate(m, r);
  expect(r.sloResults.length).toBeGreaterThan(0);
});

test("healthy returns true when all SLOs are met", () => {
  const r = makeReport(1, 100);
  r.sloResults = [{ sloId: "pass-rate", met: true, observed: 1, threshold: 1, op: "gte" }];
  expect(healthy(r)).toBe(true);
});

test("healthy returns false when any SLO is unmet", () => {
  const r = makeReport(0, 100);
  r.sloResults = [{ sloId: "pass-rate", met: false, observed: 0, threshold: 1, op: "gte" }];
  expect(healthy(r)).toBe(false);
});

test("healthScore returns 1 when all SLOs are met", () => {
  const r = makeReport(1, 100);
  r.sloResults = [
    { sloId: "pass-rate", met: true, observed: 1, threshold: 1, op: "gte" },
    { sloId: "runtime", met: true, observed: 100, threshold: 60000, op: "lte" },
  ];
  expect(healthScore(r)).toBe(1);
});

test("healthScore returns 0.5 when half SLOs are met", () => {
  const r = makeReport(1, 70000);
  r.sloResults = [
    { sloId: "pass-rate", met: true, observed: 1, threshold: 1, op: "gte" },
    { sloId: "runtime", met: false, observed: 70000, threshold: 60000, op: "lte" },
  ];
  expect(healthScore(r)).toBe(0.5);
});

test("detectDegradation returns not degrading for stable history", () => {
  const history: HarnessRunRecord[] = [];
  for (let i = 0; i < 5; i++) history.push(makeRunRecord(1, 100));
  const result = detectDegradation(history);
  expect(result.degrading).toBe(false);
  expect(result.trend).toBe(0);
});

test("detectDegradation detects declining pass rate", () => {
  const history: HarnessRunRecord[] = [
    makeRunRecord(1, 100),
    makeRunRecord(1, 100),
    makeRunRecord(0.5, 100),
    makeRunRecord(0, 100),
    makeRunRecord(0, 100),
  ];
  const result = detectDegradation(history);
  expect(result.degrading).toBe(true);
  expect(result.trend).toBeLessThan(0);
});

test("detectDegradation handles short history", () => {
  const result = detectDegradation([makeRunRecord(1, 100)]);
  expect(result.degrading).toBe(false);
  expect(result.confidence).toBe(0);
});

test("averageRuntime computes mean of recent runs", () => {
  const history: HarnessRunRecord[] = [
    makeRunRecord(1, 100),
    makeRunRecord(1, 200),
    makeRunRecord(1, 300),
  ];
  expect(averageRuntime(history)).toBe(200);
});

test("averageRuntime handles empty history", () => {
  expect(averageRuntime([])).toBe(0);
});

test("isRuntimeDegrading detects slowing runs", () => {
  const history: HarnessRunRecord[] = [
    makeRunRecord(1, 100),
    makeRunRecord(1, 110),
    makeRunRecord(1, 500),
    makeRunRecord(1, 600),
    makeRunRecord(1, 700),
  ];
  expect(isRuntimeDegrading(history)).toBe(true);
});

test("isRuntimeDegrading returns false for stable runtime", () => {
  const history: HarnessRunRecord[] = [
    makeRunRecord(1, 100),
    makeRunRecord(1, 110),
    makeRunRecord(1, 105),
    makeRunRecord(1, 100),
    makeRunRecord(1, 95),
  ];
  expect(isRuntimeDegrading(history)).toBe(false);
});

test("summary produces correct output", () => {
  const r = makeReport(1, 100);
  r.sloResults = [{ sloId: "pass-rate", met: true, observed: 1, threshold: 1, op: "gte" }];
  const s = summary(r);
  expect(s.runId).toBe(r.runId);
  expect(s.healthy).toBe(true);
  expect(s.passRate).toBe(1);
  expect(s.runtimeMs).toBe(100);
  expect(s.unmetSlo).toEqual([]);
});
