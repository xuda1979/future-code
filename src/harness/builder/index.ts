/**
 * Harness-builder — turns detected project cues into a customized,
 * project-specific harness manifest, and scaffolds the run bundle.
 * Adaptive/flexible: the harness shape follows the project, not a fixed template.
 */
import type { HarnessTool, HarnessGate, MonitorSlo, HarnessManifest } from "../types.ts";
import { detectCues, describeCues, type ProjectCues } from "./detect.ts";
import { SCHEMA, saveManifest, harnessDir } from "../registry.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function toolsFor(cues: ProjectCues, scope?: string): HarnessTool[] {
  const tools: HarnessTool[] = [{ id: "bash", description: "run a shell command", command: "bash" }];
  const scopeArg = scope ? ` ${scope}` : "";
  if (cues.testRunner === "bun-test") {
    tools.push({ id: "bun-test", description: "run the bun test suite", command: `bun test${scopeArg}`, cwd: "." });
  } else if (cues.testRunner === "node-test") {
    tools.push({ id: "node-test", description: "run the node test suite", command: `node --test${scopeArg}`, cwd: "." });
  } else if (cues.testRunner === "pytest") {
    tools.push({ id: "pytest", description: "run the pytest suite", command: `pytest${scopeArg}`, cwd: "." });
  }
  return tools;
}

function gatesFor(cues: ProjectCues, scope?: string): HarnessGate[] {
  const gates: HarnessGate[] = [];
  const detail = scope ? ` (scoped: ${scope})` : "";
  if (cues.testRunner === "bun-test") {
    gates.push({ id: "unit", toolId: "bun-test", required: true, description: `bun unit tests pass${detail}` });
  } else if (cues.testRunner === "node-test") {
    gates.push({ id: "unit", toolId: "node-test", required: true, description: `node unit tests pass${detail}` });
  } else if (cues.testRunner === "pytest") {
    gates.push({ id: "unit", toolId: "pytest", required: true, description: `pytest unit tests pass${detail}` });
  }
  return gates;
}

function slosFor(cues: ProjectCues): MonitorSlo[] {
  return [
    { id: "pass-rate", description: "gates must pass", metric: "pass_rate", op: "gte", threshold: 1.0 },
    { id: "bounded-runtime", description: "run must finish quickly", metric: "runtime_ms", op: "lte", threshold: 60_000 },
    { id: "bounded-context", description: "agents must stay within context budget", metric: "context_used", op: "lte", threshold: 4096 },
  ];
}

/** Generate and persist a customized harness manifest for a target project. */
export function build(projectRoot: string, options: { harnessId?: string; scope?: string } = {}): {
  manifest: HarnessManifest;
  cues: ProjectCues;
} {
  const cues = detectCues(projectRoot);
  const now = new Date().toISOString();
  const manifest: HarnessManifest = {
    schema: SCHEMA,
    harnessId: options.harnessId ?? `harness-${cues.name}`,
    project: projectRoot,
    createdAt: now,
    tools: toolsFor(cues, options.scope),
    gates: gatesFor(cues, options.scope),
    slos: slosFor(cues),
    config: {
      maxParallel: 1,
      contextBudget: 1,
      improvementPolicy: {
        cost_per_run_threshold_usd: 0.0,
        slow_gate_seconds: 15,
      },
    },
    improvementHistory: [],
    runHistory: [],
  };
  saveManifest(projectRoot, manifest);
  scaffoldBundle(projectRoot, manifest);
  return { manifest, cues };
}

/** Write a placeholder run bundle alongside the manifest. */
function scaffoldBundle(projectRoot: string, m: HarnessManifest): void {
  const dir = join(harnessDir(projectRoot), "dist");
  mkdirSync(dir, { recursive: true });
  const src = `export default ${JSON.stringify({ harnessId: m.harnessId, gates: m.gates.map((g) => g.id) }, null, 2)};\n`;
  writeFileSync(join(dir, "index.js"), src, "utf8");
}

export { detectCues, describeCues, type ProjectCues };
