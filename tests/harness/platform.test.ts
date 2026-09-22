import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- builder: detection + manifest generation ---
import { detectCues, build } from "../../src/harness/builder/index.ts";
import { loadManifest, hasManifest, harnessDir } from "../../src/harness/registry.ts";
import { evaluateSLOs, healthy, summary } from "../../src/harness/monitor/index.ts";
import { improve, applyProposal, defaultRules } from "../../src/harness/improver/index.ts";
import type { RunReport, SloResult } from "../../src/harness/types.ts";

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hx-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    writeFileSync(p, body, { recursive: true } as any);
  }
  return dir;
}

test("detectCues: bare package.json (no bunfig) is a node project", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  const c = detectCues(dir);
  expect(c.language).toBe("typescript");
  expect(c.testRunner).toBe("node-test");
});

test("detectCues: bunfig marks a bun project", () => {
  const dir = tempProject({ "package.json": "{}", "bunfig.toml": "" });
  const c = detectCues(dir);
  expect(c.testRunner).toBe("bun-test");
});

test("build generates and persists a manifest", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}", "bunfig.toml": "" });
  const { manifest, cues } = build(dir, { harnessId: "t1" });
  expect(cues.testRunner).toBe("bun-test");
  expect(hasManifest(dir)).toBe(true);
  const loaded = loadManifest(dir);
  expect(loaded.harnessId).toBe("t1");
  expect(loaded.gates.map((g) => g.toolId)).toContain("bun-test");
  void manifest;
});

test("registry rejects unknown schema", () => {
  const dir = tempProject({});
  expect(() => loadManifest(dir)).toThrow();
});

test("evaluateSLOs reports pass-rate met/unmet", () => {
  const m = { slos: [{ id: "p", metric: "pass_rate", op: "gte", threshold: 1.0 }] } as any;
  const pass: RunReport = { runId: "r1", task: "t", startedAt: "", durationMs: 1, gates: [], metrics: { pass_rate: 1 }, sloResults: evaluateSLOs(m, { metrics: { pass_rate: 1 } } as any) };
  const fail: RunReport = { runId: "r2", task: "t", startedAt: "", durationMs: 1, gates: [], metrics: { pass_rate: 0 }, sloResults: evaluateSLOs(m, { metrics: { pass_rate: 0 } } as any) };
  expect(healthy(pass)).toBe(true);
  expect(healthy(fail)).toBe(false);
  void summary;
});

test("improver proposes, applies, and records with audit trail", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  const { manifest } = build(dir, { harnessId: "t2" });
  // simulate an unhealthy run (gate failures): compute SLO results so the
  // improver sees the harness as failing its pass-rate SLO.
  const bad: RunReport = {
    runId: "rx", task: "task", startedAt: "", durationMs: 5000, gates: [], metrics: { pass_rate: 0, runtime_ms: 5000 }, sloResults: [],
  };
  bad.sloResults = evaluateSLOs(manifest, bad);
  const props = improve(manifest, bad, defaultRules);
  expect(props.length).toBeGreaterThanOrEqual(1);
  const applied = applyProposal(manifest, props[0]);
  expect(applied.improvementHistory.length).toBeGreaterThanOrEqual(1);
  expect(applied.improvementHistory[applied.improvementHistory.length - 1].approved).toBe(true);
  void ([] as SloResult[]);
});

test("self-application: harness dir exists after build", () => {
  const dir = tempProject({ "package.json": "{}", "tsconfig.json": "{}" });
  build(dir, { harnessId: "self" });
  expect(existsSync(harnessDir(dir))).toBe(true);
});
