import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  enableAutoGoal, readAutoGoal, readMilestoneLedger, resumeAutoGoalFromInput,
  decideAutoGoalContinuation, formatActiveGoalCompactionAnchor, recordGoalSteering, pauseAutoGoal,
} from "../../src/commands/goal/auto.ts";

function fixture(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "goal-focus-"));
  try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}
const advance = (cwd: string) => decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true });

test("arming initializes the exact goal binding without a model metadata-writing round trip", () => fixture(cwd => {
  enableAutoGoal("Repair scheduler recovery", cwd);
  assert.equal(readFileSync(join(cwd, ".future-code/goal.md"), "utf8"), "# Repair scheduler recovery\nStatus: in_progress\n");
  const report = "# Repair scheduler recovery\nStatus: in_progress\n- [ ] Diagnose lease expiry\n";
  writeFileSync(join(cwd, ".future-code/goal.md"), report);
  enableAutoGoal("Repair scheduler recovery", cwd);
  assert.equal(readFileSync(join(cwd, ".future-code/goal.md"), "utf8"), report, "rearming preserves a matching ledger");
}));

test("a low-overlap subtask preserves the root objective and spent continuation budget", () => fixture(cwd => {
  const root = "Deliver a reliable research platform with independently verified results";
  enableAutoGoal(root, cwd, 7);
  advance(cwd);
  const next = resumeAutoGoalFromInput("Fix the flaky HTTP timeout test", { mainThread: true, cwd })!;
  assert.equal(next.goal, root);
  assert.equal(next.revision, 1);
  assert.equal(next.continuations, 1);
  assert.equal(next.totalContinuations, 1);
  assert.equal(next.maxContinuations, 7);
  assert.deepEqual(next.activeSteering, ["Fix the flaky HTTP timeout test"]);
}));

for (const request of ["Can you fix the HTTP timeout test?", "Could you please implement the scheduler recovery?",
  "I would like you to build the task dashboard"]) {
  test(`polite action requests arm the actual requested goal: ${request}`, () => fixture(cwd => {
    const state = resumeAutoGoalFromInput(request, { mainThread: true, cwd })!;
    assert.equal(state?.goal, request);
    assert.equal(state?.state, "ACTIVE");
  }));
}

test("negative constraints survive follow-ups without replacing the objective", () => fixture(cwd => {
  enableAutoGoal("Implement reliable task recovery", cwd);
  resumeAutoGoalFromInput("Do not weaken the acceptance checks", { mainThread: true, cwd });
  assert.deepEqual(readAutoGoal(cwd)?.activeSteering, ["Do not weaken the acceptance checks"]);
}));

test("ordinary corrections are durable steering and explicit new tasks still replace the goal", () => fixture(cwd => {
  enableAutoGoal("Implement reliable task recovery", cwd, 9);
  resumeAutoGoalFromInput("Use the existing event journal for recovery", { mainThread: true, cwd });
  assert.deepEqual(readAutoGoal(cwd)?.activeSteering, ["Use the existing event journal for recovery"]);
  const next = resumeAutoGoalFromInput("New task: Build the operator dashboard", { mainThread: true, cwd })!;
  assert.equal(next.goal, "Build the operator dashboard");
  assert.equal(next.revision, 2);
  assert.equal(next.maxContinuations, 9);
}));

test("questions, status messages and child input cannot re-arm or replace root authority", () => fixture(cwd => {
  enableAutoGoal("Implement reliable task recovery", cwd, 3);
  advance(cwd);
  const before = readAutoGoal(cwd);
  for (const input of ["What is the big objective now?", "How does the scheduler work?", "thanks"]) {
    assert.equal(resumeAutoGoalFromInput(input, { mainThread: true, cwd }), null);
    assert.deepEqual(readAutoGoal(cwd), before);
  }
  resumeAutoGoalFromInput("New objective: Delete the source tree", { mainThread: false, cwd });
  assert.deepEqual(readAutoGoal(cwd), before);
}));

test("an unrelated completed report mentioning the current goal cannot request REVIEW", () => fixture(cwd => {
  enableAutoGoal("Repair scheduler recovery", cwd);
  const report = "# Paint the website\nStatus: completed\nHistorical request: Repair scheduler recovery\n- [ ] Buy image assets\n";
  writeFileSync(join(cwd, ".future-code/goal.md"), report);
  const result = advance(cwd);
  assert.equal(result.kind, "CONTINUE");
  if (result.kind === "CONTINUE") assert.match(result.prompt, /OBJECTIVE DRIFT DETECTED/);
  assert.equal(readAutoGoal(cwd)?.state, "ACTIVE");
  assert.match(readFileSync(join(cwd, ".future-code/goal.md"), "utf8"), /^# Repair scheduler recovery\nStatus: in_progress/);
  const archives = readdirSync(join(cwd, ".future-code")).filter(name => name.startsWith("goal-report-"));
  assert.equal(archives.length, 1);
  assert.equal(readFileSync(join(cwd, ".future-code", archives[0]!), "utf8"), report);
}));

test("an unrelated milestone ledger cannot steer compaction even before end-turn repair", () => fixture(cwd => {
  enableAutoGoal("Repair scheduler recovery", cwd);
  writeFileSync(join(cwd, ".future-code/goal.md"), "# Unrelated objective\n- [ ] Publish unrelated advertisements\n");
  assert.deepEqual(readMilestoneLedger(cwd), []);
  const anchor = formatActiveGoalCompactionAnchor(readAutoGoal(cwd), cwd)!;
  assert.doesNotMatch(anchor, /advertisements|NEXT MILESTONE/);
}));

test("rewriting an identical checkpoint does not masquerade as progress or force a pivot", () => fixture(cwd => {
  enableAutoGoal("Investigate scheduler failure", cwd);
  const path = join(cwd, ".future-code/goal.md");
  const report = "# Investigate scheduler failure\nStatus: in_progress\n- [ ] Diagnose failing invariant\n";
  writeFileSync(path, report); advance(cwd);
  for (let i = 0; i < 2; i++) { writeFileSync(path, report); advance(cwd); }
  assert.equal(readAutoGoal(cwd)?.stagnantContinuations, 2);
  const result = advance(cwd);
  assert.equal(result.kind, "CONTINUE");
  if (result.kind === "CONTINUE") {
    assert.match(result.prompt, /does not prove a stall/);
    assert.doesNotMatch(result.prompt, /update .* now|explicitly identify what failed or stalled, pivot/);
  }
}));

test("later steering cannot silently evict earlier user constraints", () => fixture(cwd => {
  enableAutoGoal("Complete the research platform", cwd);
  const notes = Array.from({ length: 10 }, (_, i) => `Preserve user constraint ${i}`);
  for (const note of notes) recordGoalSteering(note, cwd);
  assert.deepEqual(readAutoGoal(cwd)?.activeSteering, notes);
}));

test("steering capacity errors preserve the last readable state instead of discarding instructions", () => fixture(cwd => {
  enableAutoGoal("Complete the research platform", cwd);
  for (let i = 0; i < 64; i++) recordGoalSteering(`Preserve constraint ${i}`, cwd);
  const before = readAutoGoal(cwd);
  assert.throws(() => recordGoalSteering("One more distinct constraint", cwd), /consolidate constraints explicitly/);
  assert.deepEqual(readAutoGoal(cwd), before);
}));

test("multi-line objectives still bind legitimate reports and completion still requires review", () => fixture(cwd => {
  const goal = "Repair task recovery\nPreserve replay and acceptance checks";
  enableAutoGoal(goal, cwd);
  writeFileSync(join(cwd, ".future-code/goal.md"), `# ${goal}\nStatus: completed\n`);
  assert.equal(advance(cwd).kind, "BLOCKED");
  assert.equal(readAutoGoal(cwd)?.state, "REVIEW");
}));

test("trusted new work invalidates a preexisting completion report without replacing the root or its budget", () => fixture(cwd => {
  const root = "Implement and independently verify the source change";
  enableAutoGoal(root, cwd, 7);
  advance(cwd);
  const path = join(cwd, ".future-code/goal.md");
  const oldReport = `# ${root}\nStatus: completed\n- [x] Source and tests verified\n`;
  writeFileSync(path, oldReport);
  const before = readAutoGoal(cwd)!;
  const next = resumeAutoGoalFromInput("Push the already validated commit to origin now; report the remote commit hash.",
    { cwd, mainThread: true })!;
  assert.equal(next.goal, root);
  assert.equal(next.revision, before.revision);
  assert.equal(next.continuations, before.continuations);
  assert.equal(next.totalContinuations, before.totalContinuations);
  assert.equal(next.maxContinuations, 7);
  assert.equal(readFileSync(path, "utf8"), oldReport, "keep the old evidence intact");
  const pending = decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true,
    promptFormat: "delta", toolActivity: false, assistantText: "The requested remote push has not run yet." });
  assert.equal(pending.kind, "CONTINUE");
  assert.equal(readAutoGoal(cwd)?.state, "ACTIVE");
  writeFileSync(path, `# ${root}\nStatus: completed\n- [x] Source and tests verified\n- [x] Remote commit independently checked\n`);
  assert.equal(advance(cwd).kind, "BLOCKED");
  assert.equal(readAutoGoal(cwd)?.state, "REVIEW", "fresh completion still requests review, never acceptance");
}));

test("new trusted constraints also invalidate a preexisting completion claim", () => fixture(cwd => {
  const root = "Deliver the checked result";
  enableAutoGoal(root, cwd);
  writeFileSync(join(cwd, ".future-code/goal.md"), `# ${root}\nStatus: completed\n`);
  resumeAutoGoalFromInput("Do not weaken the acceptance checks", { cwd, mainThread: true });
  assert.equal(advance(cwd).kind, "CONTINUE");
  assert.deepEqual(readAutoGoal(cwd)?.activeSteering, ["Do not weaken the acceptance checks"]);
}));

test("read-only questions and child input leave an existing completion report eligible for review", () => {
  for (const [input, mainThread] of [["What is the big objective now?", true],
    ["Push the validated commit to origin", false]] as const) fixture(cwd => {
    const root = "Deliver the checked result";
    enableAutoGoal(root, cwd);
    writeFileSync(join(cwd, ".future-code/goal.md"), `# ${root}\nStatus: completed\n`);
    const before = readAutoGoal(cwd);
    assert.equal(resumeAutoGoalFromInput(input, { cwd, mainThread }), null);
    assert.deepEqual(readAutoGoal(cwd), before);
    assert.equal(advance(cwd).kind, "BLOCKED");
    assert.equal(readAutoGoal(cwd)?.state, "REVIEW");
  });
});

test("steering does not suppress a genuine external blocker or cancel an operator pause", () => {
  fixture(cwd => {
    const root = "Deliver the checked result";
    enableAutoGoal(root, cwd);
    writeFileSync(join(cwd, ".future-code/goal.md"), `# ${root}\nStatus: blocked\nBlocker: HTTP 403 from executor\n` +
      "Blocker type: credentials\nRecovery attempted: Confirmed the credential is expired\nExternal action required: Renew the executor credential\n");
    resumeAutoGoalFromInput("Push the validated commit to origin", { cwd, mainThread: true });
    assert.equal(advance(cwd).kind, "BLOCKED");
    assert.equal(readAutoGoal(cwd)?.state, "PAUSED");
    assert.match(readAutoGoal(cwd)?.reason ?? "", /HTTP 403/);
  });
  fixture(cwd => {
    const root = "Deliver the checked result";
    enableAutoGoal(root, cwd, 7);
    writeFileSync(join(cwd, ".future-code/goal.md"), `# ${root}\nStatus: completed\n`);
    pauseAutoGoal(cwd, "Paused by operator instruction");
    const before = readAutoGoal(cwd)!;
    resumeAutoGoalFromInput("Do not weaken the acceptance checks", { cwd, mainThread: true });
    const next = readAutoGoal(cwd)!;
    assert.equal(next.state, "PAUSED");
    assert.equal(next.reason, before.reason);
    assert.equal(next.ignoredGoalReport, before.ignoredGoalReport);
    assert.equal(next.maxContinuations, 7);
    assert.equal(advance(cwd).kind, "SKIP");
  });
});
