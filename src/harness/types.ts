/**
 * future-code agent-management platform — core types.
 *
 * These are the shared interfaces for the harness-builder, the harness
 * runtime, the self-monitor, and the self-improver.
 */

/** A single tool/gate the harness can execute against the target project. */
export interface HarnessTool {
  /** Machine id, e.g. "bash", "bun-test", "pytest", "file". */
  id: string;
  /** Human-readable description. */
  description: string;
  /** CLI/program invoked by the platform (may include args). */
  command: string;
  /** Working directory relative to the target project root, or "." */
  cwd?: string;
  /** Optional timeout in ms. */
  timeoutMs?: number;
  /** Optional allowlist of extra env vars. */
  env?: Record<string, string>;
}

/** An acceptance gate: one outcome criterion over a tool run. */
export interface HarnessGate {
  id: string;
  toolId: string;
  /** Expected exit code (default 0). */
  expectExit?: number;
  /** True (default) to require the tool exit to match. */
  required: boolean;
  description: string;
}

/** A self-monitor: an SLO that the harness evaluates each run. */
export interface MonitorSlo {
  id: string;
  description: string;
  /** E.g. "pass_rate", "cost_usd_per_run", "runtime_ms_max". */
  metric: string;
  /** Comparison operator: "gte" | "lte" | "lt" | "gt". */
  op: "gte" | "lte" | "lt" | "gt";
  /** Threshold value. */
  threshold: number;
}

/** One observed metric sample from a run. */
export interface MetricSample {
  runId: string;
  toolId: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  // reserved: optional HACT certificate evidence is a pluggable gate
  evidenceBytes?: number;
}

/** Result of running one tool/gate. */
export interface RunResult {
  toolId: string;
  gateId?: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  /** Whether this gate is required (advisory gates don't affect required_pass_rate). */
  required?: boolean;
  /** True when the gate's process was killed for exceeding its timeout. */
  timedOut?: boolean;
  output?: string;
  error?: string;
}

/** Result of one harness run across gates. */
export interface RunReport {
  runId: string;
  task: string;
  startedAt: string;
  durationMs: number;
  gates: RunResult[];
  metrics: Record<string, number>;
  sloResults: SloResult[];
}

export interface SloResult {
  sloId: string;
  met: boolean;
  observed: number;
  threshold: number;
  op: MonitorSlo["op"];
}

/** A proposed harness change from the improver. */
export interface ImprovementProposal {
  id: string;
  description: string;
  changes: Record<string, unknown>;
  rationale: string;
  approved: boolean;
  appliedAt?: string;
}

/** A persisted run record, kept for self-monitoring and iterl to learn from. */
export interface HarnessRunRecord {
  runId: string;
  task: string;
  startedAt: string;
  durationMs: number;
  passRate: number;
  healthy: boolean;
  gateCount: number;
  passedCount: number;
  metrics: Record<string, number>;
  unmetSlo: string[];
  /** Per-gate outcomes (gateId → passed) for repeat-failure analysis. */
  gateResults?: Record<string, boolean>;
}

/** The full harness manifest — the adaptive, persisted configuration. */
export interface HarnessManifest {
  schema: number;
  harnessId: string;
  project: string;
  createdAt: string;
  updatedAt?: string;
  tools: HarnessTool[];
  gates: HarnessGate[];
  slos: MonitorSlo[];
  /** Adaptive/self-improving configuration knobs. */
  config: {
    /** Max parallel tool executions. */
    maxParallel: number;
    /** Context budget hint (units are advisory). */
    contextBudget: number;
    /** Rules that drive the improver (keyed by metric). */
    improvementPolicy: Record<string, unknown>;
  };
  /** History of improver decisions. */
  improvementHistory: ImprovementProposal[];
  /** Persisted run records, newest last, for self-monitoring + improver. */
  runHistory: HarnessRunRecord[];
}

/** Interface every harness runtime loop must implement. */
export interface HarnessRuntime {
  run(task: string, manifest: HarnessManifest): Promise<RunReport>;
}
