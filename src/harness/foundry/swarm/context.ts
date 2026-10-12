import { canonical, invariant } from "../kernel.ts";
import type { Json } from "../types.ts";
import type { DiagnosticContext } from "./diagnostics.ts";
export interface Call { id: string; name: string; arguments: Record<string, Json> }
export interface Message { role: "user" | "assistant" | "tool"; content: string; calls?: Call[]; callId?: string;
  /** Host-owned receipt; never accepted from an external model response. */
  receipt?: string }
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
function retirementNotice(progress: ProgressCheckpoint | null, diagnostics: DiagnosticContext | null = null): Message {
  return { role: "user", content: NOTICE_MARKER + canonical({
    instruction: LEGACY_NOTICE,
    ...(progress ? { workingMemory: { trust: "UNVERIFIED_AGENT_NOTE_NOT_ACCEPTANCE",
      summary: progress.summary, nextAction: progress.nextAction, receipts: progress.receipts,
      patchHashAtNote: progress.patchHash, turn: progress.atTurn } } : {}),
    ...(diagnostics ? { hostDiagnostics: diagnostics } : {}),
  }) };
}

/** Refresh a previously projected host notice even when the request still fits.
 * Otherwise a new patch could keep an old failure labelled current until the
 * next overflow. Legacy notices are untouched unless host diagnostics exist,
 * preserving the input hash of durable replies from pre-diagnostic sessions. */
export function refreshDiagnosticNotice(history: Message[], progress: ProgressCheckpoint | null,
  diagnostics: DiagnosticContext | null): Message[] {
  return history.map(m => m.role === "user" && (m.content.startsWith(NOTICE_MARKER) || m.content === LEGACY_NOTICE) &&
    (diagnostics || m.content.includes('"hostDiagnostics":')) ? retirementNotice(progress, diagnostics) : m);
}

/** Exact JSON byte accounting lets us keep the longest recent suffix in O(n)
 * rather than repeatedly serializing progressively shorter histories (O(n^2)).
 * Never cut a tool-result pair, drop the immutable first message or forge PASS.
 * The optional note is replaced with the generic journal pointer when tight. */
export function compactHistory(history: Message[], budget: number, progress: ProgressCheckpoint | null = null,
  diagnostics: DiagnosticContext | null = null): Message[] {
  invariant(Number.isSafeInteger(budget) && budget >= 0, "invalid context budget");
  invariant(history.length > 0 && history[0].role === "user", "missing mandatory task message");
  const mandatory = history[0];
  invariant(bytes([mandatory]) <= budget, "CONTEXT_OVERFLOW: mandatory task exceeds budget");
  const isNotice = (m: Message) => m.role === "user" && (m.content.startsWith(NOTICE_MARKER) || m.content === LEGACY_NOTICE);
  const alreadyRetired = history.slice(1).some(isNotice);
  const clean = [mandatory, ...history.slice(1).filter(m => !isNotice(m))];
  if (!alreadyRetired && bytes(clean) <= budget) return clean;

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
  let notice = retirementNotice(progress, diagnostics);
  let start = select(notice);
  if (start < 0 && progress) {
    notice = retirementNotice(null, diagnostics);
    start = select(notice);
  }
  if (start < 0 && diagnostics && diagnostics.failures.length > 1) {
    notice = retirementNotice(null, { ...diagnostics, failures: diagnostics.failures.slice(0, 1) });
    start = select(notice);
  }
  if (start < 0 && diagnostics) { notice = retirementNotice(null); start = select(notice); }
  invariant(start >= 0, "CONTEXT_OVERFLOW: latest complete exchange cannot fit; split the task or admit more context");
  return [mandatory, notice, ...groups.slice(start).flat()];
}
export function inlineReceipt(receipt: string, value: Json, limit = 2048): string {
  invariant(Number.isSafeInteger(limit) && limit > 0, "invalid inline receipt limit");
  const text = canonical(value);
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const encoded = Buffer.from(text);
  const wrap = (n: number) => canonical({ receipt, truncated: true, preview: encoded.subarray(0, n).toString("utf8"),
    note: "Full output retained. Use recall(receipt, offset, length); preview is not the full evidence." });
  invariant(Buffer.byteLength(wrap(0), "utf8") <= limit, "inline receipt budget cannot fit a reference");
  let low = 0, high = Math.min(encoded.length, limit);
  // Account for JSON escapes and UTF-8 replacement bytes in the actual envelope.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(wrap(mid), "utf8") <= limit) low = mid; else high = mid - 1;
  }
  return wrap(low);
}

/** If the newest tool batch alone exceeds the envelope, retain its complete
 * call/result protocol and retire previews to authenticated recall references.
 * Full evidence remains in the journal; a model never supplies these hashes. */
export function retireToolPreviews(history: Message[]): Message[] {
  return history.map(m => m.role === "tool" && m.receipt ?
    { ...m, content: canonical({ receipt: m.receipt, retired: true, instruction: "Use recall for full evidence." }) } : m);
}
