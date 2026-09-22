/**
 * Tests for multi-language harness support (Go, Rust) + advisory gates +
 * quarantine improver rule + required_pass_rate semantics.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { detectCues, build } from "../../src/harness/builder/index.ts";
import { loadManifest } from "../../src/harness/registry.ts";
import { run } from "../../src/harness/runtime/index.ts";
import {
  improve,
  applyProposal,
  quarantineRepeatFailure,
} from "../../src/harness/improver/index.ts";
import { annotate } from "../../src/harness/monitor/index.ts";
import { recordRun } from "../../src/harness/history.ts";
import type { RunReport } from "../../src/harness/types.ts";

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hx-ml-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

// --- Go project detection ---

test("detects a Go project (go.mod) with go-test runner", () => {
  const dir = tempProject({
    "go.mod": "module example.com/foo\n\ngo 1.22\n",
  });
  const cues = detectCues(dir);
  expect(cues.language).toBe("golang");
  expect(cues.testRunner).toBe("go-test");
  expect(cues.hasGoMod).toBe(true);
  expect(cues.hasCargoToml).toBe(false);
});

test("Go build scaffolds go-test tool and unit gate", () => {
  const dir = tempProject({
    "go.mod": "module example.com/foo\n\ngo 1.22\n",
  });
  build(dir, { harnessId: "go-h" });
  const m = loadManifest(dir);
  expect(m.tools.map((t) => t.id)).toContain("go-test");
  const unit = m.gates.find((g) => g.id === "unit");
  expect(unit).toBeDefined();
  expect(unit!.toolId).toBe("go-test");
  expect(unit!.required).toBe(true);
});

test("go.mod takes priority over a stray package.json", () => {
  const dir = tempProject({
    "go.mod": "module example.com/foo\n\ngo 1.22\n",
    "package.json": JSON.stringify({ name: "stray" }),
  });
  const cues = detectCues(dir);
  expect(cues.language).toBe("golang");
  expect(cues.testRunner).toBe("go-test");
});

// --- Rust project detection ---

test("detects a Rust project (Cargo.toml) with cargo-test runner", () => {
  const dir = tempProject({
    "Cargo.toml": "[package]\nname = \"foo\"\nversion = \"0.1.0\"\n",
  });
  const cues = detectCues(dir);
  expect(cues.language).toBe("rust");
  expect(cues.testRunner).toBe("cargo-test");
  expect(cues.hasCargoToml).toBe(true);
});

test("Rust build scaffolds cargo-test tool and unit gate", () => {
  const dir = tempProject({
    "Cargo.toml": "[package]\nname = \"foo\"\nversion = \"0.1.0\"\n",
  });
  build(dir, { harnessId: "rs-h" });
  const m = loadManifest(dir);
  expect(m.tools.map((t) => t.id)).toContain("cargo-test");
  const unit = m.gates.find((g) => g.id === "unit");
  expect(unit).toBeDefined();
  expect(unit!.toolId).toBe("cargo-test");
});

// --- Typecheck gate (TS only, local tsc required) ---

test("typecheck gate is NOT scaffolded without local typescript", () => {
  // tsconfig present but no node_modules/typescript and no declared dep
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "no-ts" }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "ts-none" });
  const m = loadManifest(dir);
  expect(m.gates.map((g) => g.id)).not.toContain("typecheck");
  expect(m.tools.map((t) => t.id)).not.toContain("typecheck");
});

test("typecheck gate is advisory when scaffolded", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "with-ts", devDependencies: { typescript: "^5" } }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "ts-adv" });
  const m = loadManifest(dir);
  const tc = m.gates.find((g) => g.id === "typecheck");
  expect(tc).toBeDefined();
  expect(tc!.required).toBe(false); // advisory — surfaces signal, never blocks
});

// --- required_pass_rate semantics ---

test("required_pass_rate excludes advisory gate failures", async () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "t", devDependencies: { typescript: "^5" } }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "rpr" });
  const m = loadManifest(dir);
  // Force the advisory typecheck gate to fail by making the tool error out.
  const tc = m.tools.find((t) => t.id === "typecheck")!;
  tc.command = "false"; // a command that always fails with exit 1
  const report = await run(m, "advisory-fail");
  expect(report.metrics.gate_count).toBeGreaterThanOrEqual(2);
  const advisory = report.gates.find((g) => g.gateId === "typecheck");
  expect(advisory).toBeDefined();
  expect(advisory!.passed).toBe(false);
  // The advisory failure must not tank the required pass rate.
  expect(report.metrics.required_pass_rate).toBe(1);
  expect(report.metrics.pass_rate).toBeLessThan(1);
});

// --- quarantineRepeatFailure rule ---

function failingReport(m: Parameters<typeof run>[0], task: string): RunReport {
  return {
    runId: randomUUID(),
    task,
    startedAt: new Date().toISOString(),
    durationMs: 10,
    gates: m.gates.map((g) => ({
      toolId: g.toolId,
      gateId: g.id,
      passed: g.id === "unit" ? false : true,
      exitCode: g.id === "unit" ? 1 : 0,
      durationMs: 5,
      required: g.required ?? true,
      output: "",
    })),
    metrics: { pass_rate: 0.5, required_pass_rate: 0.5, runtime_ms: 10, gate_count: m.gates.length, context_budget: 4096, context_used: 10 },
    sloResults: [],
  };
}

test("quarantineRepeatFailure fires after 3 consecutive required-gate failures", async () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "q" }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "quarantine" });
  const m = loadManifest(dir);

  // Simulate 2 failed historical runs (unit failed each time).
  for (let i = 0; i < 2; i++) {
    const r = failingReport(m, `hist-${i}`);
    annotate(m, r);
    m.runHistory.push({
      runId: r.runId,
      task: r.task,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      passRate: r.metrics.pass_rate,
      healthy: false,
      gateCount: r.gates.length,
      passedCount: 1,
      metrics: r.metrics,
      unmetSlo: [],
      gateResults: Object.fromEntries(r.gates.map((g) => [g.gateId!, g.passed])),
    });
  }

  // Third failure — should propose quarantine of the unit gate.
  const r3 = failingReport(m, "third-failure");
  const proposals = improve(m, r3);
  const q = proposals.find((p) => Object.keys(p.changes).some((k) => k === "gates.unit.required"));
  expect(q).toBeDefined();
  expect(q!.changes["gates.unit.required"]).toBe(false);

  // Apply and verify the gate is now advisory.
  applyProposal(m, q!);
  const unit = m.gates.find((g) => g.id === "unit")!;
  expect(unit.required).toBe(false);
});

test("quarantineRepeatFailure does not fire before the streak threshold", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "q2" }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "quarantine-early" });
  const m = loadManifest(dir);

  // Only 1 prior failure — streak of 2 including current — below threshold.
  const r1 = failingReport(m, "first");
  m.runHistory.push({
    runId: r1.runId,
    task: r1.task,
    startedAt: r1.startedAt,
    durationMs: r1.durationMs,
    passRate: r1.metrics.pass_rate,
    healthy: false,
    gateCount: r1.gates.length,
    passedCount: 1,
    metrics: r1.metrics,
    unmetSlo: [],
    gateResults: Object.fromEntries(r1.gates.map((g) => [g.gateId!, g.passed])),
  });
  const r2 = failingReport(m, "second");
  const proposals = improve(m, r2);
  const q = proposals.find((p) => Object.keys(p.changes).some((k) => k.startsWith("gates.")));
  expect(q).toBeUndefined();
});

test("quarantineRepeatFailure ignores advisory gates", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "q3", devDependencies: { typescript: "^5" } }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "quarantine-adv" });
  const m = loadManifest(dir);
  // The typecheck gate is advisory; a long failing streak must NOT trigger
  // quarantine proposals for it.
  const report: RunReport = {
    runId: randomUUID(),
    task: "adv-fail",
    startedAt: new Date().toISOString(),
    durationMs: 10,
    gates: [{ toolId: "typecheck", gateId: "typecheck", passed: false, exitCode: 1, durationMs: 5, required: false }],
    metrics: { pass_rate: 0, required_pass_rate: 1, runtime_ms: 10, gate_count: 1, context_budget: 4096, context_used: 10 },
    sloResults: [],
  };
  const proposals = quarantineRepeatFailure({ manifest: m, report, history: [] });
  expect(proposals).toBeNull();
});

// --- applyProposal gate-path handling ---

test("applyProposal handles gate quarantine and promote round-trip", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "rt" }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "rt-gate" });
  const m = loadManifest(dir);
  const unit = m.gates.find((g) => g.id === "unit")!;
  expect(unit.required).toBe(true);

  // Quarantine.
  applyProposal(m, {
    id: "imp-x1",
    description: "quarantine unit",
    changes: { "gates.unit.required": false },
    rationale: "test",
    approved: false,
  });
  expect(m.gates.find((g) => g.id === "unit")!.required).toBe(false);

  // Promote back.
  applyProposal(m, {
    id: "imp-x2",
    description: "promote unit",
    changes: { "gates.unit.required": true },
    rationale: "test",
    approved: false,
  });
  expect(m.gates.find((g) => g.id === "unit")!.required).toBe(true);
});

// --- end-to-end: real Go project runs through the harness ---

test("real Go project: build → run → report passes unit gate", async () => {
  const dir = tempProject({
    "go.mod": "module example.com/gocheck\n\ngo 1.22\n",
    "main.go": "package main\n\nimport \"fmt\"\n\nfunc main() { fmt.Println(Add(1, 2)) }\n\nfunc Add(a, b int) int { return a + b }\n",
    "main_test.go": "package main\n\nimport \"testing\"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatalf(\"Add(1,2)=%d, want 3\", Add(1, 2))\n\t}\n}\n",
  });
  build(dir, { harnessId: "go-e2e" });
  const m = loadManifest(dir);
  const report = await run(m, "go e2e");
  const unit = report.gates.find((g) => g.gateId === "unit");
  expect(unit).toBeDefined();
  expect(unit!.passed).toBe(true); // go test ./... exits 0
  expect(report.metrics.required_pass_rate).toBe(1);
}, 120_000);

// --- end-to-end: real Rust project runs through the harness ---

test("real Rust project: build → run → report passes unit gate", async () => {
  const dir = tempProject({
    "Cargo.toml": '[package]\nname = "rscheck"\nversion = "0.1.0"\nedition = "2021"\n',
    "src/lib.rs": 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn it_adds() {\n        assert_eq!(super::add(1, 2), 3);\n    }\n}\n',
  });
  build(dir, { harnessId: "rs-e2e" });
  const m = loadManifest(dir);
  const report = await run(m, "rust e2e");
  const unit = report.gates.find((g) => g.gateId === "unit");
  expect(unit).toBeDefined();
  expect(unit!.passed).toBe(true); // cargo test exits 0
  expect(report.metrics.required_pass_rate).toBe(1);
}, 180_000);

// --- promoteStableAdvisoryGate rule + quarantine double-count fix ---

function passingAdvisoryReport(m: Parameters<typeof run>[0], task: string): RunReport {
  return {
    runId: randomUUID(),
    task,
    startedAt: new Date().toISOString(),
    durationMs: 10,
    gates: m.gates.map((g) => ({
      toolId: g.toolId,
      gateId: g.id,
      passed: true,
      exitCode: 0,
      durationMs: 5,
      required: g.required ?? true,
      output: "",
    })),
    metrics: { pass_rate: 1, runtime_ms: 10, gate_count: m.gates.length },
    sloResults: [],
  };
}

function pushRunRecord(m: Parameters<typeof run>[0], r: RunReport): void {
  m.runHistory = m.runHistory ?? [];
  m.runHistory.push({
    runId: r.runId,
    task: r.task,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    passRate: 1,
    healthy: true,
    gateCount: r.gates.length,
    passedCount: r.gates.length,
    metrics: {},
    unmetSlo: [],
    gateResults: Object.fromEntries(r.gates.map((g) => [g.gateId!, g.passed])),
  });
}

test("promoteStableAdvisoryGate fires after 5 consecutive advisory passes", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "promo", devDependencies: { typescript: "^5" } }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "promo" });
  const m = loadManifest(dir);
  expect(m.gates.find((g) => g.id === "typecheck")!.required).toBe(false);

  // 4 prior passing runs (typecheck passed each time) — below threshold.
  for (let i = 0; i < 4; i++) {
    const r = passingAdvisoryReport(m, `hist-${i}`);
    pushRunRecord(m, r);
  }

  // 5th consecutive pass (the current report) — should propose promotion.
  const r5 = passingAdvisoryReport(m, "fifth-pass");
  const proposals = improve(m, r5);
  const promo = proposals.find((p) => Object.keys(p.changes).some((k) => k === "gates.typecheck.required"));
  expect(promo).toBeDefined();
  expect(promo!.changes["gates.typecheck.required"]).toBe(true);
  expect(promo!.rationale).toContain("consecutive_passes[typecheck]=5");

  // Apply and verify the gate is required again.
  applyProposal(m, promo!);
  expect(m.gates.find((g) => g.id === "typecheck")!.required).toBe(true);
});

test("promoteStableAdvisoryGate does not fire before the pass threshold", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "promo-early", devDependencies: { typescript: "^5" } }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "promo-early" });
  const m = loadManifest(dir);

  // Only 3 prior passes — streak of 4 — below the threshold of 5.
  for (let i = 0; i < 3; i++) {
    const r = passingAdvisoryReport(m, `hist-${i}`);
    pushRunRecord(m, r);
  }
  const r4 = passingAdvisoryReport(m, "fourth-pass");
  const proposals = improve(m, r4);
  const promo = proposals.find((p) => Object.keys(p.changes).some((k) => k.startsWith("gates.") && k.endsWith(".required") && p.changes[k] === true));
  expect(promo).toBeUndefined();
});

test("promoteStableAdvisoryGate ignores a pass streak broken by a failure", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "promo-broken", devDependencies: { typescript: "^5" } }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "promo-broken" });
  const m = loadManifest(dir);

  // 3 passes, then 1 failure, then 1 more pass — streak is only 1.
  for (let i = 0; i < 3; i++) {
    const r = passingAdvisoryReport(m, `hist-pass-${i}`);
    pushRunRecord(m, r);
  }
  const failRec = passingAdvisoryReport(m, "hist-fail");
  (failRec.gates.find((g) => g.gateId === "typecheck") as { passed: boolean; exitCode: number }).passed = false;
  (failRec.gates.find((g) => g.gateId === "typecheck") as { passed: boolean; exitCode: number }).exitCode = 1;
  pushRunRecord(m, failRec);
  const rNow = passingAdvisoryReport(m, "now-pass");
  const proposals = improve(m, rNow);
  const promo = proposals.find((p) => Object.keys(p.changes).some((k) => k === "gates.typecheck.required"));
  expect(promo).toBeUndefined();
});

test("quarantineRepeatFailure does not double-count a run present in both report and history", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "qd" }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "quarantine-double" });
  const m = loadManifest(dir);

  // CLI flow: the current run is recorded into history BEFORE improve().
  // Simulate exactly that: 1 prior failure + current failure recorded too.
  const r1 = failingReport(m, "first");
  pushRunRecord(m, r1); // history now holds run 1

  const r2 = failingReport(m, "second"); // run 2 = the current report
  pushRunRecord(m, r2); // CLI: recordRun before improve — history holds 1,2

  // Even with r2 in history, real failure count is 2 — must NOT quarantine.
  let proposals = improve(m, r2);
  let q = proposals.find((p) => Object.keys(p.changes).some((k) => k === "gates.unit.required"));
  expect(q).toBeUndefined();

  // A genuinely third distinct failure (also recorded) must fire.
  const r3 = failingReport(m, "third");
  pushRunRecord(m, r3);
  proposals = improve(m, r3);
  q = proposals.find((p) => Object.keys(p.changes).some((k) => k === "gates.unit.required"));
  expect(q).toBeDefined();
  expect(q!.changes["gates.unit.required"]).toBe(false);
});

test("promoteStableAdvisoryGate does not double-count a run present in both report and history", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "pd", devDependencies: { typescript: "^5" } }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "promo-double" });
  const m = loadManifest(dir);

  // 5 real prior passes, current pass recorded too (6 records) — fires on 5.
  for (let i = 0; i < 5; i++) {
    const r = passingAdvisoryReport(m, `hist-${i}`);
    pushRunRecord(m, r);
  }
  const rNow = passingAdvisoryReport(m, "now");
  pushRunRecord(m, rNow);
  const proposals = improve(m, rNow);
  const promo = proposals.find((p) => Object.keys(p.changes).some((k) => k === "gates.typecheck.required"));
  expect(promo).toBeDefined();
  // 5 prior passes + the current pass = 6 real passes. The current run must
  // not have been counted twice (a double-count would make the streak 7).
  expect(promo!.rationale).toContain("consecutive_passes[typecheck]=6");
});

test("quarantineRepeatFailure defers to timeout widening while escalation headroom remains", async () => {
  // Regression: a slow-but-working gate kept hitting its timeout; the
  // quarantine rule counted the timeouts as failures and demoted the gate to
  // advisory after 3 hangs — before widenTimeoutOnHang's escalation
  // (60s→120s→…→600s) could ever prove the gate just needed more time.
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "q-hang" }),
    "tsconfig.json": "{}",
  });
  build(dir, { harnessId: "quarantine-hang" });
  const m = loadManifest(dir);

  // Three consecutive TIMEOUTS (not real failures) in history.
  for (let i = 0; i < 3; i++) {
    m.runHistory.push({
      runId: randomUUID(),
      task: `hang-${i}`,
      startedAt: new Date().toISOString(),
      durationMs: 60_000,
      passRate: 0,
      healthy: false,
      gateCount: 1,
      passedCount: 0,
      metrics: { timeout_count: 1 },
      unmetSlo: ["pass-rate"],
      gateResults: { unit: false },
    });
  }

  // Current report: the unit gate hung again (timedOut), timeout still has
  // widening headroom (unset → implicit 60s < 600s cap).
  const r: RunReport = {
    runId: randomUUID(),
    task: "hang-now",
    startedAt: new Date().toISOString(),
    durationMs: 60_000,
    gates: [{ toolId: "node-test", gateId: "unit", passed: false, exitCode: -1, durationMs: 60_000, required: true, timedOut: true }],
    metrics: { pass_rate: 0, required_pass_rate: 0, timeout_count: 1, runtime_ms: 60_000, gate_count: 1 },
    sloResults: [],
  };

  // Quarantine must NOT fire for the hung gate…
  const q = quarantineRepeatFailure({ manifest: m, report: r, history: m.runHistory });
  expect(q).toBeNull();

  // …but the widening rule still escalates (the correct response).
  const { widenTimeoutOnHang } = await import("../../src/harness/improver/index.ts");
  const w = widenTimeoutOnHang({ manifest: m, report: r });
  expect(w).not.toBeNull();
  expect((w!.changes["tools.node-test.timeoutMs"] as number)).toBeGreaterThan(60_000);

  // Once escalation is exhausted (timeout at the 10-min cap), a still-hung
  // gate counts as a genuine failure and quarantine may proceed.
  const tool = m.tools.find((t) => t.id === "node-test")!;
  tool.timeoutMs = 600_000;
  const r2: RunReport = { ...r, runId: randomUUID() };
  const q2 = quarantineRepeatFailure({ manifest: m, report: r2, history: m.runHistory });
  expect(q2).not.toBeNull();
  expect(q2!.changes["gates.unit.required"]).toBe(false);
});
