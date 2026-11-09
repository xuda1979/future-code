import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendGoalRequestAnchor, compactGoalContinuations } from "../../src/commands/goal/context.ts";
import { enableAutoGoal, pauseAutoGoal, readAutoGoal, recordGoalSteering, supersedeAutoGoal,
  takeAutoGoalContinuation } from "../../src/commands/goal/auto.ts";

interface Message { type: string; isMeta?: boolean; origin?: string; message?: { content: any } }
const meta = (content: string): Message => ({ type: "user", isMeta: true, message: { content } });
function fixture(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "goal-context-"));
  try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}
const view = (messages: Message[], cwd: string) => appendGoalRequestAnchor(messages, {
  cwd, mainThread: true, makeMessage: meta,
});

test("the next API payload reflects current authority after steering, replacement and pause", () => fixture(cwd => {
  enableAutoGoal("Repair the task scheduler", cwd);
  const history = [{ type: "user", message: { content: "What is the big objective now?" } }];
  const snapshot = structuredClone(history);
  const first = view(history, cwd);
  assert.match(first.at(-1)!.message!.content, /Repair the task scheduler/);
  recordGoalSteering("Preserve independent verification", cwd);
  assert.match(view(history, cwd).at(-1)!.message!.content, /Preserve independent verification/);
  supersedeAutoGoal("Build a documentation search engine", cwd);
  const next = view(history, cwd).at(-1)!.message!.content;
  assert.match(next, /Revision 2; ACTIVE/);
  assert.match(next, /Build a documentation search engine/);
  assert.doesNotMatch(next, /Repair the task scheduler|Preserve independent verification/);
  pauseAutoGoal(cwd);
  assert.match(view(history, cwd).at(-1)!.message!.content, /Automatic work is paused/);
  assert.deepEqual(history, snapshot);
}));

test("an ephemeral anchor never accumulates in the durable conversation or spends a continuation", () => fixture(cwd => {
  enableAutoGoal("Implement task recovery", cwd, 8);
  const history: Message[] = [{ type: "assistant", message: { content: [{ type: "tool_use", id: "read-1" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "actual evidence" }] } }];
  for (let i = 0; i < 100; i++) {
    const projected = view(history, cwd);
    assert.equal(projected.length, 3);
    assert.equal(projected[0], history[0]);
    assert.equal(projected[1], history[1]);
  }
  assert.equal(history.length, 2);
  assert.equal(readAutoGoal(cwd)?.continuations, 0);
}));

test("child/SDK requests never read or inherit interactive root state; corrupt main state fails visibly", () => fixture(cwd => {
  const history: Message[] = [meta("task-specific child instructions")];
  assert.equal(view(history, cwd), history);
  enableAutoGoal("Repair scheduler", cwd);
  writeFileSync(join(cwd, ".future-code/goal-autonomy.json"), "corrupt state");
  assert.equal(appendGoalRequestAnchor(history, { mainThread: false, cwd, makeMessage: meta }), history);
  assert.throws(() => view(history, cwd), /JSON/);
}));

test("unbound milestones never enter fresh request anchors", () => fixture(cwd => {
  enableAutoGoal("Repair scheduler", cwd);
  writeFileSync(join(cwd, ".future-code/goal.md"), "# Unrelated goal\n- [ ] Publish unrelated content\n");
  assert.doesNotMatch(view([], cwd)[0]!.message!.content, /Publish unrelated content/);
  writeFileSync(join(cwd, ".future-code/goal.md"), "# Repair scheduler\n- [ ] Reproduce lease expiry\n");
  assert.match(view([], cwd)[0]!.message!.content, /Unverified milestone frontier.*Reproduce lease expiry/);
}));

test("continuation projection keeps every human message and tool pair and the latest recovery directive", () => fixture(cwd => {
  enableAutoGoal("Repair scheduler", cwd);
  const first = meta(takeAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true })!);
  const latest = meta(takeAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true })!);
  const human = { ...first, isMeta: false };
  const child = { ...first, origin: "child" };
  const tool = { type: "user", isMeta: true, message: { content: [
    { type: "tool_result", tool_use_id: "check-1", content: first.message!.content },
  ] } };
  const call = { type: "assistant", message: { content: [{ type: "tool_use", id: "check-1", name: "Bash" }] } };
  const mixed = { type: "user", isMeta: true, message: { content: [
    { type: "text", text: first.message!.content }, { type: "text", text: "additional context" },
  ] } };
  const messages: Message[] = [first, human, child, call, tool, mixed, latest];
  const before = structuredClone(messages);
  assert.deepEqual(compactGoalContinuations(messages, true), [human, child, call, tool, mixed, latest]);
  assert.deepEqual(messages, before);
  assert.equal(compactGoalContinuations(messages, false), messages);
  assert.equal(compactGoalContinuations([latest], true)[0], latest);
}));

test("long-run request payload drops repeated host text without dropping outcome evidence", () => fixture(cwd => {
  enableAutoGoal("Deliver the verified research platform", cwd);
  const messages: Message[] = [];
  for (let i = 0; i < 32; i++) {
    messages.push(meta(takeAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true })!),
      { type: "assistant", message: { content: [{ type: "tool_use", id: `test-${i}` }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `test-${i}`, content: `Measured outcome ${i}` }] } });
  }
  const compacted = compactGoalContinuations(messages, true);
  const projected = view(compacted, cwd);
  assert.equal(compacted.filter(message => message.isMeta).length, 1);
  assert.deepEqual(projected.filter(message => !message.isMeta), messages.filter(message => !message.isMeta));
  assert.ok(JSON.stringify(projected).length < JSON.stringify(messages).length / 4);
  assert.equal(messages.length, 96);
}));

test("production query uses the fresh anchor for both the hard-limit check and model request after compaction", () => {
  const source = readFileSync(new URL("../../src/query.ts", import.meta.url), "utf8");
  const compact = source.indexOf("await deps.autocompact(");
  const anchor = source.indexOf("const goalRequestMessages = appendGoalRequestAnchor(");
  const model = source.indexOf("messages: prependUserContext(goalRequestMessages, userContext)");
  assert.ok(compact >= 0 && anchor > compact && model > anchor);
  assert.match(source.slice(anchor, model), /tokenCountWithEstimation\(goalRequestMessages\) - snipTokensFreed/);
  assert.match(source.slice(anchor, model), /executionPolicy: autoGoalPolicy/);
  assert.match(source, /promptFormat: autoGoalPolicy \? 'delta' : 'full'/);
});
