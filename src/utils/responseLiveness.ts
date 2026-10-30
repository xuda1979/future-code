import type { AssistantMessage, Message } from "../types/message.js";

function isTaskNotification(message: Message): boolean {
  return message.type === "user" &&
    (message.origin?.kind === "task-notification" || message.isMeta === true);
}

export function isUserFacingTurn(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.type !== "user") continue;
    if (message.toolUseResult !== undefined) continue;
    return !isTaskNotification(message);
  }
  return false;
}

export function hasVisibleAssistantText(messages: AssistantMessage[]): boolean {
  return messages.some(message =>
    Array.isArray(message.message.content) &&
    message.message.content.some(block =>
      block.type === "text" && block.text.trim().length > 0
    )
  );
}

export function allowSilentEndTurn(message: Message | undefined, stopReason: string | null): boolean {
  if (!message || stopReason !== "end_turn") return false;
  if (message.type !== "user") return false;
  return isTaskNotification(message);
}

export function shouldRecoverSilentResponse(
  messagesForQuery: Message[],
  assistantMessages: AssistantMessage[],
  hasToolUse: boolean,
  isApiError: boolean,
): boolean {
  return isUserFacingTurn(messagesForQuery) &&
    !hasToolUse &&
    !isApiError &&
    !hasVisibleAssistantText(assistantMessages);
}

/** Preserve the provider's actual terminal diagnostic in the durable goal,
 * rather than replacing it with a generic availability/credentials hint. */
export function modelApiFailureReason(message: unknown): string {
  const content = (message as { message?: { content?: unknown } } | null)?.message?.content;
  const detail = typeof content === 'string' ? content : Array.isArray(content) ? content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n') : '';
  return 'Model API failure after automatic recovery: ' +
    (detail.trim() || 'Provider returned an error without diagnostic text.').slice(0, 640);
}
