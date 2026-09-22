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
    /**
     * Directory (relative to project root) that bounds the scribe's
     * write-phase: only modules under this root are scaffolded, and
     * scaffolds are only written into it or its test mirror. Empty or
     * undefined means the whole project (minus ignored dirs). Set by the
     * builder from the harness scope so the write-phase stays inside the
     * platform's own module boundary.
     */
    scribeRoot?: string;
  };
  /** History of improver decisions. */
  improvementHistory: ImprovementProposal[];
  /** Persisted run records, newest last, for self-monitoring + improver. */
  runHistory: HarnessRunRecord[];
  /** Bounded audit trail of scribe (code-writing) actions. Optional for older manifests. */
  scribeLog?: ScribeAction[];
}

/** Interface every harness runtime loop must implement. */
export interface HarnessRuntime {
  run(task: string, manifest: HarnessManifest): Promise<RunReport>;
}

/** One scribe (code-writing) action, for the audit trail. */
export interface ScribeAction {
  id: string;
  /** What the scribe did: "plan" | "write" | "promote" | "quarantine" | "skip". */
  kind: "plan" | "write" | "promote" | "quarantine" | "skip";
  /** Target module path (relative to project root). */
  target: string;
  /** Path of the written/staged file, relative to project root. */
  file?: string;
  /** Human-readable rationale, always recorded. */
  rationale: string;
  at: string;
}

/** A scribe plan: which modules deserve scaffold tests, and why. */
export interface ScribePlanEntry {
  /** Source module path, relative to project root. */
  module: string;
  /** Test file path the scribe would write (in the staging dir). */
  testFile: string;
  /** Why this module was selected (untested, stale, etc). */
  reason: "untested" | "stale";
  /** Exported symbols detected in the module. */
  exports: string[];
}

/** Result of one scribe planning pass. */
export interface ScribePlan {
  /** Modules selected for scaffold-writing, in priority order. */
  entries: ScribePlanEntry[];
  /** Modules the scribe will not touch (already covered), for transparency. */
  skipped: { module: string; reason: string }[];
  /** Bounded planning context the scribe agent "saw". */
  context: string;
  /** Token estimate of the planning context. */
  contextTokens: number;
}

/** Result of scribing (writing + validating) one plan entry. */
export interface ScribeResult {
  entry: ScribePlanEntry;
  /** Outcome of writing + validating the scaffold. */
  outcome: "promoted" | "quarantined" | "skipped";
  /** Path of the final file (staged or promoted), relative to root. */
  file: string;
  /** Validation command output (bounded), when run. */
  output?: string;
  /** Exit code of the validation run. */
  exitCode?: number;
  /** True when the validation process was killed for exceeding its timeout. */
  timedOut?: boolean;
}
