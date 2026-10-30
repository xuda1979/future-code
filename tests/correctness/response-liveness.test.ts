import test from "node:test";
import assert from "node:assert/strict";
import {
  allowSilentEndTurn,
  hasVisibleAssistantText,
  isUserFacingTurn,
  shouldRecoverSilentResponse,
  modelApiFailureReason,
} from "../../src/utils/responseLiveness.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableAutoGoal, parkActiveAutoGoal, readAutoGoal } from "../../src/commands/goal/auto.ts";

const human = {
  type: "user",
  message: { role: "user", content: "why did you stop?" },
  isMeta: false,
} as any;
const notification = {
  type: "user",
  message: { role: "user", content: "<task-notification>done</task-notification>" },
  origin: { kind: "task-notification" },
} as any;
const emptyAssistant = {
  type: "assistant",
  message: { role: "assistant", content: [], stop_reason: "end_turn" },
} as any;
const thinkingOnly = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "thinking", thinking: "internal" }], stop_reason: "end_turn" },
} as any;
const visible = {
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "I am still working." }], stop_reason: "end_turn" },
} as any;

test("human prompts cannot silently succeed on end_turn", () => {
  assert.equal(isUserFacingTurn([human]), true);
  assert.equal(allowSilentEndTurn(human, "end_turn"), false);
  assert.equal(shouldRecoverSilentResponse([human], [emptyAssistant], false, false), true);
  assert.equal(shouldRecoverSilentResponse([human], [thinkingOnly], false, false), true);
});

test("task notification drain may legitimately end without visible assistant text", () => {
  assert.equal(isUserFacingTurn([notification]), false);
  assert.equal(allowSilentEndTurn(notification, "end_turn"), true);
  assert.equal(shouldRecoverSilentResponse([notification], [emptyAssistant], false, false), false);
});

test("visible assistant text or tool/API activity suppresses silent recovery", () => {
  assert.equal(hasVisibleAssistantText([visible]), true);
  assert.equal(shouldRecoverSilentResponse([human], [visible], false, false), false);
  assert.equal(shouldRecoverSilentResponse([human], [emptyAssistant], true, false), false);
  assert.equal(shouldRecoverSilentResponse([human], [emptyAssistant], false, true), false);
});

test("terminal provider failures retain their actionable error in durable goal state", () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-api-error-'));
  try {
    enableAutoGoal('Complete the objective', dir);
    const reason = modelApiFailureReason({ message: { content: [
      { type: 'thinking', thinking: 'private' },
      { type: 'text', text: 'HTTP 401: API credential expired; renew the configured credential.' },
    ] } });
    parkActiveAutoGoal(reason, dir);
    const saved = readAutoGoal(dir)!;
    assert.equal(saved.state, 'PAUSED');
    assert.match(saved.reason!, /HTTP 401: API credential expired/);
    assert.match(saved.reason!, /renew the configured credential/);
    assert.doesNotMatch(saved.reason!, /private/);
    assert.equal(saved.totalContinuations, 0);
    assert.match(modelApiFailureReason(null), /without diagnostic text/);
    assert.ok(modelApiFailureReason({ message: { content: 'x'.repeat(2000) } }).length < 1024);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
