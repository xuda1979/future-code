import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { progressDensity, allocateContext, validateContract, validateRecipe, verdict, canonical, digest } from "../../src/harness/foundry/kernel.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { evaluate, promote, suggest, score } from "../../src/harness/foundry/evolution.ts";
import type { Contract, Driver, Evaluation, Protocol, Recipe, Task, Verification, WorkerResult, Capsule, Measurement } from "../../src/harness/foundry/types.ts";
import { contract as fixtureContract, recipe as fixtureRecipe, task as fixtureTask } from "./fixtures.ts";
const tmp = () => mkdtempSync(join(tmpdir(), "foundry-progress-"));

async function fixture(fn) {
  const path = tmp();
  const s = await Store.open(path);
  s.initialize(fixtureContract, { ...fixtureRecipe, parallelism: 1 });
  const baseline = s.active();
  const d = new MockDriver(baseline);
  try { await fn(s, d, baseline); } finally { s.close(); rmSync(path, { recursive: true, force: true }); }
}

class MockDriver {
  verifierId = fixtureContract.verifierId;
  workerId = fixtureContract.workerId;
  baselineHash;
  constructor(baselineHash) { this.baselineHash = baselineHash; }
  async execute(capsule, signal) {
    const isBaseline = capsule.recipeHash === this.baselineHash;
    return { artifact: { result: "ok", taskId: capsule.task.id }, measurement: { durationMs: isBaseline ? 100 : 50, tokens: isBaseline ? 20 : 10, costUsd: isBaseline ? 2 : 1 } };
  }
  async verify(capsule, result, signal) {
    return { artifactHash: digest(result.artifact), checks: [{ id: "behavior", verdict: "PASS" }], measurement: { durationMs: 5, tokens: 5, costUsd: 0.005 } };
  }
}

const protocol = (objective, gain, reps) => ({
  datasetId: "progress-holdout-v1", environmentId: fixtureContract.environmentId,
  tasks: [fixtureTask()], repetitions: reps || 2, objective: objective || "costUsd", minRelativeGain: gain || 0.2,
});


// == progressDensity ==

test("progressDensity returns accepted/contextBytes", () => {
  assert.equal(progressDensity(5, 10000), 5 / 10000);
  assert.equal(progressDensity(0, 10000), 0);
  assert.equal(progressDensity(10, 1000), 0.01);
});

test("progressDensity returns null for zero or negative context", () => {
  assert.equal(progressDensity(5, 0), null);
  assert.equal(progressDensity(5, -1), null);
  assert.equal(progressDensity(-1, 100), null);
  assert.equal(progressDensity(NaN, 100), null);
  assert.equal(progressDensity(5, Infinity), null);
});

test("progressDensity returns null for zero accepted and zero context", () => {
  assert.equal(progressDensity(0, 0), null);
});

// == allocateContext ==

test("allocateContext returns base budget for all tasks when share=0", () => {
  const tasks = [fixtureTask("a"), fixtureTask("b"), fixtureTask("c")];
  const recipe = { ...fixtureRecipe, priorityContextShare: 0 };
  const budgets = allocateContext(tasks, recipe);
  assert.equal(budgets.get("a"), fixtureRecipe.contextBytes);
  assert.equal(budgets.get("b"), fixtureRecipe.contextBytes);
  assert.equal(budgets.get("c"), fixtureRecipe.contextBytes);
});

test("allocateContext returns base budget when all priorities equal", () => {
  const tasks = [fixtureTask("a"), fixtureTask("b"), fixtureTask("c")].map(t => ({ ...t, priority: 5 }));
  const recipe = { ...fixtureRecipe, priorityContextShare: 0.7 };
  const budgets = allocateContext(tasks, recipe);
  assert.equal(budgets.get("a"), fixtureRecipe.contextBytes);
  assert.equal(budgets.get("b"), fixtureRecipe.contextBytes);
});

test("allocateContext gives high-priority task more context with share>0", () => {
  const tasks = [
    { ...fixtureTask("high"), priority: 10 },
    { ...fixtureTask("low"), priority: 1 },
  ];
  const recipe = { ...fixtureRecipe, priorityContextShare: 0.7 };
  const budgets = allocateContext(tasks, recipe);
  assert.ok(budgets.get("high") > budgets.get("low"));
  assert.ok(budgets.get("high") > fixtureRecipe.contextBytes);
  assert.ok(budgets.get("low") < fixtureRecipe.contextBytes);
});

test("allocateContext respects explicit per-task contextBudget", () => {
  const tasks = [
    { ...fixtureTask("explicit"), contextBudget: 5000 },
    { ...fixtureTask("default") },
  ];
  const recipe = { ...fixtureRecipe, priorityContextShare: 0.5 };
  const budgets = allocateContext(tasks, recipe);
  assert.equal(budgets.get("explicit"), 5000);
  assert.equal(budgets.get("default"), fixtureRecipe.contextBytes);
});

test("allocateContext caps explicit budget at 2x recipe contextBytes", () => {
  const tasks = [{ ...fixtureTask("big"), contextBudget: 999999 }];
  const recipe = { ...fixtureRecipe };
  const budgets = allocateContext(tasks, recipe);
  assert.ok(budgets.get("big") <= fixtureRecipe.contextBytes * 2);
});

test("allocateContext handles empty task list", () => {
  const budgets = allocateContext([], fixtureRecipe);
  assert.equal(budgets.size, 0);
});

test("allocateContext handles single task", () => {
  const budgets = allocateContext([fixtureTask("only")], fixtureRecipe);
  assert.equal(budgets.get("only"), fixtureRecipe.contextBytes);
});

// == validateRecipe with priorityContextShare ==

test("validateRecipe accepts priorityContextShare in [0,1]", () => {
  validateRecipe(fixtureContract, { ...fixtureRecipe, priorityContextShare: 0 });
  validateRecipe(fixtureContract, { ...fixtureRecipe, priorityContextShare: 0.5 });
  validateRecipe(fixtureContract, { ...fixtureRecipe, priorityContextShare: 1 });
});

test("validateRecipe rejects priorityContextShare > 1", () => {
  assert.throws(() => validateRecipe(fixtureContract, { ...fixtureRecipe, priorityContextShare: 1.5 }), /priorityContextShare/);
});

test("validateRecipe rejects priorityContextShare < 0", () => {
  assert.throws(() => validateRecipe(fixtureContract, { ...fixtureRecipe, priorityContextShare: -0.1 }), /priorityContextShare/);
});

test("validateRecipe rejects non-numeric priorityContextShare", () => {
  assert.throws(() => validateRecipe(fixtureContract, { ...fixtureRecipe, priorityContextShare: "high" as any }), /priorityContextShare/);
});

// == SLO with minimum (for progressDensity) ==

test("validateContract accepts SLO with minimum only", () => {
  const c = { ...fixtureContract, slos: [{ metric: "progressDensity" as const, minimum: 0.001 }] };
  validateContract(c);
});

test("validateContract rejects SLO with neither maximum nor minimum", () => {
  assert.throws(() => validateContract({ ...fixtureContract, slos: [{ metric: "durationMs" as const }] as any }), /SLO/);
});

test("validateContract accepts progressDensity metric in SLO", () => {
  const c = { ...fixtureContract, slos: [{ metric: "progressDensity" as const, minimum: 0 }] };
  validateContract(c);
});

test("verdict returns PASS when progressDensity SLO minimum is met", () => {
  const c = { ...fixtureContract, slos: [{ metric: "progressDensity" as const, minimum: 0.001 }] };
  const v = { artifactHash: digest({}), checks: [{ id: "behavior", verdict: "PASS" as const }] };
  assert.equal(verdict(c, {}, v, { durationMs: 10, tokens: 0, costUsd: 0, progressDensity: 0.005 }), "PASS");
});

test("verdict returns FAIL when progressDensity SLO minimum is not met", () => {
  const c = { ...fixtureContract, slos: [{ metric: "progressDensity" as const, minimum: 0.01 }] };
  const v = { artifactHash: digest({}), checks: [{ id: "behavior", verdict: "PASS" as const }] };
  assert.equal(verdict(c, {}, v, { durationMs: 10, tokens: 0, costUsd: 0, progressDensity: 0.001 }), "FAIL");
});

// == RunSummary includes progressDensity ==

test("runTasks summary includes progressDensity", async () => {
  await fixture(async (s, d) => {
    const result = await runTasks(s, [fixtureTask("a"), fixtureTask("b")], d);
    assert.ok(result.progressDensity !== undefined);
    assert.ok(result.progressDensity !== null);
    assert.ok(result.progressDensity > 0);
  });
});

test("progressDensity is higher with smaller context budget", async () => {
  await fixture(async (s, d) => {
    // Same tasks, smaller contextBytes -> higher density
    const r1 = await runTasks(s, [fixtureTask("a"), fixtureTask("b")], d);
    const smallBudget = s.propose({ contextBytes: 5000 });
    s.setMeta("active", smallBudget);
    const r2 = await runTasks(s, [fixtureTask("a"), fixtureTask("b")], d, { recipeHash: smallBudget });
    assert.ok(r2.progressDensity! > r1.progressDensity!, `r2 ${r2.progressDensity} should exceed r1 ${r1.progressDensity}`);
  });
});

// == Evolution with progressDensity objective ==

test("evaluate ADMITS candidate with higher progressDensity", async () => {
  await fixture(async (s, d, baseline) => {
    const candidate = s.propose({ contextBytes: 5000 });
    const e = await evaluate(s, candidate, protocol("progressDensity", 0.1), d);
    assert.equal(e.decision, "ADMIT");
    assert.ok(e.relativeGain! >= 0.1);
    assert.equal(s.active(), baseline);
  });
});

test("evaluate REJECTS candidate with lower progressDensity", async () => {
  await fixture(async (s, d, baseline) => {
    const candidate = s.propose({ contextBytes: 20000 });
    const e = await evaluate(s, candidate, protocol("progressDensity", 0.1), d);
    assert.equal(e.decision, "REJECT");
    assert.ok(e.relativeGain! < 0);
  });
});

test("score handles progressDensity objective (higher is better)", async () => {
  await fixture(async (s) => {
    const p = protocol("progressDensity", 0.1, 1);
    const e = {
      id: "test", baselineHash: s.active(), candidateHash: "x", contractHash: digest(s.contract()),
      protocol: p, protocolHash: digest(p),
      pairs: [{
        baseline: { id: "r1", recipeHash: s.active(), contractHash: digest(s.contract()), status: "PASS", accepted: 1, failed: 0, blocked: 0, attempts: 1, durationMs: 0, tokens: 0, costUsd: 0, progressDensity: 0.0001 },
        candidate: { id: "r2", recipeHash: "x", contractHash: digest(s.contract()), status: "PASS", accepted: 1, failed: 0, blocked: 0, attempts: 1, durationMs: 0, tokens: 0, costUsd: 0, progressDensity: 0.0002 },
      }],
      decision: "UNKNOWN", reasons: [], relativeGain: null,
    };
    const result = score(e);
    assert.equal(result.decision, "ADMIT");
    assert.ok(result.relativeGain! >= 1.0);
  });
});
