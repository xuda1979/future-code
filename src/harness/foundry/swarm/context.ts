import { canonical, invariant } from "../kernel.ts";
import type { Json } from "../types.ts";
export interface Call { id: string; name: string; arguments: Record<string, Json> }
export interface Message { role: "user" | "assistant" | "tool"; content: string; calls?: Call[]; callId?: string }
export const bytes = (value: unknown): number => Buffer.byteLength(canonical(value), "utf8");

/** Keep task/acceptance and whole recent tool exchanges. The immutable journal
 * retains everything; this is a projection, NOT a destructive session rewrite. */
export function compactHistory(history: Message[], budget: number): Message[] {
  invariant(history.length > 0 && history[0].role === "user", "missing mandatory task message");
  invariant(bytes([history[0]]) <= budget, "CONTEXT_OVERFLOW: mandatory task exceeds budget");
  if (bytes(history) <= budget) return history;
  const groups: Message[][] = [];
  for (const message of history.slice(1)) {
    if (message.role !== "tool") groups.push([message]);
    else { invariant(groups.length > 0 && groups.at(-1)![0].role === "assistant", "orphan tool result"); groups.at(-1)!.push(message); }
  }
  const notice: Message = { role: "user", content: "Older complete exchanges are in the durable journal. Use recall with historyAfter=0 and a page limit to retrieve them; do not invent their contents." };
  for (let start = 1; start < groups.length; start++) {
    const candidate = [history[0], notice, ...groups.slice(start).flat()];
    if (bytes(candidate) <= budget) return candidate;
  }
  throw new Error("CONTEXT_OVERFLOW: latest complete exchange cannot fit; split the task or admit more context");
}
export function inlineReceipt(receipt: string, value: Json, limit = 2048): string {
  const text = canonical(value);
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  return canonical({ receipt, truncated: true, preview: Buffer.from(text).subarray(0, Math.max(0, limit - 256)).toString("utf8"),
    note: "Full output retained. Use recall(receipt, offset, length); preview is not the full evidence." });
}
