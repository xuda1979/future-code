import type { Contract, Recipe, Task } from "../../src/harness/foundry/types.ts";
export const contract: Contract = { schema: 1, name: "fixture", verifierId: "independent-v1", workerId: "fixture-worker-v1", environmentId: "fixture-v1", requiredChecks: ["behavior"], slos: [], limits: { parallelism: 8, attempts: 3, contextBytes: 20000, outputBytes: 20000, timeoutMs: 3000, tasks: 100 } };
export const recipe: Recipe = { parallelism: 2, attempts: 2, contextBytes: 10000, timeoutMs: 1000 };
export const task = (id = "a", dependencies: string[] = [], writeScope = [`src/${id}`]): Task => ({ id, goal: `Implement ${id}`, acceptance: ["behavior verified"], dependencies, writeScope, input: { x: 4 } });
