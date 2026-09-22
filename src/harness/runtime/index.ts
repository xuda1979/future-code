/**
 * Harness runtime — the platform executes a project harness: it runs the
 * harness's gates through its tools, records per-run metrics, and returns
 * a structured RunReport. The harness "lives" on this runtime.
 *
 * All agents use bounded context — the runtime truncates task descriptions
 * and gate outputs to fit within the manifest's contextBudget.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HarnessManifest, RunReport, RunResult, MetricSample } from "../types.ts";
import { resolveBudget, truncateToBudget, estimateTokens, boundedTaskContext } from "../context.ts";

export interface ExecOutcome {
  exitCode: number;
  durationMs: number;
  output: string;
  /** True when the process was killed for exceeding its timeout. */
  timedOut?: boolean;
}

/** Execute a command string in a cwd and return code/time; used for real gates. */
export function execTool(command: string, cwd: string, timeoutMs = 60_000): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, durationMs: Date.now() - start, output: out, timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: -1, durationMs: Date.now() - start, output: "spawn error; tool command may not exist" });
    });
  });
}

/** Run a single gate using its tool's command. Output is truncated to budget. */
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
  const { exitCode, durationMs, output, timedOut } = await execTool(cmd, cwd, tool.timeoutMs ?? 60_000);
  const expected = gate.expectExit ?? 0;
  const passed = exitCode === expected;

  // Enforce context budget on gate output — no agent gets unbounded output
  const budget = resolveBudget(manifest);
  const gateOutputBudget = Math.floor(budget * 0.1); // 10% of budget per gate
  const truncatedOutput = truncateToBudget(output, gateOutputBudget);

  return {
    toolId: tool.id,
    gateId: gate.id,
    passed,
    exitCode,
    durationMs,
    required: gate.required ?? true,
    timedOut,
    output: timedOut
      ? `${truncatedOutput}\n[harness] gate exceeded timeout of ${tool.timeoutMs ?? 60_000}ms and was killed`
      : truncatedOutput,
  };
}

/** Run all required gates for a task and assemble a RunReport. */
export async function run(manifest: HarnessManifest, task: string): Promise<RunReport> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const maxParallel = manifest.config.maxParallel || 1;

  // Enforce context budget on the task description — no agent gets unbounded task text
  const boundedTask = boundedTaskContext(task, manifest);

  const gateIds = manifest.gates.map((g) => g.id);
  const gates: RunResult[] = [];
  // Execute gates with bounded parallelism
  for (let i = 0; i < gateIds.length; i += maxParallel) {
    const batch = gateIds.slice(i, i + maxParallel);
    const results = await Promise.all(batch.map((id) => runGate(manifest, id)));
    gates.push(...results);
  }
  const durationMs = Date.now() - t0;
  const passedCount = gates.filter((g) => g.passed).length;
  const passRate = gates.length ? passedCount / gates.length : 0;
  // Required-gate pass rate: advisory gates (required: false) don't drag
  // health down — they surface signal without blocking the run.
  const requiredGates = gates.filter((g) => g.required !== false);
  const requiredPassed = requiredGates.filter((g) => g.passed).length;
  const requiredPassRate = requiredGates.length ? requiredPassed / requiredGates.length : 1;
  // Timeout observability: count gates killed for exceeding their timeout so
  // improver rules can distinguish hangs from ordinary failures.
  const timeoutCount = gates.filter((g) => g.timedOut).length;
  const metrics: Record<string, number> = {
    pass_rate: passRate,
    required_pass_rate: requiredPassRate,
    timeout_count: timeoutCount,
    runtime_ms: durationMs,
    gate_count: gates.length,
    context_budget: resolveBudget(manifest),
    context_used: estimateTokens(boundedTask),
  };
  return { runId, task: boundedTask, startedAt, durationMs, gates, metrics, sloResults: [] };
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
