import { allocateContext, conflicts, invariant } from "./kernel.ts";
import type { Json, Recipe, Task } from "./types.ts";

/** Iterative longest downstream path, including this task. O(V + E).
 *  Missing estimates mean one unit per task, i.e. dependency depth. */
export function criticalPathRanks(tasks: readonly Task[]): Map<string, number> {
  const byId = new Map(tasks.map(t => [t.id, t]));
  invariant(byId.size === tasks.length, "duplicate task id");
  const degree = new Map(tasks.map(t => [t.id, t.dependencies.length]));
  const children = new Map<string, string[]>();
  for (const t of tasks) for (const d of t.dependencies) {
    invariant(byId.has(d), "unknown dependency");
    const list = children.get(d) ?? []; list.push(t.id); children.set(d, list);
  }
  const order = tasks.filter(t => !t.dependencies.length).map(t => t.id);
  for (let i = 0; i < order.length; i++) for (const id of children.get(order[i]) ?? []) {
    const n = degree.get(id)! - 1; degree.set(id, n); if (n === 0) order.push(id);
  }
  invariant(order.length === tasks.length, "dependency cycle");
  const ranks = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]; let tail = 0;
    for (const child of children.get(id) ?? []) tail = Math.max(tail, ranks.get(child)!);
    ranks.set(id, (byId.get(id)!.estimatedDurationMs ?? 1) + tail);
  }
  return ranks;
}

/** Readers share access; a writer excludes overlapping readers AND writers. */
export function accessConflicts(a: Task, b: Task): boolean {
  return conflicts(a.writeScope, b.writeScope) || conflicts(a.writeScope, b.readScope ?? []) ||
    conflicts(a.readScope ?? [], b.writeScope);
}

export function compilePlan(tasks: Task[], recipe: Recipe, ceiling: number) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const children = new Map<string, string[]>();
  for (const task of tasks) for (const d of task.dependencies) {
    const list = children.get(d) ?? []; list.push(task.id); children.set(d, list);
  }
  const ranks = recipe.scheduling === "critical-path" ? criticalPathRanks(tasks) : new Map<string, number>();
  const budgets = allocateContext(tasks, recipe, ceiling);
  for (const budget of budgets.values()) invariant(recipe.maxInFlightContextBytes === undefined ||
    budget <= recipe.maxInFlightContextBytes, "in-flight context ceiling cannot admit a task; reduce its budget or split it");
  const order = [...tasks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) ||
    (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  return { byId, children, ranks, budgets, order };
}

/** Explicit projection only. Return pointer -> value, preserving exact values.
 *  Full artifacts remain in the store, authenticated by their original hash. */
export function projectDependency(source: Json, pointers: readonly string[]): Json {
  const selected: Record<string, Json> = Object.create(null);
  for (const pointer of pointers) {
    invariant(typeof pointer === "string" && (pointer === "" || pointer.startsWith("/")) &&
      !/~(?![01])/.test(pointer), "DEPENDENCY_VIEW_INVALID: invalid JSON pointer");
    let value = source;
    for (const part of pointer === "" ? [] : pointer.slice(1).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      invariant(value !== null && typeof value === "object" && Object.hasOwn(value, key) &&
        (!Array.isArray(value) || /^(0|[1-9][0-9]*)$/.test(key)), `DEPENDENCY_VIEW_MISSING: ${pointer}`);
      value = (value as Record<string, Json>)[key];
    }
    selected[pointer] = value;
  }
  return selected;
}

/** Bounded novelty detector. A heartbeat or alternating repeated messages do
 *  not constitute progress. This is a liveness heuristic, not verification. */
export class ProgressWindow {
  private readonly seen = new Set<string>();
  private last: number;
  constructor(now: number) { this.last = now; }
  observe(fingerprint: string, now: number): boolean {
    invariant(typeof fingerprint === "string" && fingerprint.length > 0 &&
      Buffer.byteLength(fingerprint, "utf8") <= 256, "invalid progress fingerprint");
    if (this.seen.has(fingerprint) || this.seen.size >= 1024) return false;
    this.seen.add(fingerprint); this.last = Math.max(this.last, now); return true;
  }
  idleMs(now: number): number { return Math.max(0, now - this.last); }
}
