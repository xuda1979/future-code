import { canonical, invariant } from "../kernel.ts";
import type { Json } from "../types.ts";
export interface Call { id: string; name: string; arguments: Record<string, Json> }
export interface Message { role: "user" | "assistant" | "tool"; content: string; calls?: Call[]; callId?: string }
export const bytes = (value: unknown): number => Buffer.byteLength(canonical(value), "utf8");

/** Explicit, agent-authored notes are hints, never verified claims. Receipts are
 * checked for thread ownership before the host saves this structure. */
export interface ProgressCheckpoint {
  summary: string;
  nextAction: string;
  receipts: string[];
  patchHash: string | null;
  atTurn: number;
}

const NOTICE_MARKER = "[future-code:retired-context-v2]";
const LEGACY_NOTICE = "Older complete exchanges are in the durable journal. Use recall with historyAfter=0 and a page limit to retrieve them; do not invent their contents.";
function retirementNotice(progress: ProgressCheckpoint | null): Message {
  return { role: "user", content: NOTICE_MARKER + canonical({
    instruction: LEGACY_NOTICE,
    ...(progress ? { workingMemory: { trust: "UNVERIFIED_AGENT_NOTE_NOT_ACCEPTANCE",
      summary: progress.summary, nextAction: progress.nextAction, receipts: progress.receipts,
      patchHashAtNote: progress.patchHash, turn: progress.atTurn } } : {}),
  }) };
}

/** Exact JSON byte accounting lets us keep the longest recent suffix in O(n)
 * rather than repeatedly serializing progressively shorter histories (O(n^2)).
 * Never cut a tool-result pair, drop the immutable first message or forge PASS.
 * The optional note is replaced with the generic journal pointer when tight. */
export function compactHistory(history: Message[], budget: number, progress: ProgressCheckpoint | null = null): Message[] {
  invariant(Number.isSafeInteger(budget) && budget >= 0, "invalid context budget");
  invariant(history.length > 0 && history[0].role === "user", "missing mandatory task message");
  const mandatory = history[0];
  invariant(bytes([mandatory]) <= budget, "CONTEXT_OVERFLOW: mandatory task exceeds budget");
  const clean = [mandatory, ...history.slice(1).filter(m =>
    !(m.role === "user" && (m.content.startsWith(NOTICE_MARKER) || m.content === LEGACY_NOTICE)))];
  if (bytes(clean) <= budget) return clean;

  const groups: Message[][] = [];
  for (const message of clean.slice(1)) {
    if (message.role !== "tool") groups.push([message]);
    else {
      invariant(groups.length > 0 && groups.at(-1)![0].role === "assistant", "orphan tool result");
      groups.at(-1)!.push(message);
    }
  }
  // canonical([...messages]) is a compact JSON array: brackets, commas, and
  // each independently canonical-serialized message (including UTF-8 bytes).
  const encoded = groups.map(group => ({
    count: group.length,
    size: group.reduce((sum, message) => sum + Buffer.byteLength(canonical(message), "utf8"), 0),
  }));
  const mandatorySize = Buffer.byteLength(canonical(mandatory), "utf8");
  function select(notice: Message): number {
    let count = 2; // immutable task + one retirement notice
    let size = mandatorySize + Buffer.byteLength(canonical(notice), "utf8");
    let best = -1;
    for (let i = encoded.length - 1; i >= 0; i--) {
      count += encoded[i].count;
      size += encoded[i].size;
      if (2 + size + count - 1 <= budget) best = i;
      else break; // an earlier prefix cannot make this suffix smaller
    }
    return best;
  }
  let notice = retirementNotice(progress);
  let start = select(notice);
  if (start < 0 && progress) {
    notice = retirementNotice(null);
    start = select(notice);
  }
  invariant(start >= 0, "CONTEXT_OVERFLOW: latest complete exchange cannot fit; split the task or admit more context");
  return [mandatory, notice, ...groups.slice(start).flat()];
}
export function inlineReceipt(receipt: string, value: Json, limit = 2048): string {
  invariant(Number.isSafeInteger(limit) && limit > 0, "invalid inline receipt limit");
  const text = canonical(value);
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  return canonical({ receipt, truncated: true, preview: Buffer.from(text).subarray(0, Math.max(0, limit - 256)).toString("utf8"),
    note: "Full output retained. Use recall(receipt, offset, length); preview is not the full evidence." });
}
