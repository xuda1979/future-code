/**
 * Tests for harness evidence revalidation — fresh/flipped/missing
 * classification, report persistence, gate re-run semantics, and the
 * `harness revalidate` CLI surface.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../src/harness/builder/index.ts";
import { revalidate, revalidateGates, classifyRun, loadReport, revalidationReportPath, REVALIDATION_REPORT_NAME } from "../../src/harness/evidence/index.ts";
import { recordRun } from "../../src/harness/history.ts";
import { loadManifest, saveManifest } from "../../src/harness/registry.ts";
import type { HarnessRunRecord, GateRevalidation, HarnessManifest, RunReport } from "../../src/harness/types.ts";
import { run } from "../../src/harness/runtime/index.ts";
import { annotate } from "../../src/harness/monitor/index.ts";

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-ev-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

/** Minimal project: a shell gate that passes or fails via a marker file. */
function shellProject(): string {
  return tempProject({
    "marker.txt": "ok\n",
    "check.sh": `#!/bin/sh
if [ -f marker.txt ]; then exit 0; else exit 1; fi
`,
  });
}

/** Build a manifest on the temp project and swap in a deterministic gate. */
function installGate(projectRoot: string, command: string): HarnessManifest {
  build(projectRoot, { harnessId: "ev-test" });
  const m = loadManifest(projectRoot);
  m.tools = [{ id: "shell", description: "shell tool", command: "sh", cwd: ".", timeoutMs: 10_000 }];
  m.gates = [{ id: "gate-a", toolId: "shell", required: true, description: "marker file exists", expectExit: 0 }];
  saveManifest(projectRoot, m);
  // The tool command runs in the project root: override to run check.sh.
  m.tools = [{ id: "shell", description: "shell tool", command, cwd: ".", timeoutMs: 10_000 }];
  saveManifest(projectRoot, m);
  return loadManifest(projectRoot);
}

function makeRunRecord(gateResults: Record<string, boolean>, runId = crypto.randomUUID()): HarnessRunRecord {
  return {
    runId,
    task: "ev-test-run",
    startedAt: new Date().toISOString(),
    durationMs: 10,
    passRate: Object.values(gateResults).every(Boolean) ? 1 : 0,
    healthy: Object.values(gateResults).every(Boolean),
    gateCount: Object.keys(gateResults).length,
    passedCount: Object.values(gateResults).filter(Boolean).length,
    metrics: {},
    unmetSlo: [],
    gateResults,
  };
}

function gateReval(gateId: string, passedNow: boolean): GateRevalidation {
  return { gateId, passedNow, exitCodeNow: passedNow ? 0 : 1, durationMsNow: 5, required: true };
}

test("classifyRun: fresh when recorded gates still pass", () => {
  const rec = makeRunRecord({ "gate-a": true });
  const m = { gates: [{ id: "gate-a", toolId: "shell", required: true, description: "" }] } as unknown as HarnessManifest;
  const out = classifyRun(rec, [gateReval("gate-a", true)], m);
  expect(out.outcome).toBe("fresh");
  expect(out.changed).toEqual([]);
});

test("classifyRun: flipped when a passing gate now fails", () => {
  const rec = makeRunRecord({ "gate-a": true });
  const m = { gates: [{ id: "gate-a", toolId: "shell", required: true, description: "" }] } as unknown as HarnessManifest;
  const out = classifyRun(rec, [gateReval("gate-a", false)], m);
  expect(out.outcome).toBe("flipped");
  expect(out.changed).toEqual(["gate-a"]);
});

test("classifyRun: missing when the recorded gate is gone from the manifest", () => {
  const rec = makeRunRecord({ "gate-z": true });
  const m = { gates: [] } as unknown as HarnessManifest;
  const out = classifyRun(rec, [], m);
  expect(out.outcome).toBe("missing");
  expect(out.changed).toEqual(["gate-z"]);
});

test("classifyRun: previously-failing gate that fails now stays fresh (no false stale)", () => {
  const rec = makeRunRecord({ "gate-a": false, "gate-b": true });
  const m = { gates: [
    { id: "gate-a", toolId: "shell", required: false, description: "" },
    { id: "gate-b", toolId: "shell", required: true, description: "" },
  ] } as unknown as HarnessManifest;
  const out = classifyRun(rec, [gateReval("gate-a", false), gateReval("gate-b", true)], m);
  expect(out.outcome).toBe("fresh");
});

test("revalidateGates: re-runs manifest gates and reports pass/fail", async () => {
  const dir = shellProject();
  const m = installGate(dir, "sh check.sh");
  const gates = await revalidateGates(m);
  expect(gates.length).toBe(1);
  expect(gates[0].gateId).toBe("gate-a");
  expect(gates[0].passedNow).toBe(true);
  expect(gates[0].exitCodeNow).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("revalidateGates: broken tool is a failed gate, not a crash", async () => {
  const dir = shellProject();
  const m = installGate(dir, "definitely-not-a-command-xyz");
  const gates = await revalidateGates(m);
  expect(gates[0].passedNow).toBe(false);
  expect(gates[0].exitCodeNow).not.toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("revalidate: end-to-end fresh report is persisted", async () => {
  const dir = shellProject();
  const m = installGate(dir, "sh check.sh");

  // Record one real run so runHistory has genuine evidence.
  const report = await run(m, "baseline");
  annotate(m, report);
  recordRun(dir, report);

  const rv = await revalidate(dir);
  expect(rv.summary.gatesTotal).toBe(1);
  expect(rv.summary.gatesPassedNow).toBe(1);
  expect(rv.summary.runsExamined).toBe(1);
  expect(rv.summary.runsFresh).toBe(1);
  expect(rv.summary.runsFlipped).toBe(0);
  expect(rv.summary.evidenceStale).toBe(false);

  // Report persisted at the documented path and loadable.
  expect(() => readFileSync(revalidationReportPath(dir), "utf8")).not.toThrow();
  const loaded = loadReport(dir);
  expect(loaded).not.toBeNull();
  expect(loaded!.summary.runsFresh).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("revalidate: deleting the file the gate checks flips evidence stale", async () => {
  const dir = shellProject();
  const m = installGate(dir, "sh check.sh");

  const report = await run(m, "baseline");
  annotate(m, report);
  recordRun(dir, report);

  // Evidence says gate-a passed. Now remove what it checks.
  rmSync(join(dir, "marker.txt"));
  const rv = await revalidate(dir);

  expect(rv.summary.gatesPassedNow).toBe(0);
  expect(rv.summary.runsExamined).toBe(1);
  expect(rv.summary.runsFlipped).toBe(1);
  expect(rv.summary.runsFresh).toBe(0);
  expect(rv.summary.evidenceStale).toBe(true);
  expect(rv.runs[0].changedGates).toEqual(["gate-a"]);
  rmSync(dir, { recursive: true, force: true });
});

test("revalidate: removing a gate from the manifest makes old evidence missing", async () => {
  const dir = shellProject();
  const m = installGate(dir, "sh check.sh");

  const report = await run(m, "baseline");
  annotate(m, report);
  recordRun(dir, report);

  // Drop the gate entirely — the recorded evidence can no longer be verified.
  const m2 = loadManifest(dir);
  m2.gates = [];
  saveManifest(dir, m2);

  const rv = await revalidate(dir);
  expect(rv.summary.gatesTotal).toBe(0);
  expect(rv.summary.runsMissing).toBe(1);
  expect(rv.summary.evidenceStale).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("revalidate: limit bounds how many run records are examined", async () => {
  const dir = shellProject();
  const m = installGate(dir, "sh check.sh");

  for (let i = 0; i < 5; i++) {
    const report = await run(m, `run-${i}`);
    annotate(m, report);
    recordRun(dir, report);
  }

  const rv = await revalidate(dir, { limit: 3 });
  expect(rv.summary.runsExamined).toBe(3);
  rmSync(dir, { recursive: true, force: true });
});

test("loadReport: null when no report exists yet", () => {
  const dir = tempProject({ "x.txt": "x" });
  expect(loadReport(dir)).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("report file name is stable", () => {
  expect(REVALIDATION_REPORT_NAME).toBe("revalidation.json");
});

test("CLI: harness revalidate emits a JSON report on stdout", async () => {
  const dir = shellProject();
  installGate(dir, "sh check.sh");

  const proc = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "../../src/harness/cli.ts"), "revalidate", "--project", dir],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const out = JSON.parse(proc.stdout.toString());
  expect(out.evidenceStale).toBe(false);
  expect(out.summary.gatesTotal).toBe(1);
  expect(out.summary.gatesPassedNow).toBe(1);
  expect(typeof out.reportPath).toBe("string");
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: harness revalidate --last surfaces the persisted report without re-running", async () => {
  const dir = shellProject();
  installGate(dir, "sh check.sh");

  const first = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "../../src/harness/cli.ts"), "revalidate", "--project", dir],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  expect(first.exitCode).toBe(0);

  // Make gates fail after the fact — --last must NOT re-run, so the stale
  // report's summary must still reflect the passing state.
  rmSync(join(dir, "marker.txt"));
  const second = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "../../src/harness/cli.ts"), "revalidate", "--last", "--project", dir],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const out = JSON.parse(second.stdout.toString());
  expect(out.report).not.toBeNull();
  expect(out.report.summary.gatesPassedNow).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});
