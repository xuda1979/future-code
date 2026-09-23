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
function exactKeys(value: object, keys: string[]): void {
  invariant(Object.keys(value).sort().join(",") === keys.sort().join(","), "unexpected or missing configuration fields");
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
    exactKeys(s, ["metric", "maximum"]);
    invariant(["durationMs", "tokens", "costUsd"].includes(s.metric) && Number.isFinite(s.maximum) && s.maximum >= 0, "invalid SLO");
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
  exactKeys(p, ["parallelism", "attempts", "contextBytes", "timeoutMs"]);
  for (const k of ["parallelism", "attempts", "contextBytes", "timeoutMs"] as const) positive(p[k], c.limits[k], k);
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
    for (const p of t.writeScope) {
      invariant(typeof p === "string" && p.length > 0 && !p.includes("\\") && !p.startsWith("/") &&
        !p.includes("\0") && !p.includes(":") && p.split("/").every(x => !!x && x !== "." && x !== "..") &&
        ![".git", ".future-code"].includes(p.split("/")[0]), "unsafe write scope");
    }
    invariant(t.priority === undefined || Number.isFinite(t.priority), "invalid priority");
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
export function verdict(c: Contract, artifact: Json, v: Verification, metrics: Measurement & { durationMs: number }): Verdict {
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
    if (n === null || !Number.isFinite(n)) return "UNKNOWN";
    if (n < 0) return "INVALID";
    if (n > s.maximum) return "FAIL";
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
