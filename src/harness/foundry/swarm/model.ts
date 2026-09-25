import { canonical, digest, invariant } from "../kernel.ts";
import { FatalAttemptError } from "../errors.ts";
import type { Capsule, Json } from "../types.ts";
import type { AgentProfile, Protocol, SwarmBudget, ToolName } from "./config.ts";
import { bytes, compactHistory, type Call, type Message } from "./context.ts";
import { SessionJournal } from "./session.ts";

export interface Turn { message: Message; tokens: number | null; truncated: boolean }
export interface ToolDefinition { name: ToolName; description: string; schema: Record<string, Json> }
const string = { type: "string" }; const integer = { type: "integer", minimum: 0 };
const def = (name: ToolName, description: string, properties: Record<string, Json>, required: string[]): ToolDefinition =>
  ({ name, description, schema: { type: "object", properties, required, additionalProperties: false } });
export const definitions: ToolDefinition[] = [
  def("list_files", "List tracked and new files in the task's readable scopes. Paginated; paths only.", { offset: integer, limit: { type: "integer", minimum: 1, maximum: 200 } }, []),
  def("read_file", "Read a bounded line range of a non-symlink UTF-8 file in readable scopes.", { path: string, start: { type: "integer", minimum: 1 }, lines: { type: "integer", minimum: 1, maximum: 300 } }, ["path"]),
  def("write_file", "Write a UTF-8 file within the task's exclusive write scopes; use edit_file for small changes.", { path: string, content: string }, ["path", "content"]),
  def("edit_file", "Replace exactly one literal occurrence. A missing or ambiguous match is an error.", { path: string, oldText: string, newText: string }, ["path", "oldText", "newText"]),
  def("delete_file", "Delete one non-symlink file within the task's write scopes.", { path: string }, ["path"]),
  def("run_check", "Run a configured named check; arbitrary shell commands are not accepted.", { name: string }, ["name"]),
  def("recall", "Read this thread's durable receipts, or page prior events. No other thread's history is accessible.",
    { receipt: string, offset: integer, length: { type: "integer", minimum: 1, maximum: 8192 }, historyAfter: integer, limit: { type: "integer", minimum: 1, maximum: 10 } }, []),
];
const asJson = (x: unknown): Json => JSON.parse(canonical(x));
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
export function decodeTurn(protocol: Protocol, raw: any): Turn {
  let content = ""; const calls: Call[] = []; let stop: string;
  if (protocol === "anthropic") {
    invariant(Array.isArray(raw?.content) && typeof raw.stop_reason === "string", "invalid Anthropic response");
    for (const block of raw.content) {
      if (block.type === "text") { invariant(typeof block.text === "string", "invalid text"); content += block.text; }
      else if (block.type === "tool_use") calls.push({ id: block.id, name: block.name, arguments: block.input });
      else throw new FatalAttemptError("Unsupported response block; this adapter does not enable extended thinking or server tools");
    }
    stop = raw.stop_reason;
    invariant(["end_turn", "tool_use", "max_tokens", "stop_sequence"].includes(stop), "unsupported stop reason");
  } else {
    invariant(Array.isArray(raw?.choices) && raw.choices.length === 1, "expected one completion");
    const choice = raw.choices[0]; const m = choice.message;
    invariant(m && (m.content === null || m.content === undefined || typeof m.content === "string"), "invalid completion content");
    content = m.content ?? ""; stop = choice.finish_reason;
    invariant(["stop", "tool_calls", "length"].includes(stop), "unsupported completion finish reason");
    if (m.tool_calls !== undefined) {
      invariant(Array.isArray(m.tool_calls), "invalid tool_calls");
      for (const c of m.tool_calls) {
        invariant(c.type === "function" && typeof c.function?.arguments === "string", "invalid function call");
        calls.push({ id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments) });
      }
    }
  }
  invariant(calls.length <= 32, "too many tool calls in one response");
  const seen = new Set<string>();
  for (const c of calls) {
    invariant(typeof c.id === "string" && c.id.length > 0 && c.id.length <= 256 && !seen.has(c.id), "invalid/duplicate tool id"); seen.add(c.id);
    invariant(typeof c.name === "string" && c.arguments && typeof c.arguments === "object" && !Array.isArray(c.arguments), "invalid tool arguments");
    canonical(c.arguments);
  }
  invariant(!["tool_calls", "tool_use"].includes(stop) || calls.length > 0, "tool stop without calls");
  return { message: { role: "assistant", content, ...(calls.length ? { calls } : {}) }, tokens: measured(raw, protocol),
    truncated: stop === "length" || stop === "max_tokens" };
}
export function requestBody(profile: AgentProfile, history: Message[], budget: SwarmBudget): Json {
  const tools = definitions.filter(x => profile.tools.includes(x.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (profile.protocol === "chat-completions") return asJson({
    model: profile.model, max_tokens: budget.maxOutputTokens, stream: false,
    messages: [{ role: "system", content: profile.system }, ...history.map(m => m.role === "tool"
      ? { role: "tool", tool_call_id: m.callId, content: m.content }
      : { role: m.role, content: m.content, ...(m.calls?.length ? { tool_calls: m.calls.map(c =>
          ({ id: c.id, type: "function", function: { name: c.name, arguments: canonical(c.arguments) } })) } : {}) })],
    tools: tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })),
  });
  const messages: any[] = [];
  for (const m of history) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.callId, content: m.content };
      if (messages.at(-1)?.role === "user" && Array.isArray(messages.at(-1).content)) messages.at(-1).content.push(block);
      else messages.push({ role: "user", content: [block] });
    } else if (m.role === "assistant") {
      const blocks: any[] = m.content ? [{ type: "text", text: m.content }] : [];
      for (const c of m.calls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
      invariant(blocks.length > 0, "empty assistant exchange"); messages.push({ role: "assistant", content: blocks });
    } else messages.push({ role: "user", content: [{ type: "text", text: m.content }] });
  }
  return asJson({ model: profile.model, max_tokens: budget.maxOutputTokens, stream: false,
    system: [{ type: "text", text: profile.system, ...(profile.promptCache ? { cache_control: { type: "ephemeral" } } : {}) }],
    messages, tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema })) });
}
export async function boundedJson(response: Response, maxBytes: number): Promise<Json> {
  invariant(response.body, "missing response body"); const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let n = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      n += item.value.byteLength; invariant(n <= maxBytes, "provider response exceeds output budget"); chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export class HttpBrain {
  readonly journal: SessionJournal; readonly fetcher: typeof fetch;
  constructor(journal: SessionJournal, fetcher: typeof fetch = fetch) { this.journal = journal; this.fetcher = fetcher; }
  async next(c: Capsule, profile: AgentProfile, history: Message[], budget: SwarmBudget, contextBytes: number, signal: AbortSignal, step = 0): Promise<{ turn: Turn; history: Message[] }> {
    let projection = history;
    let body = requestBody(profile, projection, budget);
    // Enforce the actual provider input, including system and tool definitions.
    if (bytes(body) > contextBytes) {
      const overhead = bytes(requestBody(profile, [], budget));
      projection = compactHistory(history, Math.max(0, contextBytes - overhead - 512));
      body = requestBody(profile, projection, budget);
    }
    if (bytes(body) > contextBytes) throw new FatalAttemptError("CONTEXT_OVERFLOW: encoded provider request exceeds admitted context");
    const cached = this.journal.cached(c, step, body);
    if (cached) {
      const turn = decodeTurn(profile.protocol, cached);
      if (turn.truncated) throw new FatalAttemptError("Model output truncated");
      return { turn, history: projection };
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (profile.protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";
    if (profile.keyEnv) {
      const key = process.env[profile.keyEnv]; if (!key) throw new FatalAttemptError(`Missing credential environment: ${profile.keyEnv}`);
      headers[profile.protocol === "anthropic" ? "x-api-key" : "authorization"] = profile.protocol === "anthropic" ? key : `Bearer ${key}`;
    }
    const provider = digest({ url: profile.url });
    for (let retry = 0; retry < 2; retry++) {
      const id = await this.journal.reserve(c, provider, body, budget, signal);
      let completed = false;
      try {
        const timeout = AbortSignal.timeout(budget.requestTimeoutMs);
        const response = await this.fetcher(profile.url, { method: "POST", headers, body: canonical(body), redirect: "error", signal: AbortSignal.any([signal, timeout]) });
        if (!response.ok) {
          await response.body?.cancel();
          // Error bodies may contain credentials or upstream internals. Do not log them.
          this.journal.complete(id, null, { httpStatus: response.status }); completed = true;
          if ([429, 503, 529].includes(response.status) && retry === 0) {
            const h = response.headers.get("retry-after"); const parsed = h ? Number(h) : NaN;
            const date = h ? Date.parse(h) - Date.now() : NaN;
            const ms = Number.isFinite(parsed) ? parsed * 1000 : Number.isFinite(date) ? date : 1000;
            this.journal.cooldown(provider, Math.min(60000, Math.max(100, ms))); continue;
          }
          throw new Error(`Model HTTP ${response.status}`);
        }
        const raw = await boundedJson(response, budget.maxToolOutputBytes);
        const turn = decodeTurn(profile.protocol, raw);
        this.journal.complete(id, turn.tokens, raw, step); completed = true;
        signal.throwIfAborted(); this.journal.assertLease(c);
        if (turn.truncated) throw new FatalAttemptError("Model output truncated; admit more output or split task");
        return { turn, history: projection };
      } finally { if (!completed) this.journal.complete(id, null, null); }
    }
    throw new Error("model retry budget exhausted");
  }
}
