import { canonical, digest, invariant } from "../kernel.ts";
import { DeferredAttemptError } from "../continuation.ts";
import { FatalAttemptError } from "../errors.ts";
import type { Capsule, Json } from "../types.ts";
import type { AgentProfile, Protocol, ProviderRoute, SwarmBudget, ToolName } from "./config.ts";
import { bytes, compactHistory, type Call, type Message, type ProgressCheckpoint } from "./context.ts";
import { SessionJournal } from "./session.ts";
import { createCombinedAbortSignal } from "../../../utils/combinedAbortSignal.ts";
import { transientStatus } from "./providerRecovery.ts";
import { abortable, boundedFetch, discardResponse } from "./transport.ts";

export interface Turn { message: Message; tokens: number | null; truncated: boolean }
export interface ToolDefinition { name: ToolName; description: string; schema: Record<string, Json> }
const string = { type: "string" }; const integer = { type: "integer", minimum: 0 };
const def = (name: ToolName, description: string, properties: Record<string, Json>, required: string[]): ToolDefinition =>
  ({ name, description, schema: { type: "object", properties, required, additionalProperties: false } });
export const definitions: ToolDefinition[] = [
  def("publish_finding", "Publish one concise UNVERIFIED finding. Cohort notes are visible within your assigned group. Shared notes become visible across groups only after the source task passes independent checks and its accepted patch matches this checkpoint. Receipt references must belong to this thread. Reuse the same id only for identical content.", {
    id: { type: "string", minLength: 1, maxLength: 128 },
    audience: { type: "string", enum: ["cohort", "shared"] },
    kind: { type: "string", enum: ["hypothesis", "result", "counterexample"] },
    summary: { type: "string", minLength: 1, maxLength: 2048 },
    receipts: { type: "array", maxItems: 8, uniqueItems: true, items: string },
  }, ["id", "audience", "kind", "summary", "receipts"]),
  def("read_findings", "Page a bounded digest from your cohort or the accepted cross-cohort stream. Cursors are separate per audience. Summary text is always UNVERIFIED, even when its source task passed checks. Use owned findingReceipt with recall to expand a shortened note. Artifact references do not grant file access or change acceptance.", {
    audience: { type: "string", enum: ["cohort", "shared"] }, after: integer,
    limit: { type: "integer", minimum: 1, maximum: 20 },
  }, ["audience"]),
  def("propose_claim", "Record or revise a hypothesis, never a verified fact. Evidence IDs are host receipt references. Revision requires expectedVersion; dependencies are version-bound claims. Only independent adjudication may support/refute a claim.", {
    id: string, statement: string, evidenceIds: { type: "array", maxItems: 32, uniqueItems: true, items: string },
    dependencies: { type: "array", maxItems: 32, uniqueItems: true, items: string }, expectedVersion: integer,
  }, ["id", "statement", "evidenceIds", "dependencies"]),
  def("read_claims", "Read versioned claims for this task and its verified direct dependencies. Status PROPOSED means unverified. STALE claims require a new independent discriminator.", { after: string, limit: { type: "integer", minimum: 1, maximum: 100 } }, []),
  def("propose_conflict", "Report a possible semantic contradiction between two claims of this task. Opens a durable conflict requiring independent adjudication; never declares either claim true.", { leftClaim: string, rightClaim: string }, ["leftClaim", "rightClaim"]),
  def("run_job", "Run a permitted external research job. Emit multiple independent run_job calls in the SAME model turn when experiments can proceed in parallel: the host durably fans them out up to remote capacity, releases this worker once, and resumes with all completed results. Never serialize independent experiments across reasoning turns and never launch duplicate work through run_check.", { name: string, input: {} }, ["name", "input"]),
  def("spawn_tasks", "Split this task into independently verifiable child tasks when parallel work will reduce the decision scope. The host validates scope, depth, count, dependencies and agent roster, releases this parent while children run, then resumes this exact tool call with verified child outputs.", {
    children: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false,
      properties: { id: string, goal: string, acceptance: { type: "array", minItems: 1, items: string }, input: {},
        writeScope: { type: "array", items: string }, readScope: { type: "array", items: string },
        dependsOn: { type: "array", maxItems: 32, items: string }, agent: string,
        priority: { type: "number" }, estimatedDurationMs: { type: "integer", minimum: 1 },
        contextBudget: { type: "integer", minimum: 1 } },
      required: ["id", "goal", "acceptance", "input", "writeScope", "readScope"] } },
  }, ["children"]),
  def("list_files", "List tracked and new files in the task's readable scopes. Paginated; paths only.", { offset: integer, limit: { type: "integer", minimum: 1, maximum: 200 } }, []),
  def("read_file", "Read a bounded line range of a non-symlink UTF-8 file in readable scopes.", { path: string, start: { type: "integer", minimum: 1 }, lines: { type: "integer", minimum: 1, maximum: 300 } }, ["path"]),
  def("write_file", "Write a UTF-8 file within the task's exclusive write scopes; use edit_file for small changes.", { path: string, content: string }, ["path", "content"]),
  def("edit_file", "Replace exactly one literal occurrence. A missing or ambiguous match is an error.", { path: string, oldText: string, newText: string }, ["path", "oldText", "newText"]),
  def("delete_file", "Delete one non-symlink file within the task's write scopes.", { path: string }, ["path"]),
  def("run_check", "Run a configured named check; arbitrary shell commands are not accepted.", { name: string }, ["name"]),
  def("save_progress", "Save an UNVERIFIED, bounded working-memory checkpoint before context retirement. Record only the current hypothesis, attempted methods, observed blockers, and exact next step; refer to owned receipt IDs for facts. It cannot change acceptance or frozen checks.", {
    summary: { type: "string", minLength: 1, maxLength: 1024 },
    nextAction: { type: "string", minLength: 1, maxLength: 512 },
    receipts: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string" } },
  }, ["summary", "nextAction", "receipts"]),
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
export async function boundedJson(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Json> {
  invariant(response.body, "missing response body"); const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let n = 0;
  try {
    for (;;) {
      const item = await (signal ? abortable(reader.read(), signal) : reader.read()); if (item.done) break;
      n += item.value.byteLength; invariant(n <= maxBytes, "provider response exceeds output budget"); chunks.push(item.value);
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export class HttpBrain {
  readonly journal: SessionJournal; readonly fetcher: typeof fetch;
  constructor(journal: SessionJournal, fetcher: typeof fetch = fetch) { this.journal = journal; this.fetcher = fetcher; }
  private project(profile: AgentProfile, history: Message[], budget: SwarmBudget, contextBytes: number, progress: ProgressCheckpoint | null = null): { projection: Message[]; body: Json } {
    let projection = history;
    let body = requestBody(profile, projection, budget);
    // Enforce the actual provider input, including system and tool definitions.
    if (bytes(body) > contextBytes) {
      const overhead = bytes(requestBody(profile, [], budget));
      projection = compactHistory(history, Math.max(0, contextBytes - overhead - 512), progress);
      body = requestBody(profile, projection, budget);
    }
    if (bytes(body) > contextBytes) throw new FatalAttemptError("CONTEXT_OVERFLOW: encoded provider request exceeds admitted context");
    return { projection, body };
  }
  private readReply(c: Capsule, profile: AgentProfile, projection: Message[], body: Json, step: number): { turn: Turn; history: Message[] } | null {
    const raw = this.journal.cached(c, step, body);
    if (raw === null) return null;
    const turn = decodeTurn(profile.protocol, raw);
    if (turn.truncated) throw new FatalAttemptError("Model output truncated");
    return { turn, history: projection };
  }
  /** Consume a durable reply before recovery/checkpoint diagnostics mutate its
   * original input. No RPC, reservation, or spend is generated by replay. */
  replay(c: Capsule, profile: AgentProfile, history: Message[], budget: SwarmBudget, contextBytes: number, step: number, progress: ProgressCheckpoint | null = null): { turn: Turn; history: Message[] } | null {
    if (!this.journal.hasReply(c, step)) return null;
    const { projection, body } = this.project(profile, history, budget, contextBytes, progress);
    return this.readReply(c, profile, projection, body, step);
  }
  private async nextHedged(c: Capsule, profile: AgentProfile, projection: Message[], body: Json,
    budget: SwarmBudget, signal: AbortSignal, step: number): Promise<{ turn: Turn; history: Message[] }> {
    const routes: ProviderRoute[] = [
      { url: profile.url, model: profile.model, keyEnv: profile.keyEnv, allowHttp: profile.allowHttp, quotaPool: profile.quotaPool },
      ...(profile.fallbacks ?? []),
    ];
    type Outcome = { index: number; kind: "success"; turn: Turn } |
      { index: number; kind: "failure"; transient: boolean; error: Error; wakeAt?: number } |
      { index: number; kind: "lost" };
    const controllers = routes.map(() => new AbortController());
    const pending = new Map<number, Promise<Outcome>>();
    const call = async (index: number): Promise<Outcome> => {
      const route = routes[index]; const controller = controllers[index];
      const admission = createCombinedAbortSignal(signal, { signalB: controller.signal });
      let combined: ReturnType<typeof createCombinedAbortSignal> | undefined;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (profile.protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";
      if (route.keyEnv) {
        const key = process.env[route.keyEnv];
        if (!key) {
          admission.cleanup();
          return { index, kind: "failure", transient: false,
            error: new FatalAttemptError(`Missing credential environment: ${route.keyEnv}`) };
        }
        headers[profile.protocol === "anthropic" ? "x-api-key" : "authorization"] =
          profile.protocol === "anthropic" ? key : `Bearer ${key}`;
      }
      const provider = digest({ quotaPool: route.quotaPool ?? `${route.url}#${route.model}` });
      let id: string | null = null; let completed = false;
      try {
        id = await this.journal.reserve(c, provider, body, budget, admission.signal);
        combined = createCombinedAbortSignal(admission.signal, { timeoutMs: budget.requestTimeoutMs });
        const response = await boundedFetch(this.fetcher, route.url, {
          method: "POST", headers, body: canonical(body), redirect: "error", signal: combined.signal,
        });
        if (!response.ok) {
          discardResponse(response);
          this.journal.complete(id, null, { httpStatus: response.status }); completed = true;
          const transient = transientStatus(response.status);
          const wakeAt = transient ? this.journal.providerFailure(id, response.headers.get("retry-after"), response.status) : undefined;
          return { index, kind: "failure", transient, wakeAt,
            error: transient ? new Error(`Provider HTTP ${response.status}`) :
              new FatalAttemptError(`Model HTTP ${response.status}; route configuration requires attention`) };
        }
        const raw = await boundedJson(response, budget.maxToolOutputBytes, combined.signal);
        const turn = decodeTurn(profile.protocol, raw);
        this.journal.providerSuccess(id);
        if (turn.truncated) {
          this.journal.complete(id, turn.tokens, raw); completed = true;
          return { index, kind: "failure", transient: false,
            error: new FatalAttemptError("Model output truncated; admit more output or split task") };
        }
        const won = this.journal.complete(id, turn.tokens, raw, step, true); completed = true;
        return won ? { index, kind: "success", turn } : { index, kind: "lost" };
      } catch (error) {
        if (id && !completed) { this.journal.complete(id, null, null); completed = true; }
        if (controller.signal.aborted && !signal.aborted) return { index, kind: "lost" };
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        const deferred = error instanceof DeferredAttemptError;
        const transient = deferred || isTransportFailure(error) || combined?.signal.aborted === true;
        const wakeAt = deferred ? error.wakeAt : transient && id ? this.journal.providerFailure(id) : undefined;
        return { index, kind: "failure", transient, wakeAt,
          error: error instanceof Error ? error : new Error(String(error)) };
      } finally {
        combined?.cleanup(); admission.cleanup();
      }
    };
    const launch = (index: number) => {
      if (!pending.has(index)) pending.set(index, call(index));
    };
    launch(0);
    let fallbacksLaunched = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // If the operator did not request speculative hedging, fail over only
    // after an actual primary failure. Avoid duplicate token spend by default.
    let hedgeReady: Promise<{ index: -1; kind: "hedge" }> | null = null;
    if (profile.hedgeAfterMs !== undefined) {
      hedgeReady = new Promise(resolve => {
        timer = setTimeout(() => resolve({ index: -1, kind: "hedge" }), profile.hedgeAfterMs);
      });
    }
    const failures: Extract<Outcome, { kind: "failure" }>[] = [];
    try {
      for (;;) {
        const candidates: Promise<Outcome | { index: -1; kind: "hedge" }>[] = [...pending.values()];
        if (hedgeReady) candidates.push(hedgeReady);
        const outcome = await Promise.race(candidates);
        if (outcome.kind === "hedge") {
          hedgeReady = null; timer = null; fallbacksLaunched = true;
          for (let i = 1; i < routes.length; i++) launch(i);
          continue;
        }
        pending.delete(outcome.index);
        if (outcome.kind === "success") {
          for (let i = 0; i < controllers.length; i++) if (i !== outcome.index) controllers[i].abort();
          await Promise.allSettled([...pending.values()]);
          signal.throwIfAborted(); this.journal.assertLease(c);
          this.journal.store.event("model.hedge.won",
            { route: outcome.index, routes: routes.length, hedgeAfterMs: profile.hedgeAfterMs ?? 250 },
            c.runId, c.task.id);
          return { turn: outcome.turn, history: projection };
        }
        if (outcome.kind === "failure") failures.push(outcome);
        if (!fallbacksLaunched && outcome.index === 0) {
          if (timer) clearTimeout(timer); timer = null; hedgeReady = null; fallbacksLaunched = true;
          for (let i = 1; i < routes.length; i++) launch(i);
        }
        if (!pending.size && fallbacksLaunched) break;
      }
    } finally {
      if (timer) clearTimeout(timer);
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...pending.values()]);
    }
    const allFatal = failures.length > 0 && failures.every(x => !x.transient);
    if (allFatal) throw failures[0].error;
    const wakes = failures.filter(x => x.transient && x.wakeAt !== undefined).map(x => x.wakeAt!);
    throw new DeferredAttemptError("provider",
      wakes.length ? Math.max(Date.now(), Math.min(...wakes)) : Date.now() + 1000,
      "All configured external model routes were unavailable; resume scheduled");
  }

  async next(c: Capsule, profile: AgentProfile, history: Message[], budget: SwarmBudget, contextBytes: number, signal: AbortSignal, step = 0, progress: ProgressCheckpoint | null = null): Promise<{ turn: Turn; history: Message[] }> {
    const { projection, body } = this.project(profile, history, budget, contextBytes, progress);
    const replay = this.readReply(c, profile, projection, body, step);
    if (replay) return replay;
    if (profile.fallbacks?.length) return this.nextHedged(c, profile, projection, body, budget, signal, step);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (profile.protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";
    if (profile.keyEnv) {
      const key = process.env[profile.keyEnv]; if (!key) throw new FatalAttemptError(`Missing credential environment: ${profile.keyEnv}`);
      headers[profile.protocol === "anthropic" ? "x-api-key" : "authorization"] = profile.protocol === "anthropic" ? key : `Bearer ${key}`;
    }
    const provider = digest({ quotaPool: profile.quotaPool ?? `${profile.url}#${profile.model}` });
    const id = await this.journal.reserve(c, provider, body, budget, signal);
    let completed = false;
    const combined = createCombinedAbortSignal(signal, { timeoutMs: budget.requestTimeoutMs });
    try {
      const response = await boundedFetch(this.fetcher, profile.url, { method: "POST", headers, body: canonical(body), redirect: "error", signal: combined.signal });
      if (!response.ok) {
        discardResponse(response);
        // Error bodies may contain credentials or upstream internals. Do not log them.
        this.journal.complete(id, null, { httpStatus: response.status }); completed = true;
        if (transientStatus(response.status))
          throw new DeferredAttemptError("provider", this.journal.providerFailure(id, response.headers.get("retry-after"), response.status),
            `Provider HTTP ${response.status}; resume scheduled`);
        throw new FatalAttemptError(`Model HTTP ${response.status}; credentials/configuration require attention`);
      }
      const raw = await boundedJson(response, budget.maxToolOutputBytes, combined.signal);
      const turn = decodeTurn(profile.protocol, raw);
      this.journal.complete(id, turn.tokens, raw, step); completed = true;
      signal.throwIfAborted(); this.journal.assertLease(c);
      this.journal.providerSuccess(id);
      if (turn.truncated) throw new FatalAttemptError("Model output truncated; admit more output or split task");
      return { turn, history: projection };
    } catch (e) {
      signal.throwIfAborted();
      if (e instanceof DeferredAttemptError) throw e;
      if (isTransportFailure(e) || combined.signal.aborted)
        throw new DeferredAttemptError("provider", this.journal.providerFailure(id), "Provider transport unavailable; replay-safe continuation scheduled");
      throw e;
    } finally {
      combined.cleanup();
      if (!completed) this.journal.complete(id, null, null);
    }
  }
}

/** Inspect bounded cause chains; syntax/schema errors are NOT network outages. */
export function isTransportFailure(error: unknown): boolean {
  let e = error as any; const seen = new Set<unknown>();
  for (let n = 0; e && n < 8 && !seen.has(e); n++, e = e.cause) {
    seen.add(e);
    if (["TimeoutError", "APIConnectionError"].includes(e.name) ||
      ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(e.code) ||
      (e instanceof TypeError && /fetch failed|network|connection/i.test(e.message))) return true;
  }
  return false;
}
