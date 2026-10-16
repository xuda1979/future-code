import { canonical, invariant } from "../kernel.ts";
import type { Task } from "../types.ts";
import { keys, validateSwarmTasks, type SwarmSpec } from "./config.ts";

/** Same grammar for worker delegation and independent workflow policy reviews. */
export const spawnChildrenSchema = { type: "array", minItems: 1, maxItems: 32,
  items: { type: "object", additionalProperties: false,
    properties: { id: { type: "string" }, goal: { type: "string" },
      acceptance: { type: "array", minItems: 1, items: { type: "string" } }, input: {},
      writeScope: { type: "array", items: { type: "string" } },
      readScope: { type: "array", items: { type: "string" } },
      dependsOn: { type: "array", maxItems: 32, items: { type: "string" } },
      research: { type: "array", maxItems: 32, items: { type: "string" } },
      agent: { type: "string" }, priority: { type: "number" },
      estimatedDurationMs: { type: "integer", minimum: 1 }, contextBudget: { type: "integer", minimum: 1 } },
    required: ["id", "goal", "acceptance", "input", "writeScope", "readScope"] } };

export function decodeSpawnChildren(spec: SwarmSpec, parent: Task, value: unknown): Task[] {
  const policy = spec.supervision?.dynamicDAG;
  invariant(policy, "dynamic DAG spawning is not configured");
  invariant(Array.isArray(value) && value.length > 0 && value.length <= policy.maxChildrenPerTask,
    "spawn child batch exceeds limit");
  const rawChildren = value.map(item => {
    invariant(item && typeof item === "object" && !Array.isArray(item), "invalid spawned child");
    const raw = item as Record<string, any>;
    keys(raw, ["id", "goal", "acceptance", "input", "writeScope", "readScope"],
      ["dependsOn", "agent", "priority", "estimatedDurationMs", "contextBudget", "research"]);
    invariant(typeof raw.id === "string" && raw.id.length > 0, "invalid child id");
    return raw;
  });
  const localIds = new Set(rawChildren.map(raw => raw.id as string));
  invariant(localIds.size === rawChildren.length, "duplicate spawned child id");
  const children: Task[] = rawChildren.map(raw => {
    const dependsOn = raw.dependsOn ?? [];
    invariant(Array.isArray(dependsOn) && dependsOn.length <= policy.maxChildrenPerTask &&
      dependsOn.every((id: unknown) => typeof id === "string") &&
      new Set(dependsOn).size === dependsOn.length, "invalid spawned child dependencies");
    for (const id of dependsOn as string[]) invariant(localIds.has(id) && id !== raw.id,
      "spawned child dependency must name another child in this batch");
    const child: Task = { id: `${parent.id}.${raw.id}`, goal: raw.goal, acceptance: raw.acceptance,
      dependencies: [...parent.dependencies, ...(dependsOn as string[]).map(id => `${parent.id}.${id}`)],
      writeScope: raw.writeScope, readScope: raw.readScope, input: raw.input };
    const agent = raw.agent ?? parent.agent;
    if (agent !== undefined) child.agent = agent;
    if (raw.research !== undefined) child.research = raw.research;
    if (raw.priority !== undefined) child.priority = raw.priority;
    if (raw.estimatedDurationMs !== undefined) child.estimatedDurationMs = raw.estimatedDurationMs;
    if (raw.contextBudget !== undefined) child.contextBudget = raw.contextBudget;
    if (parent.dependencyViews !== undefined) child.dependencyViews = JSON.parse(canonical(parent.dependencyViews));
    return child;
  });
  validateSwarmTasks(spec, children);
  return children;
}
