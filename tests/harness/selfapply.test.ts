/**
 * End-to-end tests for the harness self-apply loop.
 * Tests that the full build → run → annotate → recordRun → improve cycle works.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../src/harness/builder/index.ts";
import { loadManifest, saveManifest } from "../../src/harness/registry.ts";
import { run } from "../../src/harness/runtime/index.ts";
import { annotate, healthy, summary, evaluateSLOs } from "../../src/harness/monitor/index.ts";
import { improve, applyProposal, defaultRules } from "../../src/harness/improver/index.ts";
import { recordRun, recentRuns, passRateTrend } from "../../src/harness/history.ts";
import type { RunReport, HarnessManifest } from "../../src/harness/types.ts";

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-e2e-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test("full self-apply cycle: build → run → annotate → record → improve", async () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });

  // 1. Build the harness
  build(dir, { harnessId: "e2e-test" });
  expect(existsSync(join(dir, ".future-code", "harness", "harness.json"))).toBe(true);

  // 2. Load manifest and run
  let m = loadManifest(dir);
  expect(m.tools.length).toBeGreaterThan(0);
  expect(m.gates.length).toBeGreaterThan(0);

  // 3. Run the harness
  const r = await run(m, "e2e-self-apply");
  expect(r.runId).toBeDefined();
  expect(r.gates.length).toBeGreaterThan(0);
  expect(r.metrics.pass_rate).toBeGreaterThanOrEqual(0);

  // 4. Annotate with SLO results
  annotate(m, r);
  expect(r.sloResults.length).toBeGreaterThan(0);
  
  // 5. Record run to history
  const m2 = recordRun(dir, r);
  expect(m2.runHistory.length).toBe(1);
  expect(m2.runHistory[0].runId).toBe(r.runId);
  
  // 6. Check health
  const isHealthy = healthy(r);
  expect(typeof isHealthy).toBe("boolean");
  
  // 7. If unhealthy, improve
  if (!isHealthy) {
    const proposals = improve(m, r, defaultRules);
    expect(proposals.length).toBeGreaterThan(0);
    const applied = applyProposal(m, proposals[0]);
    expect(applied.improvementHistory.length).toBeGreaterThan(0);
  }
});

test("multiple self-apply runs accumulate history", async () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "e2e-multi" });
  
  for (let i = 0; i < 5; i++) {
    const m = loadManifest(dir);
    const r = await run(m, `run-${i}`);
    annotate(m, r);
    recordRun(dir, r);
  }
  
  const m = loadManifest(dir);
  expect(m.runHistory.length).toBe(5);
  
  // All runs should have unique runIds
  const runIds = m.runHistory.map((r) => r.runId);
  const unique = new Set(runIds);
  expect(unique.size).toBe(5);
});

test("pass rate trend reflects run history", async () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "e2e-trend" });
  
  // All passing
  for (let i = 0; i < 3; i++) {
    const m = loadManifest(dir);
    const r = await run(m, `pass-${i}`);
    annotate(m, r);
    recordRun(dir, r);
  }
  
  const trend = passRateTrend(dir, 10);
  expect(trend.length).toBe(3);
  expect(trend.every((v) => v === 1)).toBe(true);
});

test("SLO evaluation detects failures", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "e2e-slo" });
  const m = loadManifest(dir);
  
  // Simulate a failing run
  const failingReport: RunReport = {
    runId: "fail-test",
    task: "fail-test",
    startedAt: new Date().toISOString(),
    durationMs: 70000, // exceeds 60s SLO
    gates: [{ toolId: "test-tool", passed: false, exitCode: 1, durationMs: 70000 }],
    metrics: { pass_rate: 0, runtime_ms: 70000, gate_count: 1 },
    sloResults: [],
  };
  
  annotate(m, failingReport);
  expect(failingReport.sloResults.length).toBeGreaterThan(0);
  
  // At least one SLO should be unmet
  const unmet = failingReport.sloResults.filter((s) => !s.met);
  expect(unmet.length).toBeGreaterThan(0);
  expect(healthy(failingReport)).toBe(false);
});

test("improver generates proposals for failing SLOs", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "e2e-improve" });
  const m = loadManifest(dir);
  
  const badReport: RunReport = {
    runId: "bad-run",
    task: "bad-run",
    startedAt: new Date().toISOString(),
    durationMs: 90000,
    gates: [{ toolId: "test-tool", passed: false, exitCode: 1, durationMs: 90000 }],
    metrics: { pass_rate: 0, runtime_ms: 90000, gate_count: 1 },
    sloResults: [],
  };
  
  annotate(m, badReport);
  const proposals = improve(m, badReport, defaultRules);
  expect(proposals.length).toBeGreaterThanOrEqual(1);
  
  // Apply first proposal
  const before = m.config.maxParallel;
  const applied = applyProposal(m, proposals[0]);
  expect(applied.improvementHistory.length).toBeGreaterThanOrEqual(1);
  expect(applied.improvementHistory[applied.improvementHistory.length - 1].approved).toBe(true);
});

test("summary produces correct health report", () => {
  const report: RunReport = {
    runId: "sum-test",
    task: "sum-test",
    startedAt: new Date().toISOString(),
    durationMs: 100,
    gates: [{ toolId: "t", passed: true, exitCode: 0, durationMs: 100 }],
    metrics: { pass_rate: 1, runtime_ms: 100, gate_count: 1 },
    sloResults: [{ sloId: "pass-rate", met: true, observed: 1, threshold: 1, op: "gte" }],
  };
  
  const s = summary(report);
  expect(s.runId).toBe("sum-test");
  expect(s.healthy).toBe(true);
  expect(s.passRate).toBe(1);
  expect(s.runtimeMs).toBe(100);
  expect(s.unmetSlo).toEqual([]);
});

test("manifest persists across save/load cycles", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "e2e-persist" });
  
  const m1 = loadManifest(dir);
  m1.config.maxParallel = 4;
  saveManifest(dir, m1);
  
  const m2 = loadManifest(dir);
  expect(m2.config.maxParallel).toBe(4);
  expect(m2.harnessId).toBe("e2e-persist");
});
