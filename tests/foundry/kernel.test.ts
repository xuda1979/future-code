import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, conflicts, digest, encodeCapsule, validateContract, validateRecipe, validateTasks, verdict } from "../../src/harness/foundry/kernel.ts";
import type { Capsule, Contract, Recipe, Task } from "../../src/harness/foundry/types.ts";
import { contract, recipe, task } from "./fixtures.ts";
test("canonical identity is stable and rejects non-JSON measurements", () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  for (const v of [NaN, Infinity, undefined, new Date()]) assert.throws(() => canonical(v));
});
test("contracts and recipes cannot silently relax or add arbitrary fields", () => {
  validateContract(contract); validateRecipe(contract, recipe);
  assert.throws(() => validateContract({ ...contract, requiredChecks: [] }));
  assert.throws(() => validateContract({ ...contract, requiredChecks: ["a", "a"] }));
  assert.throws(() => validateRecipe(contract, { ...recipe, parallelism: 0 }));
  assert.throws(() => validateRecipe(contract, { ...recipe, parallelism: 9 }));
  assert.throws(() => validateRecipe(contract, { ...recipe, requiredChecks: [] } as any));
});
test("DAG validation rejects cycles, absent dependencies and traversal", () => {
  validateTasks(contract, [task(), task("b", ["a"])]);
  for (const tasks of [[task("a", ["b"]), task("b", ["a"])], [task("a", ["missing"])], [task(), task()], [task("a", [], ["../outside"])], []]) assert.throws(() => validateTasks(contract, tasks));
  assert.equal(conflicts(["src/a"], ["src/a/child.ts"]), true);
  assert.equal(conflicts(["src/a"], ["src/abc"]), false);
});
test("missing/duplicate/stale verification never becomes PASS", () => {
  const artifact = { answer: 4 }; const m = { durationMs: 1, tokens: null, costUsd: null };
  assert.equal(verdict(contract, artifact, { artifactHash: digest(artifact), checks: [] }, m), "UNKNOWN");
  assert.equal(verdict(contract, artifact, { artifactHash: "stale", checks: [{ id: "behavior", verdict: "PASS" }] }, m), "INVALID");
  assert.equal(verdict(contract, artifact, { artifactHash: digest(artifact), checks: [{ id: "behavior", verdict: "PASS" }, { id: "behavior", verdict: "PASS" }] }, m), "INVALID");
  const verification = { artifactHash: digest(artifact), checks: [{ id: "behavior", verdict: "PASS" as const }] };
  assert.equal(verdict({ ...contract, slos: [{ metric: "costUsd", maximum: 1 }] }, artifact, verification, m), "UNKNOWN");
  assert.equal(verdict(contract, artifact, verification, m), "PASS");
});
test("mandatory context is measured as UTF-8 bytes, never cut in the middle", () => {
  const c: Capsule = { schema: 1, task: task(), runId: "r", fence: 1, contractHash: "c", recipeHash: "p", dependencies: [] };
  assert.equal(JSON.parse(encodeCapsule(c, 10000)).task.goal, c.task.goal);
  assert.throws(() => encodeCapsule(c, 10), /CONTEXT_OVERFLOW/);
});
