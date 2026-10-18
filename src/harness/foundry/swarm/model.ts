import { spawnChildrenSchema } from "./spawn.ts";
import { canonical, digest, invariant } from "../kernel.ts";
import { DeferredAttemptError } from "../continuation.ts";
import { FatalAttemptError } from "../errors.ts";
import type { Capsule, Json } from "../types.ts";
import type { AgentProfile, ProviderRoute, SwarmBudget, ToolName } from "./config.ts";
import { bytes, compactHistory, refreshDiagnosticNotice, retireToolPreviews, type Message, type ProgressCheckpoint } from "./context.ts";
import { SessionJournal } from "./session.ts";
import { createCombinedAbortSignal } from "../../../utils/combinedAbortSignal.ts";
import { transientStatus } from "./providerRecovery.ts";
import { abortable, boundedFetch, discardResponse } from "./transport.ts";
import type { DiagnosticContext } from "./diagnostics.ts";
import { decodeResponse, type Turn } from "./response.ts";
import { isProviderTransportError } from "../../../utils/providerRetryPolicy.ts";
export { decodeTurn, type Turn } from "./response.ts";
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
  def("read_job_artifact", "Read a bounded log or structured-result artifact from this thread's completed job. Use its owned run_job result receipt and an artifact name from result.artifacts. Never resubmits work. Content is an observation, not acceptance; truncated logs retain only the manifest's captured bytes. offset/length are bytes; contentBase64 is lossless across UTF-8 boundaries.", {
    receipt: string, artifact: { type: "string", minLength: 1, maxLength: 128 },
    offset: integer, length: { type: "integer", minimum: 1, maximum: 8192 },
  }, ["receipt", "artifact"]),
  def("spawn_tasks", "Split this task into independently verifiable child tasks when parallel work will reduce the decision scope. The host validates scope, depth, count, dependencies and agent roster, releases this parent while children run, then resumes this exact tool call with verified child outputs.", {
    children: spawnChildrenSchema,
  }, ["children"]),
  def("list_files", "List tracked and new files in the task's readable scopes. Paginated; paths only.", { offset: integer, limit: { type: "integer", minimum: 1, maximum: 200 } }, []),
  def("read_file", "Read a bounded line range of a non-symlink UTF-8 file in readable scopes.", { path: string, start: { type: "integer", minimum: 1 }, lines: { type: "integer", minimum: 1, maximum: 300 } }, ["path"]),
  def("search_files", "Find case-sensitive literal text in scoped Git-tracked and nonignored new UTF-8 files. Returns line locations and bounded excerpts. Set contextLines (0..20) to include surrounding code in this same call, avoiding a search/read reasoning round trip; context.truncated marks omitted context. Narrow with a file/directory path; omit path for all readable scopes. Continue with nextCursor until null; skippedFiles reports unsearched inputs. Restart pagination after edits or worker replacement. This is source discovery, never a check or proof of absence.", {
    query: { type: "string", minLength: 1, maxLength: 256 }, path: string,
    limit: { type: "integer", minimum: 1, maximum: 100 },
    contextLines: { type: "integer", minimum: 0, maximum: 20 },
    cursor: { type: "object", properties: { path: string, line: { type: "integer", minimum: 1 } }, required: ["path", "line"], additionalProperties: false },
  }, ["query"]),
  def("write_file", "Write a UTF-8 file within the task's exclusive write scopes; use edit_file for small changes.", { path: string, content: string }, ["path", "content"]),
  def("edit_file", "Replace exactly one literal occurrence. A missing or ambiguous match is an error.", { path: string, oldText: string, newText: string }, ["path", "oldText", "newText"]),
  def("delete_file", "Delete one non-symlink file within the task's write scopes.", { path: string }, ["path"]),
  def("run_check", "Run a configured named check; arbitrary shell commands are not accepted.", { name: string }, ["name"]),
  def("run_probe", "Falsify one explicitly stated assumption using a permitted, operator-pinned micro-probe with a process deadline of at most two seconds. State the outcome that would refute it. Use a standalone reproduction and a negative control. A failed or inconclusive probe ends this diagnostic trajectory when debugging guardrails are enabled. A zero exit code is an observation, never acceptance.", {
    name: string, hypothesis: { type: "string", minLength: 1, maxLength: 512 },
    falsifyWhen: { type: "string", minLength: 1, maxLength: 512 },
    negativeControl: { type: "string", minLength: 1, maxLength: 256 },
  }, ["name", "hypothesis", "falsifyWhen", "negativeControl"]),
  def("save_progress", "Save an UNVERIFIED, bounded working-memory checkpoint before context retirement. Record only the current hypothesis, attempted methods, observed blockers, and exact next step; refer to owned receipt IDs for facts. It cannot change acceptance or frozen checks.", {
    summary: { type: "string", minLength: 1, maxLength: 1024 },
    nextAction: { type: "string", minLength: 1, maxLength: 512 },
    receipts: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string" } },
  }, ["summary", "nextAction", "receipts"]),
  def("recall", "Read owned receipts or prior events. Use memoryKind to find committed progress notes or failures, newest first, with optional exact patchHash/failureSignature filters and memoryBefore cursor. Memory is NOT acceptance. Choose one mode: receipt, historyAfter, or memoryKind. No other thread is accessible.",
    { receipt: string, offset: integer, length: { type: "integer", minimum: 1, maximum: 8192 }, historyAfter: integer,
      limit: { type: "integer", minimum: 1, maximum: 10 }, memoryKind: { type: "string", enum: ["all", "progress", "failure"] },
      memoryBefore: { type: "string", maxLength: 32 }, patchHash: string, failureSignature: string }, []),
];
const asJson = (x: unknown): Json => JSON.parse(canonical(x));
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
  private project(profile: AgentProfile, history: Message[], budget: SwarmBudget, contextBytes: number, progress: ProgressCheckpoint | null = null,
    diagnostics: DiagnosticContext | null = null): { projection: Message[]; body: Json } {
    let projection = refreshDiagnosticNotice(history, progress, diagnostics);
    let body = requestBody(profile, projection, budget);
    // All routes share one history projection and logical replay key. Reserve
    // enough envelope space for the longest encoded model identifier as well.
    const routeExtra = Math.max(0, ...(profile.fallbacks ?? []).map(route => bytes(route.model) - bytes(profile.model)));
    // Enforce the actual provider input, including system and tool definitions.
    if (bytes(body) + routeExtra > contextBytes) {
      const overhead = bytes(requestBody(profile, [], budget));
      const remaining = Math.max(0, contextBytes - overhead - routeExtra - 512);
      try { projection = compactHistory(projection, remaining, progress, diagnostics); }
      catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith("CONTEXT_OVERFLOW")) throw e;
        if (!profile.tools.includes("recall")) throw new FatalAttemptError(
          "CONTEXT_OVERFLOW: retiring tool previews requires the admitted recall capability; split the task or configure recall");
        try { projection = compactHistory(retireToolPreviews(projection), remaining, progress, diagnostics); }
        catch (e) { throw new FatalAttemptError(e instanceof Error ? e.message : "CONTEXT_OVERFLOW"); }
      }
      body = requestBody(profile, projection, budget);
    }
    if (bytes(body) + routeExtra > contextBytes) throw new FatalAttemptError("CONTEXT_OVERFLOW: encoded provider request exceeds admitted context");
    return { projection, body };
  }
  private readReply(c: Capsule, profile: AgentProfile, projection: Message[], body: Json, step: number): { turn: Turn; history: Message[] } | null {
    const raw = this.journal.cached(c, step, body);
    if (raw === null) return null;
    const turn = decodeResponse(profile.protocol, raw);
    if (turn.truncated) throw new FatalAttemptError("Model output truncated");
    return { turn, history: projection };
  }
  /** Consume a durable reply before recovery/checkpoint diagnostics mutate its
   * original input. No RPC, reservation, or spend is generated by replay. */
  replay(c: Capsule, profile: AgentProfile, history: Message[], budget: SwarmBudget, contextBytes: number, step: number, progress: ProgressCheckpoint | null = null,
    diagnostics: DiagnosticContext | null = null): { turn: Turn; history: Message[] } | null {
    if (!this.journal.hasReply(c, step)) return null;
    const { projection, body } = this.project(profile, history, budget, contextBytes, progress, diagnostics);
    return this.readReply(c, profile, projection, body, step);
  }
  private async nextHedged(c: Capsule, profile: AgentProfile, projection: Message[], body: Json,
    budget: SwarmBudget, signal: AbortSignal, step: number): Promise<{ turn: Turn; history: Message[] }> {
    const routes: ProviderRoute[] = [
      { url: profile.url, model: profile.model, keyEnv: profile.keyEnv, allowHttp: profile.allowHttp, quotaPool: profile.quotaPool },
      ...(profile.fallbacks ?? []),
    ];
    type Outcome = { index: number; kind: "success"; turn: Turn } |
      { index: number; kind: "rejected"; turn: Turn; request: string } |
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
        const wireBody = { ...(body as Record<string, Json>), model: route.model };
        id = await this.journal.reserve(c, provider, wireBody, budget, admission.signal, body);
        combined = createCombinedAbortSignal(admission.signal, { timeoutMs: budget.requestTimeoutMs });
        const response = await boundedFetch(this.fetcher, route.url, {
          method: "POST", headers, body: canonical(wireBody), redirect: "error", signal: combined.signal,
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
        const turn = decodeResponse(profile.protocol, raw);
        this.journal.providerSuccess(id);
        if (turn.truncated) {
          this.journal.complete(id, turn.tokens, raw); completed = true;
          return { index, kind: "failure", transient: false,
            error: new FatalAttemptError("Model output truncated; admit more output or split task") };
        }
        if (turn.rejection) {
          // Prefer a valid fallback, but retain every route's actual spend.
          this.journal.complete(id, turn.tokens, raw); completed = true;
          return { index, kind: "rejected", turn, request: id };
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
    const rejections: Extract<Outcome, { kind: "rejected" }>[] = [];
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
        if (outcome.kind === "rejected") rejections.push(outcome);
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
    if (rejections.length) {
      signal.throwIfAborted(); this.journal.assertLease(c);
      const rejected = rejections.sort((a, b) => a.index - b.index)[0]!;
      this.journal.publishReply(rejected.request, step);
      // Another current response may have won while this host was draining.
      const selected = this.readReply(c, profile, projection, body, step);
      invariant(selected, "rejected response lost its current lease");
      return selected;
    }
    const allFatal = failures.length > 0 && failures.every(x => !x.transient);
    if (allFatal) throw failures[0].error;
    const wakes = failures.filter(x => x.transient && x.wakeAt !== undefined).map(x => x.wakeAt!);
    throw new DeferredAttemptError("provider",
      wakes.length ? Math.max(Date.now(), Math.min(...wakes)) : Date.now() + 1000,
      "All configured external model routes were unavailable; resume scheduled");
  }

  async next(c: Capsule, profile: AgentProfile, history: Message[], budget: SwarmBudget, contextBytes: number, signal: AbortSignal, step = 0, progress: ProgressCheckpoint | null = null,
    diagnostics: DiagnosticContext | null = null): Promise<{ turn: Turn; history: Message[] }> {
    const { projection, body } = this.project(profile, history, budget, contextBytes, progress, diagnostics);
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
      const turn = decodeResponse(profile.protocol, raw);
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
  return isProviderTransportError(error);
}
