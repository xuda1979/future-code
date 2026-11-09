import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AUTO_GOAL_EXECUTION_POLICY, AUTO_GOAL_BLOCKER_GUIDANCE, decideAutoGoalContinuation,
  enableAutoGoal, pauseAutoGoal, readAutoGoal, recordGoalSteering, supersedeAutoGoal } from "../../src/commands/goal/auto.ts";
import { appendGoalRequestAnchor, goalExecutionPolicy } from "../../src/commands/goal/context.ts";
import { DECISION_GUIDANCE } from "../../src/harness/decisionGuidance.ts";

function fixture(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "goal-delta-"));
  try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}
const next = (cwd: string, promptFormat?: "full" | "delta") => decideAutoGoalContinuation({
  cwd, mainThread: true, withinTurnBudget: true, promptFormat,
});
const meta = (content: string) => ({ type: "user", isMeta: true, message: { content } });

test("invariant guidance is present once while continuation deltas stay small", () => fixture(cwd => {
  enableAutoGoal("Implement reliable task recovery", cwd);
  const policy = goalExecutionPolicy(true, cwd)!;
  assert.ok(policy.includes(DECISION_GUIDANCE));
  assert.ok(policy.includes(AUTO_GOAL_BLOCKER_GUIDANCE));
  const full = next(cwd);
  const delta = next(cwd, "delta");
  assert.equal(full.kind, "CONTINUE"); assert.equal(delta.kind, "CONTINUE");
  if (full.kind !== "CONTINUE" || delta.kind !== "CONTINUE") return;
  assert.ok(full.prompt.includes(DECISION_GUIDANCE), "other callers retain complete standalone guidance");
  assert.ok(delta.prompt.length < full.prompt.length / 8);
  assert.doesNotMatch(delta.prompt, /Historical objective|Implement reliable task recovery/);
  assert.equal(readAutoGoal(cwd)?.continuations, 2);
}));

test("objective and steering changes affect the fresh tail, not the invariant prefix", () => fixture(cwd => {
  enableAutoGoal("Implement reliable task recovery", cwd);
  const policy = goalExecutionPolicy(true, cwd)!;
  const history = [meta("original human request")];
  const project = () => appendGoalRequestAnchor(history, { mainThread: true, cwd, makeMessage: meta,
    executionPolicy: goalExecutionPolicy(true, cwd) });
  const first = project();
  recordGoalSteering("Preserve independent checks", cwd);
  const steered = project();
  assert.equal(steered[0]!.message.content, policy);
  assert.match(steered.at(-1)!.message.content, /Preserve independent checks/);
  supersedeAutoGoal("Build the operator dashboard", cwd);
  const replaced = project();
  assert.equal(replaced[0]!.message.content, first[0]!.message.content);
  assert.match(replaced.at(-1)!.message.content, /Build the operator dashboard/);
  assert.equal(replaced[1], history[0]);
  assert.equal(history.length, 1);
}));

test("healthy reasoning is not forced into a checkpoint rewrite after many continuations", () => fixture(cwd => {
  enableAutoGoal("Research the scheduler architecture", cwd);
  for (let i = 0; i < 8; i++) {
    const delta = next(cwd, "delta");
    assert.equal(delta.kind, "CONTINUE");
    if (delta.kind === "CONTINUE") assert.ok(delta.prompt.length < 256);
  }
  assert.match(AUTO_GOAL_EXECUTION_POLICY, /preserve useful deep reasoning and healthy running jobs/);
  assert.equal(readAutoGoal(cwd)?.stagnantContinuations, 8);
}));

test("compact continuations preserve concrete drift recovery guidance and budget boundaries", () => fixture(cwd => {
  enableAutoGoal("Repair task recovery", cwd, 1);
  writeFileSync(join(cwd, ".future-code/goal.md"), "# Unrelated task\nStatus: completed\n");
  const delta = next(cwd, "delta");
  assert.equal(delta.kind, "CONTINUE");
  if (delta.kind === "CONTINUE") assert.match(delta.prompt, /OBJECTIVE DRIFT DETECTED/);
  assert.equal(next(cwd, "delta").kind, "BLOCKED");
  assert.equal(readAutoGoal(cwd)?.state, "PAUSED");
  assert.equal(readAutoGoal(cwd)?.continuations, 1);
}));

test("no-goal, paused, child and SDK requests cannot acquire an execution policy", () => fixture(cwd => {
  assert.equal(goalExecutionPolicy(true, cwd), null);
  enableAutoGoal("Repair scheduler", cwd);
  assert.equal(goalExecutionPolicy(false, cwd), null);
  pauseAutoGoal(cwd);
  assert.equal(goalExecutionPolicy(true, cwd), null);
  const history = [meta("request")];
  const projected = appendGoalRequestAnchor(history, { mainThread: true, cwd, makeMessage: meta,
    executionPolicy: AUTO_GOAL_EXECUTION_POLICY });
  assert.equal(projected.length, 2);
  assert.match(projected.at(-1)!.message.content, /Automatic work is paused/);
  writeFileSync(join(cwd, ".future-code/goal-autonomy.json"), "corrupt state");
  assert.equal(goalExecutionPolicy(false, cwd), null);
  assert.throws(() => goalExecutionPolicy(true, cwd), /JSON/);
}));

test("compact-mode completion still requests REVIEW rather than bypassing independent acceptance", () => fixture(cwd => {
  enableAutoGoal("Repair scheduler recovery", cwd);
  writeFileSync(join(cwd, ".future-code/goal.md"), "# Repair scheduler recovery\nStatus: completed\n");
  assert.equal(next(cwd, "delta").kind, "BLOCKED");
  assert.equal(readAutoGoal(cwd)?.state, "REVIEW");
}));
