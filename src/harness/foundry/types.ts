/** A bounded, single-host harness lifecycle. The contract is not optimizer state. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Verdict = "PASS" | "FAIL" | "UNKNOWN" | "INVALID";
export type Metric = "durationMs" | "tokens" | "costUsd" | "progressDensity";
export interface Contract {
  schema: 1;
  name: string;
  verifierId: string;
  workerId: string;
  environmentId: string;
  requiredChecks: string[];
  slos: { metric: Metric; maximum?: number; minimum?: number }[];
  limits: {
    parallelism: number;
    attempts: number;
    contextBytes: number;
    outputBytes: number;
    timeoutMs: number;
    tasks: number;
  };
}
export interface Recipe {
  parallelism: number;
  attempts: number;
  contextBytes: number;
  timeoutMs: number;
  /** Fraction of contextBytes reserved for high-priority tasks (0–1).
   *  0 means equal allocation; 0.7 means top-priority tasks get 70% of
   *  the context budget. Defaults to 0 (equal allocation). */
  priorityContextShare?: number;
  /** Explicit opt-in: old recipe hashes retain priority-first scheduling. */
  scheduling?: "priority" | "critical-path";
  /** Sum of reserved capsule budgets, not provider token usage or RAM. */
  maxInFlightContextBytes?: number;
  /** Idle deadline for adapters that report distinct progress fingerprints. */
  noProgressMs?: number;
  /** Stop consecutive identical failures; different artifacts remain eligible. */
  maxRepeatedFailures?: number;
}
export interface Task {
  id: string;
  goal: string;
  acceptance: string[];
  dependencies: string[];
  /** Logical write-scope locks, not an OS filesystem sandbox. */
  writeScope: string[];
  input: Json;
  priority?: number;
  /** Per-task context budget override (bytes). When omitted, the scheduler
   *  allocates from recipe.contextBytes based on relative priority. */
  contextBudget?: number;
  /** Advisory estimate for critical-path ordering, never an execution deadline. */
  estimatedDurationMs?: number;
  /** Optional logical read locks. Concurrent readers are allowed. */
  readScope?: string[];
  /** Explicit RFC 6901 projections of direct, verified dependency artifacts.
   *  Omitted dependencies retain their full output. No automatic truncation. */
  dependencyViews?: Record<string, string[]>;
}
export interface Capsule {
  schema: 1;
  runId: string;
  task: Task;
  contractHash: string;
  recipeHash: string;
  fence: number;
  /** Content-addressed, verified outputs. No accumulated conversation history. */
  dependencies: {
    taskId: string;
    /** Always the hash of the FULL source artifact, even for a view. */
    artifactHash: string;
    artifact: Json;
    /** A projected artifact is a JSON-pointer-to-value map, not the full source. */
    view?: { pointers: string[]; hash: string };
  }[];
}
export interface Measurement {
  /** Only the trusted host adapter may fill these; never trust model JSON usage. */
  tokens: number | null;
  costUsd: number | null;
}
export interface WorkerResult {
  artifact: Json;
  measurement?: Measurement;
}
export interface Check { id: string; verdict: Verdict; detail?: string }
export interface Verification {
  artifactHash: string;
  checks: Check[];
  measurement?: Measurement;
}
export interface AttemptControl {
  /** Host/adapter observation, NOT correctness evidence. Repeats do not renew
   *  the idle deadline. The hard lease deadline is never extended. */
  progress(fingerprint: string): void;
}
export interface FailureOptions {
  retryable?: boolean;
  fingerprint?: string;
}
export interface Driver {
  verifierId: string;
  workerId: string;
  /** Honor cancellation. The command adapter kills the child's process group. */
  execute(capsule: Capsule, signal: AbortSignal, control?: AttemptControl): Promise<WorkerResult>;
  verify(capsule: Capsule, result: WorkerResult, signal: AbortSignal, control?: AttemptControl): Promise<Verification>;
}
export interface Lease {
  runId: string;
  taskId: string;
  owner: string;
  fence: number;
  deadline: number;
  recipeHash: string;
  contractHash: string;
}
export interface RunSummary {
  id: string;
  recipeHash: string;
  contractHash: string;
  status: "RUNNING" | "PASS" | "FAIL";
  accepted: number;
  failed: number;
  blocked: number;
  attempts: number;
  durationMs: number;
  tokens: number | null;
  costUsd: number | null;
  /** Verified accepted tasks per total context bytes consumed.
   *  Higher is better: measures progress density, not raw activity. */
  progressDensity: number | null;
}
export interface Protocol {
  datasetId: string;
  environmentId: string;
  tasks: Task[];
  repetitions: number;
  objective: Metric;
  minRelativeGain: number;
}
export interface Evaluation {
  id: string;
  contractHash: string;
  baselineHash: string;
  candidateHash: string;
  protocol: Protocol;
  protocolHash: string;
  pairs: { baseline: RunSummary; candidate: RunSummary }[];
  decision: "ADMIT" | "REJECT" | "UNKNOWN";
  reasons: string[];
  relativeGain: number | null;
}
export interface CommandSpec {
  argv: string[];
  /** Explicit environment capabilities; all others are withheld. */
  envAllow?: string[];
  /** All declared verifier/worker implementation files are pinned at init. */
  files?: string[];
}
export interface PinnedCommand extends CommandSpec {
  argv: string[];
  pins: { path: string; hash: string }[];
}
