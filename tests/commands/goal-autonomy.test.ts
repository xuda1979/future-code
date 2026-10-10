import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enableAutoGoal, pauseAutoGoal, readAutoGoal, resumeAutoGoal,
  takeAutoGoalContinuation, decideAutoGoalContinuation, parkActiveAutoGoal, AUTO_GOAL_BATCH_LIMIT, MAX_AUTO_GOAL_CONTINUATIONS,
  isAutoGoalMainThread,
  shouldPauseGoalAfterTerminal,
} from "../../src/commands/goal/auto.ts";

function fixture(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "goal-auto-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const take = (cwd: string) => takeAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true });

test('urgent user questions preserve the goal; explicit cancellation and errors pause it', () => {
  assert.equal(shouldPauseGoalAfterTerminal('completed'), false);
  assert.equal(shouldPauseGoalAfterTerminal('aborted_streaming', 'interrupt'), false);
  assert.equal(shouldPauseGoalAfterTerminal('aborted_tools', 'interrupt'), false);
  assert.equal(shouldPauseGoalAfterTerminal('aborted_streaming', 'user-cancel'), true);
  assert.equal(shouldPauseGoalAfterTerminal('model_error', 'interrupt'), true);
  assert.equal(shouldPauseGoalAfterTerminal('max_turns'), true);
});

test("opt-in only; SDK/subagents and explicit turn ceilings never auto-continue", () => fixture(dir => {
  assert.equal(take(dir), null);
  enableAutoGoal("Build verified demo", dir);
  assert.equal(takeAutoGoalContinuation({ cwd: dir, mainThread: false, withinTurnBudget: true }), null);
  assert.equal(readAutoGoal(dir)?.totalContinuations, 0);
  assert.match(take(dir)!, /Build verified demo/);
  assert.equal(readAutoGoal(dir)?.totalContinuations, 1);
}));

test("pause/resume preserve durable accounting across process-equivalent reads", () => fixture(dir => {
  enableAutoGoal("Do research", dir);
  take(dir);
  pauseAutoGoal(dir);
  assert.equal(take(dir), null);
  assert.equal(readAutoGoal(dir)?.state, "PAUSED");
  resumeAutoGoal(dir);
  assert.equal(readAutoGoal(dir)?.totalContinuations, 1);
  assert.equal(readAutoGoal(dir)?.continuations, 0);
  assert.ok(take(dir));
  assert.equal(readAutoGoal(dir)?.totalContinuations, 2);
}));

test("explicit batch ceiling remains durable", () => fixture(dir => {
  enableAutoGoal("Verify outcomes", dir, AUTO_GOAL_BATCH_LIMIT);
  for (let i = 0; i < AUTO_GOAL_BATCH_LIMIT; i++) assert.ok(take(dir));
  assert.equal(take(dir), null);
  assert.equal(readAutoGoal(dir)?.state, "PAUSED");
  assert.match(readAutoGoal(dir)!.reason!, /budget exhausted/);
}));

test("model-marked completion requests REVIEW rather than silently claiming PASS", () => fixture(dir => {
  enableAutoGoal("Fix scheduler", dir);
  mkdirSync(join(dir, ".future-code"), { recursive: true });
  writeFileSync(join(dir, ".future-code", "goal.md"), "# Fix scheduler\nStatus: completed\n");
  assert.equal(take(dir), null);
  assert.equal(readAutoGoal(dir)?.state, "REVIEW");
  assert.equal(take(dir), null);
}));

test("other/stale completed goals do not stop newly opted-in work", () => fixture(dir => {
  mkdirSync(join(dir, ".future-code"), { recursive: true });
  writeFileSync(join(dir, ".future-code", "goal.md"), "# Old goal\nStatus: completed\n");
  enableAutoGoal("New goal", dir);
  assert.ok(take(dir));
}));

test("corrupt goal state fails closed: cannot cause unbounded model turns", () => fixture(dir => {
  enableAutoGoal("Safe goal", dir);
  writeFileSync(join(dir, ".future-code", "goal-autonomy.json"), '{"schema":1,"state":"ACTIVE"}');
  assert.equal(take(dir), null);
  assert.throws(() => readAutoGoal(dir), /Invalid/);
}));

test("state lives within the designated working directory", () => fixture(dir => {
  enableAutoGoal("Scoped work", dir);
  assert.equal(JSON.parse(readFileSync(join(dir, ".future-code", "goal-autonomy.json"), "utf8")).goal, "Scoped work");
}));

test("explicitly authorized long goals cross the historical 32-turn limit", () => fixture(dir => {
  enableAutoGoal("Long research objective", dir, 64);
  for (let i = 0; i < 40; i++) assert.equal(decideAutoGoalContinuation({
    cwd: dir, mainThread: true, withinTurnBudget: true,
  }).kind, "CONTINUE");
  assert.equal(readAutoGoal(dir)?.state, "ACTIVE");
  assert.equal(readAutoGoal(dir)?.totalContinuations, 40);
}));

test("exhaustion yields visible BLOCKED state and preserves counters", () => fixture(dir => {
  enableAutoGoal("Cost-bounded objective", dir, 2);
  assert.ok(take(dir)); assert.ok(take(dir));
  const decision = decideAutoGoalContinuation({cwd: dir, mainThread: true, withinTurnBudget: true});
  assert.equal(decision.kind, "BLOCKED");
  if (decision.kind === "BLOCKED") assert.match(decision.reason, /budget exhausted/i);
  assert.equal(readAutoGoal(dir)?.totalContinuations, 2);
  assert.equal(readAutoGoal(dir)?.state, "PAUSED");
}));

test("caller limit or API failure is a durable and explicit blocker", () => fixture(dir => {
  enableAutoGoal("Must not silently stop", dir, 100);
  const decision = decideAutoGoalContinuation({cwd: dir, mainThread: true, withinTurnBudget: false});
  assert.equal(decision.kind, "BLOCKED");
  assert.match(readAutoGoal(dir)!.reason!, /max-turns/i);
  resumeAutoGoal(dir);
  assert.match(parkActiveAutoGoal("API temporarily unavailable", dir)!, /API temporarily/);
  assert.equal(take(dir), null);
  assert.equal(readAutoGoal(dir)?.state, "PAUSED");
}));

test("unsafe or corrupt state returns explicit diagnostic without inference", () => fixture(dir => {
  enableAutoGoal("Safe fail closed", dir);
  writeFileSync(join(dir, ".future-code", "goal-autonomy.json"), "{not json");
  const decision = decideAutoGoalContinuation({cwd: dir, mainThread: true, withinTurnBudget: true});
  assert.equal(decision.kind, "BLOCKED");
  if (decision.kind === "BLOCKED") assert.match(decision.reason, /state unavailable/i);
}));

test("invalid explicit limits are rejected; default has no arbitrary turn ceiling", () => fixture(dir => {
  assert.throws(() => enableAutoGoal("Unbounded", dir, Infinity), /limit/);
  assert.throws(() => enableAutoGoal("Too large", dir, MAX_AUTO_GOAL_CONTINUATIONS + 1), /limit/);
  assert.equal(enableAutoGoal("Authorized", dir, 512).maxContinuations, 512);
  assert.equal(enableAutoGoal("Continuous", dir).maxContinuations, null);
}));

test("default goal continues across 32, 64 and 128 turns and survives resume", () => fixture(dir => {
  enableAutoGoal("Long R&D objective", dir);
  for (let i = 0; i < 129; i++) assert.ok(take(dir));
  assert.equal(readAutoGoal(dir)?.state, "ACTIVE");
  assert.equal(readAutoGoal(dir)?.totalContinuations, 129);
  pauseAutoGoal(dir); resumeAutoGoal(dir);
  assert.equal(readAutoGoal(dir)?.maxContinuations, null);
  assert.equal(readAutoGoal(dir)?.totalContinuations, 129);
  assert.ok(take(dir));
}));

test("output styles retain autonomy; children and noninteractive callers cannot control it", () => {
  assert.equal(isAutoGoalMainThread("repl_main_thread"), true);
  assert.equal(isAutoGoalMainThread("repl_main_thread:outputStyle:custom"), true);
  assert.equal(isAutoGoalMainThread("repl_main_thread:outputStyle:learning"), true);
  assert.equal(isAutoGoalMainThread("repl_main_thread", "child"), false);
  assert.equal(isAutoGoalMainThread("repl_main_thread", undefined, true), false);
  assert.equal(isAutoGoalMainThread("sdk"), false);
});

test("a specific unresolved blocker is surfaced; a bare blocked label cannot silently park work", () => fixture(dir => {
  enableAutoGoal("Recover execution", dir);
  const path = join(dir, ".future-code", "goal.md");
  writeFileSync(path, "# Recover execution\nStatus: blocked\n");
  assert.ok(take(dir));
  writeFileSync(path, "# Recover execution\nStatus: blocked\nBlocker: Required executor unavailable after reconnect and health checks\n");
  const decision = decideAutoGoalContinuation({ cwd: dir, mainThread: true, withinTurnBudget: true });
  assert.equal(decision.kind, "BLOCKED");
  if (decision.kind === "BLOCKED") assert.match(decision.reason, /Required executor unavailable/);
  assert.equal(readAutoGoal(dir)?.state, "PAUSED");
}));

