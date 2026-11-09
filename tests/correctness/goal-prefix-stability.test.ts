import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compactGoalContinuations } from "../../src/commands/goal/context.ts";

// Exercise the actual query projection expression without loading unrelated
// UI/SDK dependencies. The earlier implementation deleted the first reminder
// and shifted every following tool exchange out of the reusable prefix.
const source = readFileSync(new URL("../../src/query.ts", import.meta.url), "utf8");
const expression = /^    let messagesForQuery = (.+)$/m.exec(source)?.[1];
assert.ok(expression, "production query must have a request-history projection");
const project = new Function("messages", "mainGoalThread", "getMessagesAfterCompactBoundary", "compactGoalContinuations",
  `return (${expression});`);
const reminder = (n: number) => ({ type: "user", isMeta: true,
  message: { content: `[Host-driven autonomous goal continuation ${n}]\nGoal: Repair scheduler\nHost guidance` } });

test("steady-state main-thread requests preserve the complete historical message prefix", () => {
  const history = [reminder(1),
    { type: "assistant", message: { content: [{ type: "tool_use", id: "check-1" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "check-1", content: "source-bound evidence" }] } },
    reminder(2)];
  const before = structuredClone(history);
  const projected = project(history, true, (messages: unknown[]) => messages, compactGoalContinuations);
  assert.deepEqual(projected, history, "new continuations must not shift earlier exchanges out of the prefix");
  assert.deepEqual(history, before);
});

test("an actual compact boundary still controls history retirement", () => {
  const compacted = [reminder(9)];
  assert.deepEqual(project([reminder(1), ...compacted], true, () => compacted, compactGoalContinuations), compacted);
});
