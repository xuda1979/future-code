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
    // Prefer the project's own test script when it declares one — the script
    // is the project's definition of "run my tests", and a bare `node --test`
    // on a project without node:test files exits 0 with zero tests run (a
    // false-pass the gate must never report).
    const command = cues.testScript ? `npm run test${scopeArg}` : `node --test${scopeArg}`;
    tools.push({ id: "node-test", description: "run the node test suite", command, cwd: "." });
  } else if (cues.testRunner === "pytest") {
    tools.push({ id: "pytest", description: "run the pytest suite", command: `pytest${scopeArg}`, cwd: "." });
  } else if (cues.testRunner === "go-test") {
    tools.push({ id: "go-test", description: "run the go test suite", command: `go test ./...${scopeArg}`, cwd: "." });
  } else if (cues.testRunner === "cargo-test") {
    tools.push({ id: "cargo-test", description: "run the cargo test suite", command: `cargo test${scopeArg}`, cwd: "." });
  }
  // Typecheck tool for TypeScript projects — only when tsc is locally
  // resolvable, so the gate never hangs fetching packages over the network.
  if (cues.hasTsConfig && cues.hasLocalTypescript) {
    tools.push({ id: "typecheck", description: "run the TypeScript typechecker", command: "bunx tsc --noEmit", cwd: "." });
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
  } else if (cues.testRunner === "go-test") {
    gates.push({ id: "unit", toolId: "go-test", required: true, description: `go unit tests pass${detail}` });
  } else if (cues.testRunner === "cargo-test") {
    gates.push({ id: "unit", toolId: "cargo-test", required: true, description: `cargo unit tests pass${detail}` });
  }
  // Typecheck gate for TypeScript projects — catches a class of bugs the
  // unit gate can't (type errors that only surface under tsc). Advisory:
  // it surfaces signal without blocking, and is promoted to required by
  // the improver once it has proven stable.
  if (cues.hasTsConfig && cues.hasLocalTypescript) {
    gates.push({ id: "typecheck", toolId: "typecheck", required: false, description: "tsc --noEmit passes (no type errors)" });
  }
  return gates;
}

function slosFor(cues: ProjectCues): MonitorSlo[] {
  return [
    { id: "pass-rate", description: "required gates must pass", metric: "required_pass_rate", op: "gte", threshold: 1.0 },
    { id: "bounded-runtime", description: "run must finish quickly", metric: "runtime_ms", op: "lte", threshold: 60_000 },
    { id: "bounded-context", description: "agents must stay within the effective context budget", metric: "context_utilization", op: "lte", threshold: 1.0 },
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
