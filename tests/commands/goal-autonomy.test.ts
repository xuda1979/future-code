import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enableAutoGoal, pauseAutoGoal, readAutoGoal, resumeAutoGoal,
  takeAutoGoalContinuation, AUTO_GOAL_BATCH_LIMIT,
} from "../../src/commands/goal/auto.ts";

function fixture(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "goal-auto-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const take = (cwd: string) => takeAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true });

test("opt-in only; SDK/subagents and explicit turn ceilings never auto-continue", () => fixture(dir => {
  assert.equal(take(dir), null);
  enableAutoGoal("Build verified demo", dir);
  assert.equal(takeAutoGoalContinuation({ cwd: dir, mainThread: false, withinTurnBudget: true }), null);
  assert.equal(takeAutoGoalContinuation({ cwd: dir, mainThread: true, withinTurnBudget: false }), null);
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

test("unfinished goal automatically pauses at bounded batch ceiling", () => fixture(dir => {
  enableAutoGoal("Verify outcomes", dir);
  for (let i = 0; i < AUTO_GOAL_BATCH_LIMIT; i++) assert.ok(take(dir));
  assert.equal(take(dir), null);
  assert.equal(readAutoGoal(dir)?.state, "PAUSED");
  assert.match(readAutoGoal(dir)!.reason!, /budget reached/);
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
