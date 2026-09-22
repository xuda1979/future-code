/**
 * End-to-end tests for the harness CLI — spawn each subcommand as a
 * subprocess against a temp project and assert on its JSON output.
 *
 * Covers: build | run | monitor | improve | selfapply | log | context,
 * plus the shouldApply guardrail wiring (vetoed proposals never mutate
 * the manifest).
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessManifest } from "../../src/harness/types.ts";

const CLI = join(import.meta.dir, "../../src/harness/cli.ts");

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-cli-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: any;
}

async function cli(args: string[]): Promise<CliResult> {
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  let json: any = null;
  try {
    // CLI prints one JSON object per improvement; parse the first block.
    const m = stdout.match(/^\{[\s\S]*?\n\}/m);
    if (m) json = JSON.parse(m[0]);
  } catch {
    /* non-JSON output (e.g. help) */
  }
  return { exitCode: proc.exitCode, stdout, stderr, json };
}

function readManifest(dir: string): HarnessManifest {
  return JSON.parse(readFileSync(join(dir, ".future-code/harness/harness.json"), "utf8"));
}

function writeManifest(dir: string, m: HarnessManifest): void {
  writeFileSync(join(dir, ".future-code/harness/harness.json"), JSON.stringify(m, null, 2));
}

test("cli build scaffolds a harness manifest", async () => {
  const dir = tempProject({ "package.json": JSON.stringify({ name: "cli-build" }) });
  const r = await cli(["build", "--project", dir]);
  expect(r.exitCode).toBe(0);
  expect(r.json.built).toBe(true);
  expect(r.json.cues).toBeDefined();
  const m = readManifest(dir);
  expect(m.schema).toBe(1);
  expect(m.gates.length).toBeGreaterThan(0);
});

test("cli build with --scope stores the scope", async () => {
  const dir = tempProject({ "package.json": JSON.stringify({ name: "cli-scope" }) });
  const r = await cli(["build", "--project", dir, "--scope", "tests"]);
  expect(r.exitCode).toBe(0);
  expect(r.json.scope).toBe("tests");
});

test("cli run executes gates and reports health", async () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "cli-run", scripts: { test: "exit 0" } }),
  });
  await cli(["build", "--project", dir]);
  const r = await cli(["run", "--project", dir]);
  expect(r.exitCode).toBe(0);
  // `run` prints summary(r): runId, healthy, passRate, runtimeMs, unmetSlo.
  expect(r.json.healthy).toBe(true);
  expect(r.json.passRate).toBe(1);
  expect(r.json.unmetSlo).toEqual([]);
});

test("cli run on a failing project reports unhealthy", async () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "cli-fail", scripts: { test: "exit 1" } }),
  });
  await cli(["build", "--project", dir]);
  const r = await cli(["run", "--project", dir]);
  expect(r.json.healthy).toBe(false);
  expect(r.json.passRate).toBe(0);
});

test("cli monitor records a run into history", async () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "cli-mon", scripts: { test: "exit 0" } }),
  });
  await cli(["build", "--project", dir]);
  const r = await cli(["monitor", "--project", dir]);
  expect(r.exitCode).toBe(0);
  const m = readManifest(dir);
  expect(m.runHistory.length).toBe(1);
});

test("cli improve on a healthy project applies no changes", async () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "cli-imp", scripts: { test: "exit 0" } }),
  });
  await cli(["build", "--project", dir]);
  const r = await cli(["improve", "--project", dir]);
  expect(r.exitCode).toBe(0);
  // Healthy + fast run → reduceParallelism may fire if maxParallel > 1; with
  // the default maxParallel=1 there is nothing to reduce.
  const m = readManifest(dir);
  expect(m.improvementHistory ?? []).toEqual([]);
});

test("cli selfapply on a failing project converges via quarantine", async () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "cli-self", scripts: { test: "exit 1" } }),
  });
  const r = await cli(["selfapply", "--project", dir]);
  expect(r.exitCode).toBe(0);
  // The loop iterates to convergence: the broken gate fails 3 consecutive
  // runs, quarantine demotes it to advisory, and the harness reaches a
  // self-consistent healthy state (no required gate failing).
  expect(r.json.converged).toBe(true);
  expect(r.json.iterations).toBeGreaterThanOrEqual(3);
  const m = readManifest(dir);
  const unit = m.gates.find((g) => g.id === "unit")!;
  expect(unit.required).toBe(false); // quarantined
  expect((m.improvementHistory ?? []).length).toBeGreaterThan(0);
  const quarantine = (m.improvementHistory ?? []).find((p) =>
    Object.keys(p.changes).some((k) => k === "gates.unit.required"));
  expect(quarantine).toBeDefined();
});

test("cli log exposes history and improvement decisions", async () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "cli-log", scripts: { test: "exit 0" } }),
  });
  await cli(["build", "--project", dir]);
  await cli(["monitor", "--project", dir]);
  const r = await cli(["log", "--project", dir]);
  expect(r.exitCode).toBe(0);
  expect(r.json.recentRuns.length).toBe(1);
  expect(r.json.improvementHistory).toBeDefined();
});

test("cli context reports per-agent budget compliance", async () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "cli-ctx", scripts: { test: "exit 0" } }),
  });
  await cli(["build", "--project", dir]);
  const r = await cli(["context", "--project", dir]);
  expect(r.exitCode).toBe(0);
  expect(r.json.budget).toBeGreaterThan(0);
  expect(Array.isArray(r.json.agents)).toBe(true);
});

test("cli improve applies a safe reduceParallelism proposal end-to-end", async () => {
  // A fast, healthy run with maxParallel=4 makes reduceParallelism propose
  // 4→3 — a safe change that must pass the shouldApply guardrail and be
  // applied, with the decision recorded in improvementHistory.
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "cli-apply", scripts: { test: "exit 0" } }),
  });
  await cli(["build", "--project", dir]);
  const m = readManifest(dir);
  m.config.maxParallel = 4;
  writeManifest(dir, m);

  const r = await cli(["improve", "--project", dir]);
  expect(r.exitCode).toBe(0);
  const m3 = readManifest(dir);
  expect(m3.config.maxParallel).toBe(3);
  expect((m3.improvementHistory ?? []).length).toBe(1);
  expect(m3.improvementHistory![0].changes["config.maxParallel"]).toBe(3);
});

test("cli guardrail: shouldApply vetoes proposals beyond the maxParallel cap", async () => {
  // The cap in shouldApply (>4 vetoed) is defense-in-depth: adaptParallelism
  // itself never proposes past 4 (its slow-condition requires maxParallel<4),
  // so the veto protects against future rules and hand-made proposals.
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "cli-veto", scripts: { test: "exit 0" } }),
  });
  await cli(["build", "--project", dir]);
  const { shouldApply } = await import("../../src/harness/improver/index.ts");
  const m = readManifest(dir);
  const unsafe = {
    id: "imp-unsafe-1",
    description: "grow parallelism beyond cap",
    changes: { "config.maxParallel": 5 },
    rationale: "test",
    approved: false,
  };
  expect(shouldApply(m, unsafe as any)).toBe(false);
  const atCap = { ...unsafe, changes: { "config.maxParallel": 4 } };
  expect(shouldApply(m, atCap as any)).toBe(true);
});

test("cli selfapply on a healthy project converges in one iteration", async () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "cli-healthy", scripts: { test: "exit 0" } }),
  });
  const r = await cli(["selfapply", "--project", dir]);
  expect(r.exitCode).toBe(0);
  expect(r.json.converged).toBe(true);
  expect(r.json.iterations).toBe(1);
  expect(r.json.healthy).toBe(true);
});

test("cli selfapply stops at no-progress instead of re-running an identical config", async () => {
  // The loop's no-progress bound: an unmet SLO that no rule can address.
  // A healthy, fast project with a bounded-runtime SLO threshold set
  // absurdly low (1ms) fails the SLO every run, but no improver rule
  // touches runtime SLOs for non-hanging runs — improve() proposes nothing
  // applicable, and the loop must stop after its first (unchanged) re-run
  // rather than re-running the identical configuration forever.
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "cli-bound", scripts: { test: "exit 0" } }),
  });
  await cli(["build", "--project", dir]);
  const m = readManifest(dir);
  m.slos.find((s) => s.id === "bounded-runtime")!.threshold = 1; // unmeetable
  m.config.contextBudget = 8; // context already at cap — nothing to widen
  writeManifest(dir, m);
  const r = await cli(["selfapply", "--project", dir]);
  expect(r.exitCode).toBe(0);
  expect(r.json.converged).toBe(false);
  expect(r.json.iterations).toBeLessThanOrEqual(2);
  const m2 = readManifest(dir);
  // The terminal state is surfaced, and no rules spun on it.
  const final = m2.slos.find((s) => s.id === "bounded-runtime")!;
  expect(final.threshold).toBe(1); // untouched — no rule addresses it
}, 60_000);
