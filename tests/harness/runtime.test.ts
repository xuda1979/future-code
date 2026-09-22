/**
 * Tests for the harness runtime — gate execution, parallelism, and metrics.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../src/harness/builder/index.ts";
import { loadManifest, saveManifest } from "../../src/harness/registry.ts";
import { run, runGate, execTool, toSamples } from "../../src/harness/runtime/index.ts";
import type { HarnessManifest, RunReport } from "../../src/harness/types.ts";

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-rt-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test("run executes all gates and returns a report", async () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "rt-test" });
  const m = loadManifest(dir);
  
  const report = await run(m, "test-task");
  expect(report.runId).toBeDefined();
  expect(report.task).toBe("test-task");
  expect(report.gates.length).toBeGreaterThan(0);
  expect(report.metrics.gate_count).toBeGreaterThan(0);
  expect(report.metrics.pass_rate).toBeGreaterThanOrEqual(0);
  expect(report.metrics.runtime_ms).toBeGreaterThanOrEqual(0);
  expect(report.sloResults).toEqual([]);
});

test("run respects maxParallel config", async () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "rt-test" });
  const m = loadManifest(dir);
  
  // Set maxParallel to 1 (sequential)
  m.config.maxParallel = 1;
  saveManifest(dir, m);
  
  const report = await run(m, "parallel-test");
  expect(report.gates.length).toBeGreaterThan(0);
  // All gates should have been executed
  expect(report.metrics.gate_count).toBe(m.gates.length);
});

test("runGate executes a specific gate", async () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "rt-test" });
  const m = loadManifest(dir);
  
  const gateId = m.gates[0].id;
  const result = await runGate(m, gateId);
  expect(result.toolId).toBeDefined();
  expect(result.passed).toBeDefined();
  expect(result.exitCode).toBeDefined();
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
});

test("execTool runs a command and returns exit code", async () => {
  const result = await execTool("true", process.cwd());
  expect(result.exitCode).toBe(0);
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
});

test("execTool captures non-zero exit code", async () => {
  const result = await execTool("false", process.cwd());
  expect(result.exitCode).toBe(1);
});

test("toSamples converts a RunReport into MetricSamples", () => {
  const report: RunReport = {
    runId: "sample-test",
    task: "test",
    startedAt: new Date().toISOString(),
    durationMs: 100,
    gates: [
      { toolId: "tool1", passed: true, exitCode: 0, durationMs: 50 },
      { toolId: "tool2", passed: false, exitCode: 1, durationMs: 50 },
    ],
    metrics: { pass_rate: 0.5, runtime_ms: 100, gate_count: 2 },
    sloResults: [],
  };
  
  const samples = toSamples(report);
  expect(samples.length).toBe(2);
  expect(samples[0].toolId).toBe("tool1");
  expect(samples[0].passed).toBe(true);
  expect(samples[1].toolId).toBe("tool2");
  expect(samples[1].passed).toBe(false);
});

test("run with multiple gates reports correct pass rate", async () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "rt-test" });
  const m = loadManifest(dir);
  
  const report = await run(m, "multi-gate");
  const expectedPassRate = report.gates.length
    ? report.gates.filter((g) => g.passed).length / report.gates.length
    : 0;
  expect(report.metrics.pass_rate).toBeCloseTo(expectedPassRate, 5);
});
