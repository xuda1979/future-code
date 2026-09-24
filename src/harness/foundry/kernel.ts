import { createHash } from "node:crypto";
import type { Capsule, Contract, Json, Measurement, Recipe, Task, Verification, Verdict } from "./types.ts";

/** Stable JSON: reject non-finite values and objects with surprising semantics. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error("not finite, plain JSON");
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
export function invariant(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export function positive(n: number, max: number, label: string): void {
  invariant(Number.isSafeInteger(n) && n > 0 && n <= max, `invalid ${label}`);
}
export function identifier(s: string): void {
  invariant(typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(s) &&
    !["__proto__", "constructor", "prototype"].includes(s), "invalid identifier");
}
function exactKeys(value: object, required: string[], optional: string[] = []): void {
  const present = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  // All required keys must be present.
  for (const k of required) invariant(present.includes(k), `missing required field ${k}`);
  // No keys outside the allowed set.
  for (const k of present) invariant(allowed.includes(k), `unexpected field ${k}`);
}
export function validateContract(c: Contract): void {
  canonical(c);
  exactKeys(c, ["schema", "name", "verifierId", "workerId", "environmentId", "requiredChecks", "slos", "limits"]);
  invariant(c.schema === 1 && [c.name, c.verifierId, c.workerId, c.environmentId].every(s => typeof s === "string" && s.length > 0), "invalid contract identity");
  invariant(Array.isArray(c.requiredChecks) && c.requiredChecks.length > 0, "at least one required check is mandatory");
  c.requiredChecks.forEach(identifier);
  invariant(new Set(c.requiredChecks).size === c.requiredChecks.length, "duplicate required checks");
  invariant(Array.isArray(c.slos), "invalid SLOs");
  const seen = new Set<string>();
  for (const s of c.slos) {
    exactKeys(s, ["metric"], ["maximum", "minimum"]);
    invariant(["durationMs", "tokens", "costUsd", "progressDensity"].includes(s.metric), "invalid SLO metric");
    invariant(s.maximum !== undefined || s.minimum !== undefined, "SLO must have maximum or minimum");
    if (s.maximum !== undefined) invariant(Number.isFinite(s.maximum) && s.maximum >= 0, "invalid SLO maximum");
    if (s.minimum !== undefined) invariant(Number.isFinite(s.minimum) && s.minimum >= 0, "invalid SLO minimum");
    invariant(!seen.has(s.metric), "duplicate SLO"); seen.add(s.metric);
  }
  exactKeys(c.limits, ["parallelism", "attempts", "contextBytes", "outputBytes", "timeoutMs", "tasks"]);
  positive(c.limits.parallelism, 256, "parallelism ceiling");
  positive(c.limits.attempts, 10, "attempt ceiling");
  positive(c.limits.contextBytes, 4 * 1024 * 1024, "context ceiling");
  positive(c.limits.outputBytes, 16 * 1024 * 1024, "output ceiling");
  positive(c.limits.timeoutMs, 86_400_000, "timeout ceiling");
  positive(c.limits.tasks, 100_000, "task ceiling");
}
export function validateRecipe(c: Contract, p: Recipe): void {
  exactKeys(p, ["parallelism", "attempts", "contextBytes", "timeoutMs"], ["priorityContextShare", "scheduling", "maxInFlightContextBytes", "noProgressMs", "maxRepeatedFailures"]);
  for (const k of ["parallelism", "attempts", "contextBytes", "timeoutMs"] as const) positive(p[k], c.limits[k], k);
  if (p.priorityContextShare !== undefined) {
    invariant(typeof p.priorityContextShare === "number" && Number.isFinite(p.priorityContextShare) && p.priorityContextShare >= 0 && p.priorityContextShare <= 1, "invalid priorityContextShare");
  }
  invariant(p.scheduling === undefined || ["priority", "critical-path"].includes(p.scheduling), "invalid scheduling");
  if (p.maxInFlightContextBytes !== undefined) positive(p.maxInFlightContextBytes,
    c.limits.parallelism * c.limits.contextBytes, "in-flight context ceiling");
  if (p.noProgressMs !== undefined) positive(p.noProgressMs, p.timeoutMs, "no-progress deadline");
  if (p.maxRepeatedFailures !== undefined) positive(p.maxRepeatedFailures, p.attempts, "repeated failure limit");
}
export function validateTasks(c: Contract, tasks: Task[]): void {
  invariant(Array.isArray(tasks), "tasks must be an array");
  positive(tasks.length, c.limits.tasks, "task count");
  const byId = new Map<string, Task>();
  for (const t of tasks) {
    canonical(t); identifier(t.id); invariant(Object.hasOwn(t, "input"), "missing task input");
    invariant(!byId.has(t.id), "duplicate task id"); byId.set(t.id, t);
    invariant(typeof t.goal === "string" && t.goal.trim().length > 0, "empty goal");
    invariant(Array.isArray(t.acceptance) && t.acceptance.length > 0 && t.acceptance.every(s => typeof s === "string" && !!s.trim()), "missing acceptance conditions");
    invariant(Array.isArray(t.dependencies) && new Set(t.dependencies).size === t.dependencies.length, "invalid dependencies");
    invariant(Array.isArray(t.writeScope), "invalid write scopes");
    invariant(t.readScope === undefined || Array.isArray(t.readScope), "invalid read scopes");
    for (const p of [...t.writeScope, ...(t.readScope ?? [])]) {
      invariant(typeof p === "string" && p.length > 0 && !p.includes("\\") && !p.startsWith("/") &&
        !p.includes("\0") && !p.includes(":") && p.split("/").every(x => !!x && x !== "." && x !== "..") &&
        ![".git", ".future-code"].includes(p.split("/")[0]), "unsafe write scope");
    }
    invariant(t.priority === undefined || Number.isFinite(t.priority), "invalid priority");
    if (t.contextBudget !== undefined) positive(t.contextBudget, c.limits.contextBytes, "task context budget");
    if (t.estimatedDurationMs !== undefined) positive(t.estimatedDurationMs, c.limits.timeoutMs, "duration estimate");
    if (t.dependencyViews !== undefined) {
      invariant(t.dependencyViews !== null && !Array.isArray(t.dependencyViews) && typeof t.dependencyViews === "object", "invalid dependency views");
      for (const [id, pointers] of Object.entries(t.dependencyViews)) {
        invariant(t.dependencies.includes(id), "view must name a direct dependency");
        invariant(Array.isArray(pointers) && pointers.length > 0 && pointers.length <= 256 && new Set(pointers).size === pointers.length, "invalid dependency view pointers");
        for (const pointer of pointers) invariant(typeof pointer === "string" && pointer.length <= 2048 &&
          (pointer === "" || pointer.startsWith("/")) && !/~(?![01])/.test(pointer), "invalid JSON pointer");
      }
    }
  }
  // Kahn's algorithm avoids recursion limits on large DAGs.
  const degree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const t of tasks) {
    degree.set(t.id, t.dependencies.length);
    for (const d of t.dependencies) {
      invariant(byId.has(d) && d !== t.id, "unknown or self dependency");
      const list = children.get(d) ?? []; list.push(t.id); children.set(d, list);
    }
  }
  const ready = tasks.filter(t => degree.get(t.id) === 0).map(t => t.id);
  for (let i = 0; i < ready.length; i++) for (const id of children.get(ready[i]) ?? []) {
    const n = degree.get(id)! - 1; degree.set(id, n); if (!n) ready.push(id);
  }
  invariant(ready.length === tasks.length, "dependency cycle");
}
export function conflicts(a: string[], b: string[]): boolean {
  return a.some(x => b.some(y => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}
/** Never truncate a goal, an acceptance predicate, or a dependency output. */
export function encodeCapsule(c: Capsule, budget: number): string {
  const text = canonical(c);
  invariant(Buffer.byteLength(text, "utf8") <= budget, "CONTEXT_OVERFLOW: split the task or propose a larger admitted recipe");
  return text;
}
export function validMeasurement(m: Measurement | undefined): Measurement {
  for (const n of [m?.tokens, m?.costUsd]) invariant(n == null || (Number.isFinite(n) && n >= 0), "invalid adapter measurement");
  invariant(m?.tokens == null || Number.isSafeInteger(m.tokens), "invalid token measurement");
  return { tokens: m?.tokens ?? null, costUsd: m?.costUsd ?? null };
}
export function combineMeasurements(a: Measurement, b: Measurement): Measurement {
  return {
    tokens: a.tokens === null || b.tokens === null ? null : a.tokens + b.tokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
  };
}
export function verdict(c: Contract, artifact: Json, v: Verification, metrics: Measurement & { durationMs: number; progressDensity?: number }): Verdict {
  if (v.artifactHash !== digest(artifact) || !Array.isArray(v.checks)) return "INVALID";
  const map = new Map<string, Verdict>();
  for (const check of v.checks) {
    if (map.has(check.id) || !["PASS", "FAIL", "UNKNOWN", "INVALID"].includes(check.verdict)) return "INVALID";
    map.set(check.id, check.verdict);
  }
  const required = c.requiredChecks.map(id => map.get(id) ?? "UNKNOWN");
  if (required.includes("INVALID")) return "INVALID";
  if (required.includes("FAIL")) return "FAIL";
  if (required.includes("UNKNOWN")) return "UNKNOWN";
  for (const s of c.slos) {
    const n = metrics[s.metric];
    if (n == null || !Number.isFinite(n)) return "UNKNOWN";
    if (n < 0) return "INVALID";
    if (s.maximum !== undefined && n > s.maximum) return "FAIL";
    if (s.minimum !== undefined && n < s.minimum) return "FAIL";
  }
  return "PASS";
}

/** Recheck the binding at admission and again when promoting a recipe. */
export function validateEvidence(contract: Contract, recipeHash: string, task: Task, artifact: Json, raw: Json): void {
  const e = raw as any;
  invariant(e && e.contractHash === digest(contract) && e.recipeHash === recipeHash &&
    e.verifierId === contract.verifierId && e.taskHash === digest(task) && e.artifactHash === digest(artifact), "evidence identity mismatch");
  invariant(e.metrics && Number.isFinite(e.metrics.durationMs) && e.metrics.durationMs >= 0, "missing duration evidence");
  validMeasurement(e.metrics);
  invariant(e.verification && verdict(contract, artifact, e.verification, e.metrics) === "PASS", "evidence does not satisfy acceptance contract");
}

/** Progress density: verified accepted tasks per total context bytes consumed.
 *  This is the core shift from bounding activity to bounding the decision problem.
 *  Higher density means more verified progress per unit of context — not just
 *  more agent activity, file size, or conversation length. */
export function progressDensity(accepted: number, contextBytes: number): number | null {
  if (!Number.isFinite(accepted) || accepted < 0 || !Number.isFinite(contextBytes) || contextBytes <= 0) return null;
  return accepted / contextBytes;
}

/** Allocate per-task context budget based on priority and the recipe's
 *  priorityContextShare. The recipe's contextBytes is the default per-task
 *  budget. When priorityContextShare > 0, high-priority tasks get a multiplied
 *  budget and low-priority tasks get a reduced budget, keeping the average
 *  at contextBytes. This ensures each agent gets enough — but not excessive —
 *  context for its decision problem. */
export function allocateContext(tasks: Task[], recipe: Recipe, ceiling = recipe.contextBytes * 2): Map<string, number> {
  const budget = new Map<string, number>();
  const share = recipe.priorityContextShare ?? 0;
  const base = recipe.contextBytes;
  if (tasks.length === 0) return budget;

  // Tasks with explicit contextBudget use it directly (capped to contract limit).
  for (const t of tasks) {
    if (t.contextBudget !== undefined) {
      budget.set(t.id, Math.min(t.contextBudget, base * 2, ceiling));
    }
  }
  const remaining = tasks.filter(t => t.contextBudget === undefined);
  if (remaining.length === 0) return budget;

  if (share === 0 || remaining.every(t => (t.priority ?? 0) === (remaining[0].priority ?? 0))) {
    // Equal allocation: every task gets the base budget.
    for (const t of remaining) budget.set(t.id, Math.min(base, ceiling));
    return budget;
  }

  // Priority-weighted allocation: high-priority tasks get share*2 multiplier,
  // low-priority tasks get (1-share) multiplier, keeping average ≈ base.
  const sorted = [...remaining].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const topCount = Math.min(sorted.length - 1, Math.max(1, Math.floor(sorted.length * share)));
  for (let i = 0; i < sorted.length; i++) {
    const multiplier = i < topCount ? 1 + share : 1 - share * (topCount / (sorted.length - topCount || 1));
    budget.set(sorted[i].id, Math.min(ceiling, Math.max(1, Math.floor(base * multiplier))));
  }
  return budget;
}
