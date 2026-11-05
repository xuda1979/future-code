import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DECISION_GUIDANCE } from "../../src/harness/decisionGuidance.ts";
import {
  enableAutoGoal, pauseAutoGoal, readAutoGoal, resumeAutoGoal,
  takeAutoGoalContinuation, decideAutoGoalContinuation, parkActiveAutoGoal, AUTO_GOAL_BATCH_LIMIT, MAX_AUTO_GOAL_CONTINUATIONS,
  isAutoGoalMainThread,
  shouldPauseGoalAfterTerminal,
  resumeAutoGoalFromInput,
  supersedeAutoGoal,
  recordGoalSteering,
  classifyGoalHorizon,
  formatActiveGoalCompactionAnchor,
  extractExplicitNewObjective,
  parseMilestoneLedger,
  readMilestoneLedger,
  nextOpenMilestone,
} from "../../src/commands/goal/auto.ts";

function fixture(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "goal-auto-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const take = (cwd: string) => takeAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true });

test("goal continuations ask for decision-relevant evidence within the existing turn", () => fixture(dir => {
  enableAutoGoal("Improve a research result", dir);
  const prompt = take(dir)!;
  assert.match(prompt, /uncertainty that could change the next action/);
  assert.match(prompt, /different outcomes/);
  assert.match(prompt, /reconcile existing external work/);
  assert.equal(readAutoGoal(dir)?.totalContinuations, 1);
}));

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
  assert.ok(take(dir)?.includes(DECISION_GUIDANCE), "continuations preserve the early-evaluation decision discipline");
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

test("implementation failures and incomplete blocker reports keep the goal active", () => fixture(dir => {
  enableAutoGoal("Recover execution", dir);
  const path = join(dir, ".future-code", "goal.md");
  for (const report of ["", "Blocker: Tests still fail", "Blocker: Required executor unavailable",
    "Blocker: Tests fail\nBlocker type: implementation\nRecovery attempted: Ran tests\nExternal action required: Fix code",
    "Blocker: Provider offline\nBlocker type: provider\nRecovery attempted: Reconnected",
    "Blocker:\nBlocker type: hardware\nRecovery attempted:\nExternal action required: Restore power"]) {
    writeFileSync(path, "# Recover execution\nStatus: blocked\n" + report + "\n");
    assert.match(take(dir)!, /continue all work that remains possible/);
    assert.equal(readAutoGoal(dir)?.state, "ACTIVE");
  }
  assert.equal(readAutoGoal(dir)?.totalContinuations, 6);
}));

test("external blockers display the actual error, attempted recovery and required external action", () => fixture(dir => {
  enableAutoGoal("Recover execution", dir);
  const path = join(dir, ".future-code", "goal.md");
  writeFileSync(path, "# Recover execution\nStatus: blocked\n" +
    "Blocker: Required executor unavailable: device offline\nBlocker type: hardware\n" +
    "Recovery attempted: Reconnected and checked the device; still offline\n" +
    "External action required: Restore power to the executor\n");
  const decision = decideAutoGoalContinuation({ cwd: dir, mainThread: true, withinTurnBudget: true });
  assert.equal(decision.kind, "BLOCKED");
  if (decision.kind === "BLOCKED") {
    assert.match(decision.reason, /Required executor unavailable: device offline/);
    assert.match(decision.reason, /Reconnected and checked the device/);
    assert.match(decision.reason, /Restore power to the executor/);
  }
  assert.equal(readAutoGoal(dir)?.reason, decision.kind === "BLOCKED" ? decision.reason : null);
  assert.equal(readAutoGoal(dir)?.state, "PAUSED");
  assert.equal(readAutoGoal(dir)?.totalContinuations, 0);
}));

test("plain continue resumes a paused goal once with its existing budget and lifetime counter", () => fixture(dir => {
  enableAutoGoal("Finish verified work", dir, 3);
  take(dir);
  pauseAutoGoal(dir, "Model API unavailable");
  assert.equal(resumeAutoGoalFromInput("continue", { mainThread: false, cwd: dir }), null);
  assert.equal(resumeAutoGoalFromInput("explain the continue statement", { mainThread: true, cwd: dir }), null);
  const state = resumeAutoGoalFromInput("continue", { mainThread: true, cwd: dir })!;
  assert.equal(state.state, "ACTIVE");
  assert.equal(state.maxContinuations, 3);
  assert.equal(state.totalContinuations, 1);
  assert.equal(state.continuations, 0);
  take(dir);
  assert.equal(resumeAutoGoalFromInput("continue", { mainThread: true, cwd: dir }), null);
  assert.equal(readAutoGoal(dir)?.continuations, 1, "a second continue cannot reset an active batch");
}));

test("resume ignores the acknowledged blocker file but a fresh failure still blocks", () => fixture(dir => {
  enableAutoGoal("Recover executor", dir);
  const path = join(dir, ".future-code", "goal.md");
  const report = "# Recover executor\nStatus: blocked\nBlocker: Executor offline\nBlocker type: hardware\n" +
    "Recovery attempted: Reconnected and probed device health\nExternal action required: Restore device power\n";
  writeFileSync(path, report);
  assert.equal(decideAutoGoalContinuation({ cwd: dir, mainThread: true, withinTurnBudget: true }).kind, "BLOCKED");
  resumeAutoGoalFromInput("continue", { mainThread: true, cwd: dir });
  assert.match(readAutoGoal(dir)!.ignoredGoalReport!, /^[a-f0-9]{64}$/);
  assert.ok(take(dir), "the old blocker must not immediately pause the resumed goal");
  writeFileSync(path, report + "\nFresh probe: executor remains offline\n");
  assert.equal(decideAutoGoalContinuation({ cwd: dir, mainThread: true, withinTurnBudget: true }).kind, "BLOCKED");
  assert.equal(readAutoGoal(dir)?.totalContinuations, 1);
}));


test("telling future-code a new objective supersedes the old objective and prevents drift in continuations and goal.md", () => fixture(dir => {
  enableAutoGoal("Build legacy XML parser", dir);
  mkdirSync(join(dir, ".future-code"), { recursive: true });
  writeFileSync(join(dir, ".future-code", "goal.md"), "# Build legacy XML parser\nStatus: in_progress\n");
  take(dir);
  assert.equal(readAutoGoal(dir)?.totalContinuations, 1);

  const updated = resumeAutoGoalFromInput(
    "New objective: Implement distributed raft consensus engine and pass all tests",
    { mainThread: true, cwd: dir },
  )!;
  assert.ok(updated);
  assert.equal(updated.goal, "Implement distributed raft consensus engine and pass all tests");
  assert.equal(updated.previousGoal, "Build legacy XML parser");
  assert.equal(updated.revision, 2);
  assert.equal(updated.continuations, 0);
  assert.equal(updated.state, "ACTIVE");
  assert.equal(updated.transition, "superseded");

  // Verify stale .future-code/goal.md was immediately overwritten with the new objective
  const goalMd = readFileSync(join(dir, ".future-code", "goal.md"), "utf8");
  assert.match(goalMd, /# Implement distributed raft consensus engine and pass all tests/);
  assert.match(goalMd, /Supersedes: Build legacy XML parser/);

  // Verify continuation prompt locks onto the new objective and warns against drifting back
  const prompt = take(dir)!;
  assert.match(prompt, /Goal: Implement distributed raft consensus engine and pass all tests/);
  assert.match(prompt, /Anti-drift lock \(Revision 2\): Current objective supersedes \[Build legacy XML parser\]/);
}));

test("model drifting back to a superseded objective in goal.md is detected, repaired, and corrected automatically", () => fixture(dir => {
  enableAutoGoal("Old objective: migrate v1 database", dir);
  supersedeAutoGoal("New objective: build WebGPU compute shader pipeline", dir);

  // Simulate the model drifting and writing the old objective back into .future-code/goal.md
  writeFileSync(
    join(dir, ".future-code", "goal.md"),
    "# Old objective: migrate v1 database\nStatus: completed\n",
  );

  // Must NOT transition to REVIEW on the drifted objective; must detect drift, repair goal.md, and continue!
  const decision = decideAutoGoalContinuation({ cwd: dir, mainThread: true, withinTurnBudget: true });
  assert.equal(decision.kind, "CONTINUE");
  if (decision.kind === "CONTINUE") {
    assert.match(decision.prompt, /OBJECTIVE DRIFT DETECTED/);
    assert.match(decision.prompt, /New objective: build WebGPU compute shader pipeline/);
  }
  assert.equal(readAutoGoal(dir)?.state, "ACTIVE");
  const repairedMd = readFileSync(join(dir, ".future-code", "goal.md"), "utf8");
  assert.match(repairedMd, /# New objective: build WebGPU compute shader pipeline/);
  assert.match(repairedMd, /Status: in_progress/);
}));

test("actionable user directives automatically arm or supersede objectives while preserving mid-flight steering constraints", () => fixture(dir => {
  // 1. Auto-arming when no goal exists yet
  const armed = resumeAutoGoalFromInput(
    "Implement end-to-end authentication flow and verify all unit tests pass",
    { mainThread: true, cwd: dir },
  )!;
  assert.ok(armed);
  assert.equal(armed.state, "ACTIVE");
  assert.equal(armed.transition, "armed");
  assert.equal(armed.goal, "Implement end-to-end authentication flow and verify all unit tests pass");

  // 2. Mid-flight steering on the same objective records constraints without losing the core objective
  const steered = resumeAutoGoalFromInput(
    "Also make sure authentication tokens expire after 15 minutes",
    { mainThread: true, cwd: dir },
  )!;
  assert.ok(steered);
  assert.equal(steered.transition, "steered");
  assert.equal(steered.goal, "Implement end-to-end authentication flow and verify all unit tests pass");
  assert.deepEqual(steered.activeSteering, ["Also make sure authentication tokens expire after 15 minutes"]);

  const continuation = take(dir)!;
  assert.match(continuation, /Active user constraints: Also make sure authentication tokens expire after 15 minutes/);

  // 3. A distinct actionable directive supersedes the old objective automatically
  const pivoted = resumeAutoGoalFromInput(
    "Refactor the billing invoice PDF generator and add regression tests",
    { mainThread: true, cwd: dir },
  )!;
  assert.ok(pivoted);
  assert.equal(pivoted.transition, "superseded");
  assert.equal(pivoted.goal, "Refactor the billing invoice PDF generator and add regression tests");
  assert.equal(pivoted.previousGoal, "Implement end-to-end authentication flow and verify all unit tests pass");
}));

test("self-recoverable code/test blockers and 'say continue' excuses are rejected so execution continues automatically", () => fixture(dir => {
  enableAutoGoal("Ship verified compiler optimization", dir);
  const path = join(dir, ".future-code", "goal.md");

  for (const fakeBlocker of [
    "# Ship verified compiler optimization\nStatus: blocked\nBlocker: Unit tests failed in optimizer\nBlocker type: external_dependency\nRecovery attempted: Ran test suite once\nExternal action required: Fix the failing test in src/opt.ts\n",
    "# Ship verified compiler optimization\nStatus: blocked\nBlocker: Need confirmation\nBlocker type: permissions\nRecovery attempted: Checked files\nExternal action required: Please say continue to proceed\n",
    "# Ship verified compiler optimization\nStatus: blocked\nBlocker: Build failed\nBlocker type: resources\nRecovery attempted: none\nExternal action required: Edit file and recompile\n",
  ]) {
    writeFileSync(path, fakeBlocker);
    const decision = decideAutoGoalContinuation({ cwd: dir, mainThread: true, withinTurnBudget: true });
    assert.equal(decision.kind, "CONTINUE", "recoverable blocker must not pause autonomous execution");
    if (decision.kind === "CONTINUE") {
      assert.match(decision.prompt, /continue all work that remains possible/);
    }
    assert.equal(readAutoGoal(dir)?.state, "ACTIVE");
  }
}));

test("dual-horizon classification, stagnation escalation, and compaction anchor preserve long and short project alignment", () => fixture(dir => {
  assert.equal(classifyGoalHorizon("Fix typo in README"), "short");
  assert.equal(classifyGoalHorizon("Redesign the distributed scheduler architecture and run end-to-end benchmark suite"), "long");

  enableAutoGoal("Fix typo in README", dir);
  recordGoalSteering("Keep markdown formatting clean", dir);
  supersedeAutoGoal("Redesign the distributed scheduler architecture and run end-to-end benchmark suite", dir);

  const p1 = take(dir)!;
  assert.match(p1, /Long-horizon project mode/);
  const p2 = take(dir)!;
  assert.match(p2, /Stagnation recovery \(2 turns without a \.future-code\/goal\.md update\)/);

  const anchor = formatActiveGoalCompactionAnchor(readAutoGoal(dir))!;
  assert.match(anchor, /ACTIVE OBJECTIVE: Redesign the distributed scheduler architecture and run end-to-end benchmark suite/);
  assert.match(anchor, /SUPERSEDED HISTORICAL OBJECTIVES \(DO NOT DRIFT BACK TO THESE\): Fix typo in README/);
  assert.ok(extractExplicitNewObjective("Instead of fixing typos, build the new telemetry service"));
}));

// ─── Milestone ledger ────────────────────────────────────────────────────────

test("parseMilestoneLedger extracts checked and unchecked checkboxes", () => {
  const text = [
    "# Fix notation",
    "Status: in_progress",
    "## Milestones",
    "- [ ] Fix L clash between range and lattice",
    "- [x] Replace separator sentence — evidence: review_update.md §2",
    "* [ ] State Theorem 3.2 with distinct lattice constant",
    "Some prose in between that is not a milestone.",
    "1. [x] Done numbered item",
  ].join("\n");
  const ledger = parseMilestoneLedger(text);
  assert.equal(ledger.length, 4);
  assert.equal(ledger[0]!.done, false);
  assert.equal(ledger[1]!.done, true);
  assert.match(ledger[1]!.text, /separator sentence/);
  assert.equal(ledger[3]!.done, true);
  assert.equal(ledger[3]!.index, 4);
});

test("parseMilestoneLedger deduplicates identical items and skips oversized ones", () => {
  const text = [
    "- [ ] same item",
    "- [ ] same item",
    `- [ ] ${"x".repeat(600)}`,
  ].join("\n");
  const ledger = parseMilestoneLedger(text);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.text, "same item");
});

test("nextOpenMilestone returns the first unchecked item in ledger order", () => {
  const ledger = parseMilestoneLedger([
    "- [x] one",
    "- [ ] two",
    "- [x] three",
    "- [ ] four",
  ].join("\n"));
  const next = nextOpenMilestone(ledger);
  assert.ok(next);
  assert.equal(next.index, 2);
  assert.equal(next.text, "two");
});

test("nextOpenMilestone returns null when all milestones are done", () => {
  const ledger = parseMilestoneLedger("- [x] a\n- [x] b");
  assert.equal(nextOpenMilestone(ledger), null);
});

test("nextOpenMilestone returns null for an empty ledger", () => {
  assert.equal(nextOpenMilestone([]), null);
});

test("readMilestoneLedger reads from .future-code/goal.md on disk", () => fixture(dir => {
  enableAutoGoal("Revise quantum LDPC paper", dir);
  mkdirSync(join(dir, ".future-code"), { recursive: true });
  writeFileSync(join(dir, ".future-code", "goal.md"), [
    "# Revise quantum LDPC paper",
    "Status: in_progress",
    "## Milestones",
    "- [x] Define geometric locality precisely",
    "- [ ] Add coarse-graining derivation with tracked constants",
    "- [ ] Reposition novelty for D>2 or retitle as exposition",
  ].join("\n") + "\n");
  const ledger = readMilestoneLedger(dir);
  assert.equal(ledger.length, 3);
  const next = nextOpenMilestone(ledger);
  assert.ok(next);
  assert.equal(next.text, "Add coarse-graining derivation with tracked constants");
}));

test("compaction anchor surfaces milestone frontier when a ledger exists", () => fixture(dir => {
  enableAutoGoal("Finish A1 paper revision", dir);
  mkdirSync(join(dir, ".future-code"), { recursive: true });
  writeFileSync(join(dir, ".future-code", "goal.md"), [
    "# Finish A1 paper revision",
    "Status: in_progress",
    "## Milestones",
    "- [x] item one",
    "- [ ] item two",
    "- [ ] item three",
  ].join("\n") + "\n");
  const anchor = formatActiveGoalCompactionAnchor(readAutoGoal(dir), dir)!;
  assert.match(anchor, /MILESTONE LEDGER: 1\/3 complete\./);
  assert.match(anchor, /NEXT MILESTONE \(#2\): item two/);
}));

test("compaction anchor omits ledger line when no milestones exist", () => fixture(dir => {
  enableAutoGoal("Plain short goal", dir);
  const anchor = formatActiveGoalCompactionAnchor(readAutoGoal(dir))!;
  assert.ok(!/MILESTONE LEDGER/.test(anchor));
}));
