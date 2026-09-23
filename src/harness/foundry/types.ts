/** A bounded, single-host harness lifecycle. The contract is not optimizer state. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Verdict = "PASS" | "FAIL" | "UNKNOWN" | "INVALID";
export type Metric = "durationMs" | "tokens" | "costUsd";
export interface Contract {
  schema: 1;
  name: string;
  verifierId: string;
  workerId: string;
  environmentId: string;
  requiredChecks: string[];
  slos: { metric: Metric; maximum: number }[];
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
}
export interface Capsule {
  schema: 1;
  runId: string;
  task: Task;
  contractHash: string;
  recipeHash: string;
  fence: number;
  /** Content-addressed, verified outputs. No accumulated conversation history. */
  dependencies: { taskId: string; artifactHash: string; artifact: Json }[];
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
export interface Driver {
  verifierId: string;
  workerId: string;
  /** Honor cancellation. The command adapter kills the child's process group. */
  execute(capsule: Capsule, signal: AbortSignal): Promise<WorkerResult>;
  verify(capsule: Capsule, result: WorkerResult, signal: AbortSignal): Promise<Verification>;
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
