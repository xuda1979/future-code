import { validateResearchStrategy, type ResearchStrategy } from "../researchStrategy.ts";
import { validateKnowledgePolicy, type KnowledgePolicy } from "./knowledge.ts";
import { validateKnowledgeRefs, type ProgrammePolicy } from "../researchProgramme.ts";
import { validateResearchConfiguration, type ResearchConfiguration, type PinnedScientificValidator } from "../researchValidation.ts";
import { existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { identifier, invariant, positive, validateContract, validateRecipe } from "../kernel.ts";
import type { CommandSpec, Contract, PinnedCommand, Recipe, SpawnPolicy, Task } from "../types.ts";
import { WORKFLOW_OPERATIONS, type WorkflowBounds } from "../workflow.ts";

export const TOOLS = ["list_files", "read_file", "search_files", "write_file", "edit_file", "delete_file", "run_check", "run_probe", "recall", "run_job", "read_job_artifact", "spawn_tasks", "save_progress", "propose_claim", "read_claims", "propose_conflict", "publish_finding", "read_findings", "record_experience", "read_knowledge"] as const;
export type ToolName = typeof TOOLS[number];
export type Protocol = "anthropic" | "chat-completions";
export interface ProviderRoute {
  url: string;
  model: string;
  keyEnv?: string;
  allowHttp?: boolean;
  quotaPool?: string;
}
export interface AgentProfile {
  /** Host-assigned research group; many task instances may use one profile. */
  cohort?: string;
  protocol: Protocol;
  url: string;
  model: string;
  keyEnv?: string;
  system: string;
  tools: ToolName[];
  checks: string[];
  /** Cheap permitted check used for autonomous evaluation; defaults to checks[0]. */
  checkpointCheck?: string;
  /** Permitted exploratory checks; never added to independent acceptance. */
  diagnostics?: string[];
  /** Host-observed measurement cadence, opt-in for sustained implementation. */
  decisionPolicy?: { maxUnmeasuredWriteTurns: number; measurementChecks: string[] };
  /** Exploratory capabilities, separate from independent acceptance checks. */
  probes?: string[];
  jobs?: string[];
  promptCache?: boolean;
  allowHttp?: boolean;
  /** Optional shared concurrency/rate-limit pool across model profiles. */
  quotaPool?: string;
  /** Same wire protocol, same tools/system, alternate external API routes. */
  fallbacks?: ProviderRoute[];
  /** Launch configured fallbacks if the primary has not completed by this latency. */
  hedgeAfterMs?: number;
}
export interface CheckSpec extends CommandSpec {
  replaySafe: boolean;
  /** Operator-pinned micro-probe process deadline; never model-controlled. */
  probeTimeoutMs?: number;
  /** Operator assertion: no prerequisite check, shared external state or resource
   * collision; can run against a private copy of the candidate Git tree. */
  parallelSafe?: boolean;
  /** Operator-asserted file/directory prefixes for *automatic exploratory*
   * checkpoints only. Never filters explicit checks or independent verification. */
  diagnosticPaths?: string[];
  /** Opt-in operator assertion: this diagnostic is deterministic on the pinned
   * source and completed job/feedback evidence. Repeated identical nonzero
   * outcomes may end the current trajectory; acceptance checks still run. */
  maxUnchangedFailures?: number;
}
export interface ExecutionWorker {
  /** Trusted coordinator-side adapter. It may wrap SSH/Kubernetes/etc. */
  adapter: CommandSpec;
  /** Coordinator-enforced number of simultaneously leased workspaces on this worker. */
  maxConcurrent: number;
  /** Aggregate JSON request/response ceiling for one worker RPC. */
  maxRpcBytes: number;
}
export interface SwarmBudget {
  maxRequests: number;
  maxRequestBytes: number;
  maxTurns: number;
  maxToolCalls: number;
  modelConcurrency: number;
  requestTimeoutMs: number;
  toolTimeoutMs: number;
  maxOutputTokens: number;
  maxToolOutputBytes: number;
  maxPatchBytes: number;
}
export interface JobTemplate {
  research?: ResearchConfiguration;
  adapter: CommandSpec;
  /** Optional submission gate: exact-source/evidence passing run_check receipts. */
  preflightChecks?: string[];
  /** Adapter ensure(key) must reconcile/deduplicate remotely, not blindly resubmit. */
  idempotentEnsure: true;
  pollMs: number; staleMs: number; maxJobs: number; maxConcurrent: number;
  /** Optional upper bound for exponential idle polling; omit for legacy fixed cadence. */
  maxPollMs?: number;
  /** Cumulative submissions allowed for this template across every run/replan of
   *  one supervised objective. Defaults to maxJobs so recovery cannot silently
   *  reset an expensive GPU/NPU/HPC experiment budget. */
  maxObjectiveJobs?: number;
  /** After this much time without a semantic milestone, stop automatic polling
   * and require explicit remote reconciliation. Defaults to 3 * staleMs. */
  reconcileAfterMs?: number;
}
export interface SupervisionPolicy {
  reportEveryMs: number;
  checkpointEveryMs: number;
  /** Optional dedupe of periodic exploratory checks when source is unchanged. */
  checkpointCadence?: "periodic" | "on-change";
  /** Also evaluate after this many model turns without the selected check. Default 4. */
  checkpointEveryTurns?: number;
  /** Evaluate newly completed job/child/verification evidence before another
   * model decision. Default true; independent acceptance is unchanged. */
  checkpointAfterEvidence?: boolean;
  snapshotReads?: boolean;
  /** Optional hard lifetime cap. Omit for persistent recovery under objective budgets; set 0 to disable autonomous replanning. */
  maxReplans?: number;
  /** Cumulative external-model request ceiling across every run/revision of one objective. */
  maxObjectiveRequests?: number;
  /** Cumulative encoded external-model request-byte ceiling across every run/revision of one objective. */
  maxObjectiveRequestBytes?: number;
  /** Minimum wait before re-evaluating a non-terminal recovery state. */
  recoveryBackoffMs?: number;
  /** External-API agent used only to propose bounded recovery DAGs. Defaults to defaultAgent. */
  recoveryAgent?: string;
  /** Provider-neutral runtime DAG expansion, enforced by the host scheduler. */
  dynamicDAG?: SpawnPolicy;
  /** Independent control-plane reviews. Worker capabilities are never exposed
   * to this role; observe mode records proposals without applying mutations. */
  workflowPolicy?: Omit<WorkflowBounds, "spawn"> & {
    agent: string;
    mode: "observe" | "apply";
    minIntervalMs: number;
    maxSnapshotTasks: number;
    maxSnapshotBytes: number;
  };
}
export interface SwarmSpec {
  /** Opt-in debugging policy. Healthy single-file tasks need no extra requests. */
  debugging?: {
    maxFailedCycles: number;
    maxInversionResets: number;
    requireProbeBeforeMultiFile: boolean;
    /** Fresh context on this existing provider profile; no execution tools. */
    auditorAgent?: string;
    /** Wall-clock limit for the diagnostic trajectory, including resumes. */
    branchTimeoutMs: number;
  };
  /** Optional per-verifier cap, including worktree preparation and cleanup.
   * Only adjacent, explicitly parallelSafe checks may use it. Defaults to 1. */
  verification?: { parallelism: number };
  /** Explicit authority to share bounded notes, never private thread transcripts. */
  coordination?: {
    cohorts: Record<string, { maxConcurrent: number }>;
    maxFindingsPerTask: number;
    maxDigestBytes: number;
  };
  jobs?: Record<string, JobTemplate>;
  researchProgramme?: ProgrammePolicy;
  researchStrategy?: ResearchStrategy;
  /** Explicit project sharing of bounded cards, never private source logs. */
  projectKnowledge?: KnowledgePolicy;
  /** Evidence-Fabric semantic contract. Defaults to software-engineering. */
  domainPack?: "software-engineering" | "ml-research" | "scientific-computing";
  /** Optional multi-host execution fleet. The coordinator remains authoritative. */
  workers?: Record<string, ExecutionWorker>;
  supervision?: SupervisionPolicy;
  schema: 1;
  name: string;
  project: string;
  baseRef: string;
  defaultAgent: string;
  agents: Record<string, AgentProfile>;
  checks: Record<string, CheckSpec>;
  integrationChecks: string[];
  protectedPaths: string[];
  limits: Contract["limits"];
  recipe: Recipe;
  budget: SwarmBudget;
}
export interface PinnedSwarm {
  version: 1;
  handsId: string;
  spec: SwarmSpec;
  baseCommit: string;
  git: PinnedCommand;
  checks: Record<string, PinnedCommand>;
  jobAdapters?: Record<string, PinnedCommand>;
  researchCheckers?: Record<string, PinnedCommand>;
  experimentValidators?: Record<string, Record<string, PinnedScientificValidator>>;
  workerAdapters?: Record<string, PinnedCommand>;
}
export function keys(value: object, required: string[], optional: string[] = []): void {
  invariant(value && typeof value === "object" && !Array.isArray(value), "expected object");
  for (const key of required) invariant(Object.hasOwn(value, key), `missing ${key}`);
  for (const key of Object.keys(value)) invariant(required.includes(key) || optional.includes(key), `unexpected ${key}`);
}
export function safePath(path: string): void {
  invariant(typeof path === "string" && path.length > 0 && !path.startsWith("/") && !/[\\:\x00-\x1f]/.test(path) &&
    path.split("/").every(p => !!p && ![".", "..", ".git", ".future-code"].includes(p)), "unsafe path");
}
export function inScope(path: string, scopes: string[]): boolean {
  return scopes.some(scope => path === scope || path.startsWith(`${scope}/`));
}
function names(names: string[], known: string[], label: string): void {
  invariant(Array.isArray(names) && names.length > 0 && new Set(names).size === names.length && names.every(n => known.includes(n)), `invalid ${label}`);
}
export const permittedChecks = (a: AgentProfile): string[] => [...new Set([...a.checks, ...(a.diagnostics ?? [])])];
export function validateSwarmSpec(s: SwarmSpec): void {
  keys(s, ["schema", "name", "project", "baseRef", "defaultAgent", "agents", "checks", "integrationChecks", "protectedPaths", "limits", "recipe", "budget"], ["jobs", "workers", "supervision", "domainPack", "coordination", "verification", "debugging", "researchProgramme", "researchStrategy", "projectKnowledge"]);
  invariant(s.schema === 1 && typeof s.name === "string" && !!s.name.trim(), "invalid swarm identity");
  invariant(typeof s.project === "string" && s.project.length > 0, "missing project");
  invariant(s.domainPack === undefined ||
    ["software-engineering", "ml-research", "scientific-computing"].includes(s.domainPack),
    "unknown evidence domain pack");
  invariant(typeof s.baseRef === "string" && s.baseRef.length > 0 && !s.baseRef.startsWith("-") && !s.baseRef.includes("\0"), "invalid baseRef");
  const c: Contract = { schema: 1, name: s.name, workerId: "swarm", verifierId: "swarm-checker", environmentId: "pinned-project",
    requiredChecks: ["scope", "behavior"], slos: [], limits: s.limits };
  validateContract(c); validateRecipe(c, s.recipe);
  if (s.projectKnowledge !== undefined) validateKnowledgePolicy(s.projectKnowledge, s.recipe.contextBytes);
  if (s.researchStrategy !== undefined) {
    validateResearchStrategy(s.researchStrategy);
    invariant(s.supervision?.workflowPolicy, "research strategy requires an independent workflow adviser");
    invariant(s.researchStrategy.maxSnapshotBytes <= s.recipe.contextBytes, "strategy context exceeds admitted context");
    if (s.researchStrategy.frontier) {
      invariant(s.supervision.dynamicDAG, "research frontier requires bounded delegation");
      invariant(s.researchStrategy.frontier.maxParallel <= s.recipe.parallelism, "research frontier exceeds admitted parallelism");
    }
    for (const c of s.researchStrategy.candidates) invariant(Object.hasOwn(s.jobs ?? {}, c.template) && s.jobs![c.template].research, "strategy requires a pinned scientific template");
  }
  if (s.researchProgramme !== undefined) {
    keys(s.researchProgramme, ["id", "maxFindingsPerTask", "maxContextBytes"]); identifier(s.researchProgramme.id);
    positive(s.researchProgramme.maxFindingsPerTask, 32, "programme findings per task");
    positive(s.researchProgramme.maxContextBytes, s.recipe.contextBytes, "programme context bytes");
    invariant(Object.values(s.jobs ?? {}).some(j => j.research), "research programme requires scientific job templates");
    const provided = Object.entries(s.jobs ?? {}).filter(([, j]) => j.research).map(([name, j]) => j.research!.provides ?? name);
    invariant(new Set(provided).size === provided.length, "duplicate programme finding names");
  }
  if (s.verification !== undefined) {
    keys(s.verification, ["parallelism"]);
    positive(s.verification.parallelism, 8, "verification parallelism");
  }
  invariant(s.agents && typeof s.agents === "object" && !Array.isArray(s.agents), "invalid agents");
  positive(Object.keys(s.agents).length, 32, "roster size");
  invariant(Object.hasOwn(s.agents, s.defaultAgent), "unknown defaultAgent");
  invariant(s.checks && typeof s.checks === "object" && !Array.isArray(s.checks), "invalid checks");
  const checks = Object.keys(s.checks); positive(checks.length, 128, "check count");
  for (const [id, check] of Object.entries(s.checks)) {
    identifier(id); keys(check, ["argv", "replaySafe"], ["files", "envAllow", "parallelSafe", "diagnosticPaths", "maxUnchangedFailures", "probeTimeoutMs"]);
    invariant(typeof check.replaySafe === "boolean", "explicit replaySafe required");
    invariant(check.parallelSafe === undefined || typeof check.parallelSafe === "boolean", "invalid parallelSafe");
    invariant(!check.parallelSafe || check.replaySafe, "parallelSafe checks must be replay-safe");
    invariant(check.probeTimeoutMs === undefined || (Number.isSafeInteger(check.probeTimeoutMs) &&
      check.probeTimeoutMs > 0 && check.probeTimeoutMs <= 2000 && check.replaySafe),
      "invalid probe deadline (1..2000ms, replay-safe probe required)");
    invariant(check.maxUnchangedFailures === undefined || (Number.isSafeInteger(check.maxUnchangedFailures) &&
      check.maxUnchangedFailures >= 2 && check.maxUnchangedFailures <= 16 && check.replaySafe),
      "invalid unchanged failure limit (2..16, replay-safe deterministic diagnostic required)");
    if (check.diagnosticPaths !== undefined) {
      invariant(Array.isArray(check.diagnosticPaths) && check.diagnosticPaths.length > 0 &&
        check.diagnosticPaths.length <= 128 && new Set(check.diagnosticPaths).size === check.diagnosticPaths.length,
        "invalid diagnosticPaths");
      for (const path of check.diagnosticPaths) {
        safePath(path); invariant(path.length <= 256, "diagnostic path too long");
      }
    }
    invariant(Array.isArray(check.argv) && check.argv.length > 0 && check.argv.every(x => typeof x === "string" && !x.includes("\0")), "invalid check argv");
    // Shell capabilities are a user-authored, pinned configuration, never task input.
  }
  names(s.integrationChecks, checks, "integration checks");
  invariant(s.integrationChecks.every(n => s.checks[n].replaySafe), "integration checks must be replay-safe");
  for (const [id, a] of Object.entries(s.agents)) {
    identifier(id); keys(a, ["protocol", "url", "model", "system", "tools", "checks"],
      ["keyEnv", "promptCache", "allowHttp", "quotaPool", "jobs", "fallbacks", "hedgeAfterMs", "cohort", "probes", "checkpointCheck", "diagnostics", "decisionPolicy"]);
    if (a.cohort !== undefined) {
      identifier(a.cohort);
      invariant(s.coordination && Object.hasOwn(s.coordination.cohorts, a.cohort), "unknown agent cohort");
    }
    if (a.tools.some(tool => ["publish_finding", "read_findings"].includes(tool)))
      invariant(s.coordination && a.cohort, "finding tools require an assigned cohort");
    if (a.tools.some(tool => ["record_experience", "read_knowledge"].includes(tool)))
      invariant(s.projectKnowledge && a.tools.includes("recall"), "knowledge tools require project knowledge policy and recall");
    invariant(["anthropic", "chat-completions"].includes(a.protocol), "unsupported provider protocol");
    const validateRoute = (route: ProviderRoute, label: string, strictShape = true) => {
      if (strictShape) keys(route, ["url", "model"], ["keyEnv", "allowHttp", "quotaPool"]);
      const url = new URL(route.url);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      invariant(url.protocol === "https:" || (url.protocol === "http:" && (loopback || route.allowHttp === true)),
        `HTTPS required for ${label}; private HTTP must be explicit`);
      invariant(!url.username && !url.password && !url.search && !url.hash, `credentials/query must not be in ${label} URL`);
      invariant(typeof route.model === "string" && !!route.model.trim(), `missing ${label} model`);
      if (route.keyEnv !== undefined) {
        invariant(/^[A-Z_][A-Z0-9_]*$/.test(route.keyEnv), `invalid ${label} keyEnv`);
        invariant(url.protocol === "https:" || loopback, `${label} credentials require HTTPS unless loopback`);
      }
      invariant(route.allowHttp === undefined || typeof route.allowHttp === "boolean", `invalid ${label} allowHttp`);
      if (route.quotaPool !== undefined)
        invariant(/^[A-Za-z0-9._:-]{1,128}$/.test(route.quotaPool), `invalid ${label} quotaPool`);
    };
    validateRoute(a, "primary provider", false);
    invariant(typeof a.system === "string" && !!a.system.trim(), "missing system");
    invariant(a.promptCache === undefined || typeof a.promptCache === "boolean", "invalid provider flag");
    if (a.fallbacks !== undefined) {
      invariant(Array.isArray(a.fallbacks) && a.fallbacks.length > 0 && a.fallbacks.length <= 3, "invalid fallback routes");
      for (let i = 0; i < a.fallbacks.length; i++) {
        validateRoute(a.fallbacks[i], `fallback[${i}]`);
        invariant(a.fallbacks[i].model === a.model,
          "fallback route must serve the same logical model; routing must not silently change model behavior");
      }
      const ids = [a, ...a.fallbacks].map(r => `${r.url}#${r.model}`);
      invariant(new Set(ids).size === ids.length, "duplicate provider route");
    }
    if (a.hedgeAfterMs !== undefined) {
      invariant(Number.isSafeInteger(a.hedgeAfterMs) && a.hedgeAfterMs >= 10 && a.hedgeAfterMs <= 60000, "invalid hedgeAfterMs");
      invariant(a.fallbacks?.length, "hedgeAfterMs requires fallback routes");
    }
    if (a.jobs !== undefined) names(a.jobs, Object.keys(s.jobs ?? {}), "agent jobs");
    if (a.tools.some(tool => tool === "run_job" || tool === "read_job_artifact"))
      invariant(a.jobs && a.jobs.length > 0, "job tools require named job capabilities");
    if (s.supervision) invariant(a.tools.includes("run_check"), "supervision requires a permitted checkpoint check");
    names(a.tools, [...TOOLS], "tools"); names(a.checks, checks, "agent checks");
    if (a.checkpointCheck !== undefined) invariant(a.tools.includes("run_check") && permittedChecks(a).includes(a.checkpointCheck),
      "checkpoint check must be a permitted run_check capability");
    if (a.diagnostics !== undefined) {
      names(a.diagnostics, checks, "agent diagnostics");
      invariant(a.tools.includes("run_check") && a.diagnostics.every(n => s.checks[n].replaySafe),
        "diagnostics require replay-safe permitted checks");
    }
    if (a.decisionPolicy !== undefined) {
      const p = a.decisionPolicy;
      keys(p, ["maxUnmeasuredWriteTurns", "measurementChecks"]);
      invariant(Number.isSafeInteger(p.maxUnmeasuredWriteTurns) && p.maxUnmeasuredWriteTurns >= 2 &&
        p.maxUnmeasuredWriteTurns <= 32, "invalid unmeasured write-turn limit (2..32)");
      names(p.measurementChecks, permittedChecks(a), "decision measurements");
      invariant(a.tools.includes("run_check"), "decision policy requires run_check");
    }
    if (a.probes !== undefined) {
      names(a.probes, checks, "agent probes");
      invariant(a.probes.every(name => s.checks[name].probeTimeoutMs !== undefined), "probe capability needs a pinned deadline");
    }
    if (a.tools.includes("run_probe")) invariant(a.probes?.length, "run_probe requires named probe capabilities");
    if (a.tools.includes("spawn_tasks"))
      invariant(s.supervision?.dynamicDAG, "spawn_tasks requires supervision.dynamicDAG");
    invariant(a.checks.every(n => s.checks[n].replaySafe), "independent verification checks must be replay-safe");
  }
  if (s.debugging) {
    const d = s.debugging;
    keys(d, ["maxFailedCycles", "maxInversionResets", "requireProbeBeforeMultiFile", "branchTimeoutMs"], ["auditorAgent"]);
    invariant(Number.isSafeInteger(d.maxFailedCycles) && d.maxFailedCycles >= 3 && d.maxFailedCycles <= 8, "invalid debugging failure window");
    invariant(Number.isSafeInteger(d.maxInversionResets) && d.maxInversionResets >= 0 && d.maxInversionResets <= 3, "invalid inversion reset limit");
    invariant(typeof d.requireProbeBeforeMultiFile === "boolean", "invalid multi-file probe policy");
    positive(d.branchTimeoutMs, 300000, "debugging branch timeout");
    if (d.auditorAgent !== undefined) invariant(Object.hasOwn(s.agents, d.auditorAgent), "unknown debugging auditor");
    if (d.requireProbeBeforeMultiFile) invariant(Object.values(s.agents).every(a =>
      !a.tools.some(t => ["write_file", "edit_file", "delete_file"].includes(t)) || a.tools.includes("run_probe")),
      "multi-file debugging policy requires probe-capable writers");
  }
  if (s.coordination) {
    const p = s.coordination;
    keys(p, ["cohorts", "maxFindingsPerTask", "maxDigestBytes"]);
    keys(p.cohorts, [], Object.keys(p.cohorts));
    positive(Object.keys(p.cohorts).length, 32, "cohort count");
    for (const [id, cohort] of Object.entries(p.cohorts)) {
      identifier(id); keys(cohort, ["maxConcurrent"]);
      positive(cohort.maxConcurrent, s.limits.parallelism, "cohort concurrency");
      invariant(Object.values(s.agents).some(agent => agent.cohort === id), "empty cohort roster");
    }
    invariant(Object.values(s.agents).every(agent => agent.cohort), "coordination requires all profiles to have a cohort");
    positive(p.maxFindingsPerTask, 32, "finding count");
    invariant(Number.isSafeInteger(p.maxDigestBytes) && p.maxDigestBytes >= 4096 &&
      p.maxDigestBytes <= Math.min(65536, Math.floor(s.recipe.contextBytes / 2)), "invalid finding digest bytes");
  }
  if (s.supervision) {
    keys(s.supervision, ["reportEveryMs", "checkpointEveryMs"], ["checkpointCadence", "checkpointEveryTurns", "checkpointAfterEvidence", "snapshotReads", "maxReplans", "maxObjectiveRequests", "maxObjectiveRequestBytes", "recoveryBackoffMs", "recoveryAgent", "dynamicDAG", "workflowPolicy"]);
    positive(s.supervision.reportEveryMs, 3600000, "reportEveryMs");
    invariant(s.supervision.reportEveryMs >= 10, "report interval too small");
    positive(s.supervision.checkpointEveryMs, 3600000, "checkpointEveryMs");
    invariant(s.supervision.checkpointCadence === undefined || ["periodic", "on-change"].includes(s.supervision.checkpointCadence), "invalid checkpoint cadence");
    if (s.supervision.checkpointEveryTurns !== undefined) positive(s.supervision.checkpointEveryTurns, 1000, "checkpointEveryTurns");
    invariant(s.supervision.checkpointAfterEvidence === undefined || typeof s.supervision.checkpointAfterEvidence === "boolean", "invalid checkpointAfterEvidence");
    invariant(s.supervision.snapshotReads === undefined || typeof s.supervision.snapshotReads === "boolean", "invalid snapshotReads");
    invariant(s.supervision.maxReplans === undefined || (Number.isSafeInteger(s.supervision.maxReplans) && s.supervision.maxReplans >= 0 && s.supervision.maxReplans <= 256), "invalid maxReplans");
    invariant(s.supervision.maxObjectiveRequests === undefined ||
      (Number.isSafeInteger(s.supervision.maxObjectiveRequests) && s.supervision.maxObjectiveRequests > 0 && s.supervision.maxObjectiveRequests <= 100_000_000),
      "invalid maxObjectiveRequests");
    invariant(s.supervision.maxObjectiveRequestBytes === undefined ||
      (Number.isSafeInteger(s.supervision.maxObjectiveRequestBytes) && s.supervision.maxObjectiveRequestBytes > 0 && s.supervision.maxObjectiveRequestBytes <= 9_000_000_000_000_000),
      "invalid maxObjectiveRequestBytes");
    invariant(s.supervision.recoveryBackoffMs === undefined ||
      (Number.isSafeInteger(s.supervision.recoveryBackoffMs) && s.supervision.recoveryBackoffMs >= 100 && s.supervision.recoveryBackoffMs <= 3_600_000),
      "invalid recoveryBackoffMs");
    if (s.supervision.recoveryAgent !== undefined)
      invariant(Object.hasOwn(s.agents, s.supervision.recoveryAgent), "unknown recoveryAgent");
    if (s.supervision.dynamicDAG) {
      const d = s.supervision.dynamicDAG;
      keys(d, ["maxChildrenPerTask", "maxDepth", "maxSpawnedTasks"]);
      positive(d.maxChildrenPerTask, 32, "dynamic child limit");
      positive(d.maxDepth, 32, "dynamic depth limit");
      positive(d.maxSpawnedTasks, s.limits.tasks, "dynamic task limit");
    }
    if (s.supervision.workflowPolicy) {
      const p = s.supervision.workflowPolicy;
      keys(p, ["agent", "mode", "minIntervalMs", "maxReviews", "maxOperations", "maxSnapshotTasks",
        "maxSnapshotBytes", "maxTaskTimeoutMs", "allowedOperations"]);
      invariant(Object.hasOwn(s.agents, p.agent), "unknown workflow policy agent");
      invariant(p.mode === "observe" || p.mode === "apply", "invalid workflow policy mode");
      positive(p.minIntervalMs, 3600000, "workflow review interval");
      invariant(p.minIntervalMs >= 100, "workflow review interval too small");
      positive(p.maxReviews, 256, "workflow review limit");
      positive(p.maxOperations, 16, "workflow operation limit");
      positive(p.maxSnapshotTasks, 128, "workflow snapshot task limit");
      positive(p.maxSnapshotBytes, Math.min(131072, s.limits.contextBytes), "workflow snapshot byte limit");
      invariant(p.maxSnapshotBytes >= 2048, "workflow snapshot byte limit too small");
      positive(p.maxTaskTimeoutMs, s.limits.timeoutMs, "workflow task timeout ceiling");
      invariant(Array.isArray(p.allowedOperations) && new Set(p.allowedOperations).size === p.allowedOperations.length &&
        p.allowedOperations.every(op => WORKFLOW_OPERATIONS.includes(op)), "invalid workflow operation whitelist");
      if (p.allowedOperations.includes("expand_task")) invariant(s.supervision.dynamicDAG,
        "workflow expansion requires supervision.dynamicDAG");
    }
  }
  if (s.workers) {
    keys(s.workers, [], Object.keys(s.workers)); positive(Object.keys(s.workers).length, 64, "execution worker count");
    for (const [id, worker] of Object.entries(s.workers)) {
      identifier(id); keys(worker, ["adapter", "maxConcurrent", "maxRpcBytes"]);
      keys(worker.adapter, ["argv"], ["envAllow", "files"]);
      invariant(Array.isArray(worker.adapter.argv) && worker.adapter.argv.length > 0 &&
        worker.adapter.argv.every(x => typeof x === "string" && !x.includes("\0")), "invalid worker adapter argv");
      positive(worker.maxConcurrent, 256, "worker concurrency");
      invariant(Number.isSafeInteger(worker.maxRpcBytes) && worker.maxRpcBytes >= 65536 && worker.maxRpcBytes <= 64 * 1024 * 1024,
        "invalid worker RPC byte limit");
    }
  }
  if (s.jobs) {
    keys(s.jobs, [], Object.keys(s.jobs));
    positive(Object.keys(s.jobs).length, s.researchStrategy?.frontier ? 256 : 32, "job templates");
    for (const [id, job] of Object.entries(s.jobs)) {
      identifier(id); keys(job, ["adapter", "idempotentEnsure", "pollMs", "staleMs", "maxJobs", "maxConcurrent"], ["reconcileAfterMs", "maxObjectiveJobs", "maxPollMs", "preflightChecks", "research"]);
      if (job.research !== undefined) {
        validateResearchConfiguration(job.research, job.adapter);
        const validators = Object.values(job.research.validators ?? {});
        const requirements = job.research.spec.schema === 2 ?
          [...job.research.spec.validation, ...(job.research.spec.planValidation ?? [])] : [];
        const validationMs = requirements.reduce((n, r) => n + job.research!.validators![r.id].timeoutMs, 0);
        invariant(validationMs <= s.budget.toolTimeoutMs &&
          validators.every(v => v.maxOutputBytes <= s.budget.maxToolOutputBytes), "scientific validation exceeds stage budget");
        if (job.research.provides !== undefined) identifier(job.research.provides);
        if (job.research.proofChecker) keys(job.research.proofChecker, ["argv"], ["envAllow", "files"]);
      }
      if (job.preflightChecks !== undefined) {
        names(job.preflightChecks, checks, "job preflight checks");
        invariant(job.preflightChecks.length <= 16 && job.preflightChecks.every(name => s.checks[name].replaySafe),
          "job preflight checks must be bounded and replay-safe");
        for (const a of Object.values(s.agents).filter(a => a.jobs?.includes(id)))
          invariant(a.tools.includes("run_check") && job.preflightChecks.every(name => permittedChecks(a).includes(name)),
            "job preflight checks must be permitted to the submitting agent");
      }
      keys(job.adapter, ["argv"], ["envAllow", "files"]);
      invariant(job.idempotentEnsure === true, "remote ensure must be idempotent");
      positive(job.pollMs, 3600000, "job poll interval"); invariant(job.pollMs >= 10, "job poll interval too short");
      if (job.maxPollMs !== undefined) {
        positive(job.maxPollMs, 3600000, "maximum job poll interval");
        invariant(job.maxPollMs >= job.pollMs, "maximum job poll interval below base poll interval");
      }
      positive(job.staleMs, 604800000, "job stale interval"); invariant(job.staleMs >= job.pollMs, "job stale interval too short");
      if (job.reconcileAfterMs !== undefined) {
        positive(job.reconcileAfterMs, 604800000, "job reconciliation interval");
        invariant(job.reconcileAfterMs >= job.staleMs, "job reconciliation interval must be >= stale interval");
      }
      positive(job.maxJobs, 100000, "job count");
      if (job.maxObjectiveJobs !== undefined)
        positive(job.maxObjectiveJobs, 1_000_000, "objective job count");
      positive(job.maxConcurrent, Math.min(256, job.maxJobs), "remote concurrency");
    }
  }
  const credentialNames = new Set(Object.values(s.agents).map(a => a.keyEnv).filter(Boolean));
  for (const check of [...Object.values(s.checks), ...Object.values(s.jobs ?? {}).map(j => j.adapter),
    ...Object.values(s.workers ?? {}).map(w => w.adapter),
    ...Object.values(s.jobs ?? {}).flatMap(j => j.research?.proofChecker ? [j.research.proofChecker] : []),
    ...Object.values(s.jobs ?? {}).flatMap(j => Object.values(j.research?.validators ?? {}).map(v => v.command))]) {
    invariant(!(check.envAllow ?? []).some(name => credentialNames.has(name)),
      "model credentials may not be forwarded to checks/jobs/execution workers");
  }
  invariant(Array.isArray(s.protectedPaths), "invalid protectedPaths"); s.protectedPaths.forEach(safePath);
  const bounds: SwarmBudget = { maxRequests: 1_000_000, maxRequestBytes: 1_000_000_000_000, maxTurns: 1000,
    maxToolCalls: 10000, modelConcurrency: 256, requestTimeoutMs: 3_600_000, toolTimeoutMs: 3_600_000,
    maxOutputTokens: 128000, maxToolOutputBytes: 16 * 1024 * 1024, maxPatchBytes: 16 * 1024 * 1024 };
  keys(s.budget, Object.keys(bounds));
  for (const k of Object.keys(bounds) as (keyof SwarmBudget)[]) positive(s.budget[k], bounds[k], k);
  invariant(s.budget.requestTimeoutMs <= s.recipe.timeoutMs && s.budget.toolTimeoutMs <= s.recipe.timeoutMs, "stage timeout exceeds attempt deadline");
}
export function validateSwarmTasks(s: SwarmSpec, tasks: Task[]): void {
  for (const task of tasks) {
    const agent = task.agent ?? s.defaultAgent;
    invariant(Object.hasOwn(s.agents, agent), `unknown agent: ${agent}`);
    if (task.knowledge !== undefined) {
      validateKnowledgeRefs(task.knowledge); invariant(s.researchProgramme, "knowledge import requires a research programme");
      invariant(task.knowledge.length <= s.researchProgramme.maxFindingsPerTask, "knowledge import count exceeds policy");
    }
    if (task.research !== undefined) {
      invariant(Array.isArray(task.research) && task.research.length <= 32 && new Set(task.research).size === task.research.length, "invalid task research requirements");
      for (const name of task.research) invariant(Object.hasOwn(s.jobs ?? {}, name) && s.jobs![name].research &&
        s.agents[agent].jobs?.includes(name) && s.agents[agent].tools.includes("run_job"), "research requirement is not an authorized scientific job");
    }
    for (const path of [...task.writeScope, ...(task.readScope ?? [])]) safePath(path);
    for (const path of task.writeScope) invariant(!s.protectedPaths.some(p => inScope(path, [p]) || inScope(p, [path])), "write scope overlaps protected paths");
  }
}
export function executable(name: string): string {
  if (isAbsolute(name)) return realpathSync(name);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(dir, name);
    if (existsSync(path) && statSync(path).isFile()) return realpathSync(path);
  }
  throw new Error(`executable not found: ${name}`);
}
