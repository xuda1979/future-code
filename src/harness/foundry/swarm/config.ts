import { existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { identifier, invariant, positive, validateContract, validateRecipe } from "../kernel.ts";
import type { CommandSpec, Contract, PinnedCommand, Recipe, SpawnPolicy, Task } from "../types.ts";

export const TOOLS = ["list_files", "read_file", "write_file", "edit_file", "delete_file", "run_check", "recall", "run_job", "spawn_tasks"] as const;
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
  protocol: Protocol;
  url: string;
  model: string;
  keyEnv?: string;
  system: string;
  tools: ToolName[];
  checks: string[];
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
export interface CheckSpec extends CommandSpec { replaySafe: boolean }
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
  adapter: CommandSpec;
  /** Adapter ensure(key) must reconcile/deduplicate remotely, not blindly resubmit. */
  idempotentEnsure: true;
  pollMs: number; staleMs: number; maxJobs: number; maxConcurrent: number;
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
}
export interface SwarmSpec {
  jobs?: Record<string, JobTemplate>;
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
export function validateSwarmSpec(s: SwarmSpec): void {
  keys(s, ["schema", "name", "project", "baseRef", "defaultAgent", "agents", "checks", "integrationChecks", "protectedPaths", "limits", "recipe", "budget"], ["jobs", "workers", "supervision", "domainPack"]);
  invariant(s.schema === 1 && typeof s.name === "string" && !!s.name.trim(), "invalid swarm identity");
  invariant(typeof s.project === "string" && s.project.length > 0, "missing project");
  invariant(s.domainPack === undefined ||
    ["software-engineering", "ml-research", "scientific-computing"].includes(s.domainPack),
    "unknown evidence domain pack");
  invariant(typeof s.baseRef === "string" && s.baseRef.length > 0 && !s.baseRef.startsWith("-") && !s.baseRef.includes("\0"), "invalid baseRef");
  const c: Contract = { schema: 1, name: s.name, workerId: "swarm", verifierId: "swarm-checker", environmentId: "pinned-project",
    requiredChecks: ["scope", "behavior"], slos: [], limits: s.limits };
  validateContract(c); validateRecipe(c, s.recipe);
  invariant(s.agents && typeof s.agents === "object" && !Array.isArray(s.agents), "invalid agents");
  positive(Object.keys(s.agents).length, 32, "roster size");
  invariant(Object.hasOwn(s.agents, s.defaultAgent), "unknown defaultAgent");
  invariant(s.checks && typeof s.checks === "object" && !Array.isArray(s.checks), "invalid checks");
  const checks = Object.keys(s.checks); positive(checks.length, 128, "check count");
  for (const [id, check] of Object.entries(s.checks)) {
    identifier(id); keys(check, ["argv", "replaySafe"], ["files", "envAllow"]);
    invariant(typeof check.replaySafe === "boolean", "explicit replaySafe required");
    invariant(Array.isArray(check.argv) && check.argv.length > 0 && check.argv.every(x => typeof x === "string" && !x.includes("\0")), "invalid check argv");
    // Shell capabilities are a user-authored, pinned configuration, never task input.
  }
  names(s.integrationChecks, checks, "integration checks");
  invariant(s.integrationChecks.every(n => s.checks[n].replaySafe), "integration checks must be replay-safe");
  for (const [id, a] of Object.entries(s.agents)) {
    identifier(id); keys(a, ["protocol", "url", "model", "system", "tools", "checks"],
      ["keyEnv", "promptCache", "allowHttp", "quotaPool", "jobs", "fallbacks", "hedgeAfterMs"]);
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
    if (a.tools.includes("run_job")) invariant(a.jobs && a.jobs.length > 0, "run_job requires named job capabilities");
    if (s.supervision) invariant(a.tools.includes("run_check"), "supervision requires a permitted checkpoint check");
    names(a.tools, [...TOOLS], "tools"); names(a.checks, checks, "agent checks");
    if (a.tools.includes("spawn_tasks"))
      invariant(s.supervision?.dynamicDAG, "spawn_tasks requires supervision.dynamicDAG");
    invariant(a.checks.every(n => s.checks[n].replaySafe), "independent verification checks must be replay-safe");
  }
  if (s.supervision) {
    keys(s.supervision, ["reportEveryMs", "checkpointEveryMs"], ["snapshotReads", "maxReplans", "maxObjectiveRequests", "maxObjectiveRequestBytes", "recoveryBackoffMs", "recoveryAgent", "dynamicDAG"]);
    positive(s.supervision.reportEveryMs, 3600000, "reportEveryMs");
    invariant(s.supervision.reportEveryMs >= 10, "report interval too small");
    positive(s.supervision.checkpointEveryMs, 3600000, "checkpointEveryMs");
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
    keys(s.jobs, [], Object.keys(s.jobs)); positive(Object.keys(s.jobs).length, 32, "job templates");
    for (const [id, job] of Object.entries(s.jobs)) {
      identifier(id); keys(job, ["adapter", "idempotentEnsure", "pollMs", "staleMs", "maxJobs", "maxConcurrent"], ["reconcileAfterMs", "maxObjectiveJobs"]);
      keys(job.adapter, ["argv"], ["envAllow", "files"]);
      invariant(job.idempotentEnsure === true, "remote ensure must be idempotent");
      positive(job.pollMs, 3600000, "job poll interval"); invariant(job.pollMs >= 10, "job poll interval too short");
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
    ...Object.values(s.workers ?? {}).map(w => w.adapter)]) {
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
