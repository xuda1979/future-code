import { AUTO_GOAL_EXECUTION_POLICY, formatGoalRequestAnchor, readAutoGoal } from "./auto.ts";

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

/** Explicit context-retirement utility, not a steady-state request optimizer.
 * Removing older messages can invalidate provider prompt-prefix reuse. Normal
 * requests keep their complete historical prefix and append compact deltas.
 * Retire only redundant host continuation instructions, keeping the latest
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

/** Keep invariant guidance byte-identical across active-goal requests, even
 * when the root objective or steering changes. No control of provider caches
 * is assumed; keeping the prefix stable merely permits provider reuse. */
export function goalExecutionPolicy(mainThread: boolean, cwd?: string): string | null {
  return mainThread && readAutoGoal(cwd)?.state === "ACTIVE" ? AUTO_GOAL_EXECUTION_POLICY : null;
}

/** Read authority at the request boundary, after any compaction. The anchor
 * exists only in this API payload, so repeated tool turns do not accumulate it.
 * Corrupt state throws to the query's visible failure/parking boundary. */
export function appendGoalRequestAnchor<T extends ContextMessage>(messages: T[], options: {
  mainThread: boolean;
  cwd?: string;
  makeMessage: (content: string) => T;
  /** Optional stable prefix installed by the main loop before using delta
   * continuations. A message prefix also participates in token estimation. */
  executionPolicy?: string | null;
}): T[] {
  if (!options.mainThread) return messages;
  const state = readAutoGoal(options.cwd);
  if (!state) return messages;
  return [
    ...(state.state === "ACTIVE" && options.executionPolicy ? [options.makeMessage(options.executionPolicy)] : []),
    ...messages,
    options.makeMessage(formatGoalRequestAnchor(state, options.cwd)),
  ];
}
