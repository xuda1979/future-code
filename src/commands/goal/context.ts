import { formatGoalRequestAnchor, readAutoGoal } from "./auto.ts";

// Structural subset keeps this projection testable without UI/SDK imports.
interface ContextMessage {
  type: string;
  isMeta?: boolean;
  origin?: unknown;
  message?: unknown;
}

function isHostContinuation(message: ContextMessage): boolean {
  const body = message.message;
  const content = body !== null && typeof body === "object" && "content" in body ? body.content : undefined;
  return message.type === "user" && message.isMeta === true && message.origin === undefined &&
    typeof content === "string" &&
    /^\[Host-driven autonomous goal continuation \d+(?:\/\d+)?\]\nGoal: /.test(content);
}

/** Retire only redundant host continuation instructions, keeping the latest
 * recovery guidance. Preserve every human message, tool pair and artifact;
 * callers use the result as a request view, never edit the durable transcript.
 * No I/O, model call, acceptance decision, or cross-request evidence cache. */
export function compactGoalContinuations<T extends ContextMessage>(messages: T[], mainThread: boolean): T[] {
  if (!mainThread) return messages;
  let latest = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isHostContinuation(messages[i]!)) { latest = i; break; }
  }
  if (latest < 0 || !messages.slice(0, latest).some(isHostContinuation)) return messages;
  return messages.filter((message, i) => i === latest || !isHostContinuation(message));
}

/** Read authority at the request boundary, after any compaction. The anchor
 * exists only in this API payload, so repeated tool turns do not accumulate it.
 * Corrupt state throws to the query's visible failure/parking boundary. */
export function appendGoalRequestAnchor<T extends ContextMessage>(messages: T[], options: {
  mainThread: boolean;
  cwd?: string;
  makeMessage: (content: string) => T;
}): T[] {
  if (!options.mainThread) return messages;
  const state = readAutoGoal(options.cwd);
  return state ? [...messages, options.makeMessage(formatGoalRequestAnchor(state, options.cwd))] : messages;
}
