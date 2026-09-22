/**
 * Harness runtime — the platform executes a project harness: it runs the
 * harness's gates through its tools, records per-run metrics, and returns
 * a structured RunReport. The harness "lives" on this runtime.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HarnessManifest, RunReport, RunResult, MetricSample } from "../types.ts";

export interface ExecOutcome {
  exitCode: number;
  durationMs: number;
  output: string;
}

/** Execute a command string in a cwd and return code/time; used for real gates. */
export function execTool(command: string, cwd: string, timeoutMs = 60_000): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, durationMs: Date.now() - start, output: out });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: -1, durationMs: Date.now() - start, output: "spawn error; tool command may not exist" });
    });
  });
}

/** Run a single gate using its tool's command. */
export async function runGate(
  manifest: HarnessManifest,
  gateId: string,
  extra: string[] = [],
): Promise<RunResult> {
  const gate = manifest.gates.find((g) => g.id === gateId);
  if (!gate) throw new Error(`unknown gate ${gateId}`);
  const tool = manifest.tools.find((t) => t.id === gate.toolId);
  if (!tool) throw new Error(`unknown tool ${gate.toolId}`);
  const cwd = tool.cwd ? `${manifest.project}/${tool.cwd}` : manifest.project;
  const cmd = [tool.command, ...extra].join(" ");
  const { exitCode, durationMs, output } = await execTool(cmd, cwd, tool.timeoutMs ?? 60_000);
  const expected = gate.expectExit ?? 0;
  const passed = exitCode === expected;
  return { toolId: tool.id, gateId: gate.id, passed, exitCode, durationMs, output };
}

/** Run all required gates for a task and assemble a RunReport. */
export async function run(manifest: HarnessManifest, task: string): Promise<RunReport> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const gates = await Promise.all(manifest.gates.map((g) => runGate(manifest, g.id)));
  const durationMs = Date.now() - t0;
  const passedCount = gates.filter((g) => g.passed).length;
  const passRate = gates.length ? passedCount / gates.length : 0;
  const metrics: Record<string, number> = {
    pass_rate: passRate,
    runtime_ms: durationMs,
    gate_count: gates.length,
  };
  return { runId, task, startedAt, durationMs, gates, metrics, sloResults: [] };
}

/** Build stable MetricSamples from a report for the monitor/improver. */
export function toSamples(r: RunReport): MetricSample[] {
  return r.gates.map((g) => ({
    runId: r.runId,
    toolId: g.toolId,
    passed: g.passed,
    exitCode: g.exitCode,
    durationMs: g.durationMs,
  }));
}
