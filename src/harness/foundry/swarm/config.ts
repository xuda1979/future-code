import { existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { identifier, invariant, positive, validateContract, validateRecipe } from "../kernel.ts";
import type { CommandSpec, Contract, PinnedCommand, Recipe, Task } from "../types.ts";

export const TOOLS = ["list_files", "read_file", "write_file", "edit_file", "delete_file", "run_check", "recall"] as const;
export type ToolName = typeof TOOLS[number];
export type Protocol = "anthropic" | "chat-completions";
export interface AgentProfile {
  protocol: Protocol;
  url: string;
  model: string;
  keyEnv?: string;
  system: string;
  tools: ToolName[];
  checks: string[];
  promptCache?: boolean;
  allowHttp?: boolean;
}
export interface CheckSpec extends CommandSpec { replaySafe: boolean }
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
export interface SwarmSpec {
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
  keys(s, ["schema", "name", "project", "baseRef", "defaultAgent", "agents", "checks", "integrationChecks", "protectedPaths", "limits", "recipe", "budget"]);
  invariant(s.schema === 1 && typeof s.name === "string" && !!s.name.trim(), "invalid swarm identity");
  invariant(typeof s.project === "string" && s.project.length > 0, "missing project");
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
    identifier(id); keys(a, ["protocol", "url", "model", "system", "tools", "checks"], ["keyEnv", "promptCache", "allowHttp"]);
    invariant(["anthropic", "chat-completions"].includes(a.protocol), "unsupported provider protocol");
    const url = new URL(a.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    invariant(url.protocol === "https:" || (url.protocol === "http:" && (loopback || a.allowHttp === true)), "HTTPS required; private HTTP must be explicit");
    invariant(!url.username && !url.password && !url.search && !url.hash, "credentials/query must not be in provider URL");
    invariant(typeof a.model === "string" && !!a.model.trim() && typeof a.system === "string" && !!a.system.trim(), "missing model/system");
    if (a.keyEnv !== undefined) invariant(/^[A-Z_][A-Z0-9_]*$/.test(a.keyEnv), "invalid keyEnv");
    for (const x of [a.promptCache, a.allowHttp]) invariant(x === undefined || typeof x === "boolean", "invalid provider flag");
    names(a.tools, [...TOOLS], "tools"); names(a.checks, checks, "agent checks");
    invariant(a.checks.every(n => s.checks[n].replaySafe), "independent verification checks must be replay-safe");
  }
  const credentialNames = new Set(Object.values(s.agents).map(a => a.keyEnv).filter(Boolean));
  for (const check of Object.values(s.checks)) {
    invariant(!(check.envAllow ?? []).some(name => credentialNames.has(name)), "model credentials may not be forwarded to checks");
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
