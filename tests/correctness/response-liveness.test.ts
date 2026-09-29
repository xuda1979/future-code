import test from "node:test";
import assert from "node:assert/strict";
import {
  allowSilentEndTurn,
  hasVisibleAssistantText,
  isUserFacingTurn,
  shouldRecoverSilentResponse,
} from "../../src/utils/responseLiveness.ts";

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
