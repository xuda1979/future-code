import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { DynamicDelegation } from "../../src/harness/foundry/swarm/delegation.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { decodeTurn, requestBody } from "../../src/harness/foundry/swarm/model.ts";
import { validateSwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { fixture, task, spec, signal, scripted, reply } from "./swarm-fixtures.ts";

test("dynamic delegation admits bounded children and parent can yield its slot", async () => fixture(async (s, cfg) => {
  const parent = { ...task("parent"), writeScope: ["src/a.txt"], delegateScope: ["src/b.txt"] };
  const q = new Scheduler(s); const run = q.start([parent]); const lease = q.claim(run, "parent")!;
  const capsule = q.capsule(lease); const d = new DynamicDelegation(s, cfg);
  const child = { ...task("child"), writeScope: ["src/b.txt"], readScope: ["src"], dependencies: [], input: { value: 42 } };
  const spawned: any = d.spawn(capsule, cfg.spec.agents.coder, { id: "spawn-1", name: "spawn_tasks", arguments: { tasks: [child] } });
  assert.deepEqual(spawned.added, ["child"]);
  let wait!: DeferredAttemptError;
  try { d.await(capsule, cfg.spec.agents.coder, { id: "wait", name: "await_tasks", arguments: { ids: ["child"] } }); }
  catch (e) { assert.ok(e instanceof DeferredAttemptError); wait = e; }
  assert.ok(wait);
  q.defer(lease, wait);
  const childLease = q.claim(run, "child-worker")!;
  assert.equal(childLease.taskId, "child");
  assert.equal(s.db.prepare("SELECT parent FROM task_expansions WHERE run=? AND task='child'").get(run)!.parent, "parent");
}, s => {
  s.delegation = { maxDepth: 3, maxChildrenPerExpansion: 4, maxChildrenPerTask: 8 };
  s.agents.coder.tools.push("spawn_tasks", "await_tasks");
}));

test("dynamic delegation cannot widen parent authority or drift an admitted child id", async () => fixture(async (s, cfg) => {
  const parent = { ...task("parent"), delegateScope: ["src/b.txt"] };
  const q = new Scheduler(s); const run = q.start([parent]); const capsule = q.capsule(q.claim(run, "parent")!);
  const d = new DynamicDelegation(s, cfg);
  const good = { ...task("child"), writeScope: ["src/b.txt"], dependencies: [] };
  d.spawn(capsule, cfg.spec.agents.coder, { id: "spawn", name: "spawn_tasks", arguments: { tasks: [good] } });
  const wider = { ...task("other"), writeScope: ["src"], dependencies: [] };
  assert.throws(() => d.spawn(capsule, cfg.spec.agents.coder, { id: "wide", name: "spawn_tasks", arguments: { tasks: [wider] } }), /delegated authority/);
  assert.throws(() => d.spawn(capsule, cfg.spec.agents.coder, { id: "spawn", name: "spawn_tasks", arguments: { tasks: [{ ...good, goal: "drift" }] } }), /drift/);
}, s => {
  s.delegation = { maxDepth: 2, maxChildrenPerExpansion: 4, maxChildrenPerTask: 8 };
  s.agents.coder.tools.push("spawn_tasks", "await_tasks");
}));

test("driver refreshes context budgets after another scheduler expands the run", async () => fixture(async (s, cfg) => {
  const parent = { ...task("parent"), delegateScope: ["src/b.txt"] };
  const q = new Scheduler(s); const run = q.start([parent]); const parentLease = q.claim(run, "parent")!;
  const driver = new SwarmDriver(s, cfg, scripted([() => reply("child complete")]).fetcher);
  (driver as any).contextPlan = { run, recipe: parentLease.recipeHash, taskCount: 1, budgets: new Map([["parent", 1024]]) };
  const d = new DynamicDelegation(s, cfg);
  d.spawn(q.capsule(parentLease), cfg.spec.agents.coder, { id: "spawn-refresh", name: "spawn_tasks", arguments: {
    tasks: [{ ...task("child"), writeScope: ["src/b.txt"], dependencies: [] }]
  } });
  q.defer(parentLease, new DeferredAttemptError("subagents", Date.now() + 1000, "yield parent"));
  const childLease = q.claim(run, "child")!; assert.equal(childLease.taskId, "child");
  await driver.execute(q.capsule(childLease), signal());
  assert.equal((driver as any).contextPlan.taskCount, 2);
  assert.ok((driver as any).contextPlan.budgets.has("child"));
}, s => {
  s.delegation = { maxDepth: 3, maxChildrenPerExpansion: 4, maxChildrenPerTask: 8 };
  s.agents.coder.tools.push("spawn_tasks", "await_tasks");
}));

test("SGLang and vLLM profiles keep a stable system/tool prefix across sibling tasks", () => {
  for (const engine of ["sglang", "vllm"] as const) {
    const s = spec("x"); s.agents.coder.inferenceEngine = engine;
    validateSwarmSpec(s);
    const one: any = requestBody(s.agents.coder, [{ role: "user", content: '{"task":"one"}' }], s.budget);
    const two: any = requestBody(s.agents.coder, [{ role: "user", content: '{"task":"two"}' }], s.budget);
    assert.equal(one.messages[0].content, two.messages[0].content);
    assert.deepEqual(one.tools, two.tools);
    assert.notEqual(one.messages[1].content, two.messages[1].content);
  }
});

test("OpenAI-compatible usage exposes real prefix-cache hits", () => {
  const turn = decodeTurn("chat-completions", {
    choices: [{ finish_reason: "stop", message: { content: "done" } }],
    usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 75, created_cache_tokens: 20 } },
  });
  assert.equal(turn.tokens, 107);
  assert.deepEqual(turn.usage, { inputTokens: 100, outputTokens: 7, cachedInputTokens: 75, createdCacheTokens: 20 });
});

test("run summary uses uncached provider input tokens, not configured context budget", async () => fixture(async s => {
  const mock = scripted([
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }],
      { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60, created_cache_tokens: 0 } }),
    () => reply("done", [],
      { prompt_tokens: 80, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 50, created_cache_tokens: 0 } }),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS");
  assert.equal(result.progressDensityBasis, "uncachedInputTokens");
  assert.equal(result.decisionInput, 70);
  assert.equal(result.progressDensity, 1 / 70);
  assert.equal(result.cacheReuseRatio, 110 / 180);
}));

test("missing detailed provider cache usage falls back to measured request bytes", async () => fixture(async s => {
  const mock = scripted([
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("done"),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  // The fixture reports prompt/completion counts but no cache details; zero cache
  // is still a complete OpenAI usage record, so measured token basis remains valid.
  assert.equal(result.progressDensityBasis, "uncachedInputTokens");
  assert.ok(result.decisionInput > 0);
  assert.equal(result.cacheReuseRatio, 0);
}));
