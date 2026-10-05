import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { evaluateRealProject, validateProjectPair } from "../../src/harness/foundry/projectEvaluation.ts";
import { fixture, reply, task, signal } from "./swarm-fixtures.ts";

test("real-project comparison freezes model, tools, budgets and acceptance across recipes", async () => fixture(async (s, cfg) => {
  const base = cfg.spec, candidate = { ...base, recipe: { ...base.recipe, parallelism: 1 } };
  validateProjectPair(base, candidate);
  assert.throws(() => validateProjectPair(base, { ...candidate, integrationChecks: [] }), /changes model, acceptance/);
  const changed = structuredClone(candidate); changed.agents.coder.model = "different-model";
  assert.throws(() => validateProjectPair(base, changed), /changes model, acceptance/);
  await assert.rejects(evaluateRealProject({ baseline: base, candidate, tasks: [task()], repetitions: 1,
    root: join(s.root, "injected"), mode: "live", fetcher: (() => { throw new Error("never call"); }) as any, signal: signal() }), /real transport/);
}));

test("replayed project trials verify actual patches and persist zero live requests without inventing a speedup", async () => fixture(async (s, cfg) => {
  const tasks = [task()];
  const recording = { schema: 1, tasksHash: digest(tasks), responses: { a: [
    await reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]).json(),
    await reply("implemented").json(),
  ] } };
  const root = join(s.root, "paired");
  const report: any = await evaluateRealProject({ baseline: cfg.spec,
    candidate: { ...cfg.spec, recipe: { ...cfg.spec.recipe, parallelism: 1 } }, tasks,
    repetitions: 1, root, mode: "replay", signal: signal() }, recording);
  assert.equal(report.allPass, true); assert.equal(report.decision, "OFFLINE_BOUNDARY_ONLY");
  assert.equal(report.observedSpeedup, null); assert.equal(report.modelRequests, 0);
  assert.equal(report.trials.length, 2);
  for (const trial of report.trials) {
    assert.equal(trial.metrics.verifiedObjectives, 1); assert.equal(trial.metrics.verifiedTasks, 1);
    assert.equal(trial.metrics.replayedRequests, 2); assert.equal(trial.metrics.providerTokens, null);
    assert.equal(trial.metrics.verifiedTasksPerModelRequest, null); assert.equal(trial.metrics.verifiedTasksPerUsd, null);
    assert.match(trial.reportHash, /^[a-f0-9]{64}$/); assert.ok(trial.integration.checksHash);
  }
  assert.equal(JSON.parse(readFileSync(join(root, "trials.json"), "utf8")).length, 2);
}));
