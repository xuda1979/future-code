import { canonical, digest, invariant } from "../kernel.ts";
import { FatalAttemptError } from "../errors.ts";
import type { Protocol } from "./config.ts";
import type { Call, Message } from "./context.ts";

export interface ResponseRejection {
  code: string;
  reason: string;
  responseHash: string;
}
export interface Turn {
  /** A rejected turn has no model message or calls eligible for admission. */
  message: Message;
  tokens: number | null;
  truncated: boolean;
  rejection?: ResponseRejection;
}

class RepairableResponseError extends Error {
  readonly code: string;
  constructor(code: string, reason: string) { super(reason); this.code = code; }
}
function requireTool(condition: unknown, code: string, reason: string): asserts condition {
  if (!condition) throw new RepairableResponseError(code, reason);
}
function measured(raw: any, protocol: Protocol): number | null {
  const u = raw?.usage;
  if (!u || typeof u !== "object") return null;
  const ns = protocol === "anthropic"
    ? [u.input_tokens, u.output_tokens, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0]
    : [u.prompt_tokens, u.completion_tokens];
  if (ns.some(x => x === undefined || x === null)) return null;
  invariant(ns.every(x => Number.isSafeInteger(x) && x >= 0), "invalid provider usage");
  const total = ns.reduce((a, b) => a + b, 0);
  invariant(Number.isSafeInteger(total), "provider usage overflow"); return total;
}

/** Strict decoder. Only bounded model-output grammar mistakes are repairable;
 * unsupported provider features, refusals and invalid usage still fail closed. */
export function decodeTurn(protocol: Protocol, raw: any): Turn {
  let content = ""; const calls: Call[] = []; let stop: string;
  if (protocol === "anthropic") {
    invariant(Array.isArray(raw?.content) && typeof raw.stop_reason === "string", "invalid Anthropic response");
    stop = raw.stop_reason;
    invariant(["end_turn", "tool_use", "max_tokens", "stop_sequence"].includes(stop), "unsupported stop reason");
    for (const block of raw.content) {
      invariant(block && typeof block === "object", "invalid response block");
      if (block.type === "text") { invariant(typeof block.text === "string", "invalid text"); content += block.text; }
      else if (block.type === "tool_use") calls.push({ id: block.id, name: block.name, arguments: block.input });
      else throw new FatalAttemptError("Unsupported response block; this adapter does not enable extended thinking or server tools");
    }
  } else {
    invariant(Array.isArray(raw?.choices) && raw.choices.length === 1, "expected one completion");
    const choice = raw.choices[0]; const m = choice?.message;
    invariant(m && (m.content === null || m.content === undefined || typeof m.content === "string"), "invalid completion content");
    if (m.refusal) throw new FatalAttemptError("Model refused the request; response repair is unavailable");
    content = m.content ?? ""; stop = choice.finish_reason;
    invariant(["stop", "tool_calls", "length"].includes(stop), "unsupported completion finish reason");
    if (m.tool_calls !== undefined) {
      requireTool(Array.isArray(m.tool_calls), "TOOL_CALL_SHAPE", "tool_calls must be an array");
      requireTool(m.tool_calls.length <= 32, "TOOL_CALL_LIMIT", "too many tool calls in one response; use at most 32");
      for (const c of m.tool_calls) {
        requireTool(c?.type === "function" && typeof c.function?.arguments === "string",
          "TOOL_CALL_SHAPE", "invalid function call; use a function name and JSON-encoded object arguments");
        let args: unknown;
        try { args = JSON.parse(c.function.arguments); }
        catch { throw new RepairableResponseError("TOOL_ARGUMENTS_JSON", "function arguments must be a complete valid JSON object"); }
        calls.push({ id: c.id, name: c.function.name, arguments: args as Call["arguments"] });
      }
    }
  }
  requireTool(calls.length <= 32, "TOOL_CALL_LIMIT", "too many tool calls in one response; use at most 32");
  const seen = new Set<string>();
  for (const c of calls) {
    requireTool(typeof c.id === "string" && c.id.length > 0 && c.id.length <= 256 && !seen.has(c.id),
      "TOOL_CALL_IDS", "invalid/duplicate tool id; use unique nonempty IDs of at most 256 characters"); seen.add(c.id);
    requireTool(typeof c.name === "string" && c.name.length > 0 && c.arguments && typeof c.arguments === "object" && !Array.isArray(c.arguments),
      "TOOL_ARGUMENTS_OBJECT", "invalid tool arguments; provide a nonempty tool name and an object");
    try { canonical(c.arguments); }
    catch { throw new RepairableResponseError("TOOL_ARGUMENTS_JSON", "function arguments must be finite, serializable JSON"); }
  }
  requireTool(!["tool_calls", "tool_use"].includes(stop) || calls.length > 0,
    "TOOL_STOP_WITHOUT_CALLS", "tool stop without calls; provide complete tool calls or a nonempty final summary");
  requireTool(calls.length > 0 || content.trim().length > 0 || stop === "length" || stop === "max_tokens",
    "EMPTY_RESPONSE", "empty response; provide a permitted tool call or a nonempty final summary");
  return { message: { role: "assistant", content, ...(calls.length ? { calls } : {}) }, tokens: measured(raw, protocol),
    truncated: stop === "length" || stop === "max_tokens" };
}

/** Keep the raw reply in the durable request journal, but never forward partial
 * calls or raw parser-error excerpts into the model conversation. */
export function decodeResponse(protocol: Protocol, raw: any): Turn {
  try { return decodeTurn(protocol, raw); }
  catch (error) {
    if (!(error instanceof RepairableResponseError)) throw error;
    return { message: { role: "assistant", content: "" }, tokens: measured(raw, protocol),
      truncated: raw?.stop_reason === "max_tokens" || raw?.choices?.[0]?.finish_reason === "length",
      rejection: { code: error.code, reason: error.message, responseHash: digest(raw) } };
  }
}

/** Two corrective requests after the initial rejection, within existing budgets. */
export const MAX_CONSECUTIVE_RESPONSE_REJECTIONS = 3;
