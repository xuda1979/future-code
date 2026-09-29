import { setTimeout as delay } from "node:timers/promises";
import { canonical, digest, invariant } from "../kernel.ts";
import { FatalAttemptError } from "../errors.ts";
import type { Store } from "../store.ts";
import type { Json, Task } from "../types.ts";
import type { AgentProfile, PinnedSwarm, Protocol } from "./config.ts";
import { boundedJson, isTransportFailure } from "./model.ts";
import { SessionJournal } from "./session.ts";
import type { RecoveryContext, RecoveryPlan, RecoveryPlanner } from "./supervisor.ts";

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const TOOL = "propose_recovery_plan";

const taskSchema: Json = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    agent: { type: "string" },
    goal: { type: "string" },
    acceptance: { type: "array", minItems: 1, items: { type: "string" } },
    dependencies: { type: "array", items: { type: "string" } },
    writeScope: { type: "array", items: { type: "string" } },
    readScope: { type: "array", items: { type: "string" } },
    input: {},
    priority: { type: "number" },
    estimatedDurationMs: { type: "integer", minimum: 1 },
    contextBudget: { type: "integer", minimum: 1 },
  },
  required: ["id", "goal", "acceptance", "dependencies", "writeScope", "readScope", "input"],
};

const inputSchema: Json = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["replan", "decline"] },
    reason: { type: "string" },
    tasks: { type: "array", items: taskSchema },
  },
  required: ["decision", "reason", "tasks"],
};

function requestBody(profile: AgentProfile, context: RecoveryContext, cfg: PinnedSwarm): Json {
  const instruction = [
    "You are Future-Code's bounded recovery planner.",
    "Do not execute code and do not change model/provider settings, inference engines, KV caches, credentials, checks, protected paths, resource ceilings, or the objective.",
    "Use only the listed existing agent profiles. Prefer a smaller, materially different DAG that addresses the concrete failures.",
    "Do not widen file authority beyond the previous plan; the host enforces this independently.",
    "If there is no safe useful replan, decline.",
    "Call the recovery-plan tool exactly once.",
  ].join(" ");
  const packet = canonical({
    objectiveId: context.objectiveId,
    goal: context.goal,
    runId: context.runId,
    revision: context.revision,
    failureReason: context.reason,
    failures: context.failures,
    previousTasks: context.tasks,
    allowedAgents: Object.keys(cfg.spec.agents).sort(),
    protectedPaths: cfg.spec.protectedPaths,
    taskLimit: cfg.spec.limits.tasks,
  });
  if (profile.protocol === "chat-completions") {
    return {
      model: profile.model,
      max_tokens: cfg.spec.budget.maxOutputTokens,
      stream: false,
      messages: [
        { role: "system", content: `${profile.system}\n\n${instruction}` },
        { role: "user", content: packet },
      ],
      tools: [{ type: "function", function: {
        name: TOOL,
        description: "Return one bounded recovery decision and, when replanning, a complete replacement Task[] DAG.",
        parameters: inputSchema,
      } }],
      tool_choice: { type: "function", function: { name: TOOL } },
    };
  }
  return {
    model: profile.model,
    max_tokens: cfg.spec.budget.maxOutputTokens,
    stream: false,
    system: [{ type: "text", text: `${profile.system}\n\n${instruction}` }],
    messages: [{ role: "user", content: [{ type: "text", text: packet }] }],
    tools: [{ name: TOOL,
      description: "Return one bounded recovery decision and, when replanning, a complete replacement Task[] DAG.",
      input_schema: inputSchema }],
    tool_choice: { type: "tool", name: TOOL },
  };
}

function toolInput(protocol: Protocol, raw: any): Record<string, unknown> {
  if (protocol === "chat-completions") {
    invariant(Array.isArray(raw?.choices) && raw.choices.length === 1, "invalid recovery planner response");
    const calls = raw.choices[0]?.message?.tool_calls;
    invariant(Array.isArray(calls) && calls.length === 1 && calls[0]?.type === "function" &&
      calls[0]?.function?.name === TOOL && typeof calls[0]?.function?.arguments === "string",
    "recovery planner must call the recovery-plan tool exactly once");
    const value = JSON.parse(calls[0].function.arguments);
    invariant(value && typeof value === "object" && !Array.isArray(value), "invalid recovery plan payload");
    return value;
  }
  invariant(Array.isArray(raw?.content), "invalid recovery planner response");
  const calls = raw.content.filter((block: any) => block?.type === "tool_use" && block?.name === TOOL);
  invariant(calls.length === 1 && calls[0].input && typeof calls[0].input === "object" &&
    !Array.isArray(calls[0].input), "recovery planner must call the recovery-plan tool exactly once");
  return calls[0].input;
}

function decodePlan(protocol: Protocol, raw: any): RecoveryPlan | null {
  const value = toolInput(protocol, raw);
  invariant(value.decision === "replan" || value.decision === "decline", "invalid recovery decision");
  invariant(typeof value.reason === "string" && value.reason.trim().length > 0 &&
    Buffer.byteLength(value.reason) <= 4096, "invalid recovery reason");
  invariant(Array.isArray(value.tasks), "invalid recovery tasks");
  if (value.decision === "decline") {
    invariant(value.tasks.length === 0, "declined recovery must not include tasks");
    return null;
  }
  invariant(value.tasks.length > 0, "recovery replan requires tasks");
  canonical(value.tasks);
  return { reason: value.reason, tasks: value.tasks as Task[] };
}

function usageTokens(raw: any, protocol: Protocol): number | null {
  const u = raw?.usage;
  if (!u || typeof u !== "object") return null;
  const ns = protocol === "anthropic"
    ? [u.input_tokens, u.output_tokens, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0]
    : [u.prompt_tokens, u.completion_tokens];
  if (ns.some(x => x === undefined || x === null)) return null;
  invariant(ns.every(x => Number.isSafeInteger(x) && x >= 0), "invalid provider usage");
  const total = ns.reduce((a, b) => a + b, 0);
  invariant(Number.isSafeInteger(total), "provider usage overflow");
  return total;
}

function headers(profile: AgentProfile): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  if (profile.protocol === "anthropic") out["anthropic-version"] = "2023-06-01";
  if (profile.keyEnv) {
    const key = process.env[profile.keyEnv];
    if (!key) throw new FatalAttemptError(`Missing credential environment: ${profile.keyEnv}`);
    out[profile.protocol === "anthropic" ? "x-api-key" : "authorization"] =
      profile.protocol === "anthropic" ? key : `Bearer ${key}`;
  }
  return out;
}

/** Create a bounded recovery planner that uses an already configured external LLM API.
 * The provider proposes data only; Supervisor remains the sole authority that can admit a run. */
export function createApiRecoveryPlanner(store: Store, cfg: PinnedSwarm,
  fetcher: typeof fetch = fetch): RecoveryPlanner {
  const agent = cfg.spec.supervision?.recoveryAgent ?? cfg.spec.defaultAgent;
  const profile = cfg.spec.agents[agent];
  invariant(profile, "unknown recovery agent");
  const journal = new SessionJournal(store);
  return async (context, signal) => {
    const body = requestBody(profile, context, cfg);
    const encoded = canonical(body);
    invariant(Buffer.byteLength(encoded) <= cfg.spec.budget.maxRequestBytes,
      "recovery planner request exceeds configured request-byte budget");
    const provider = digest({ url: profile.url });
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const requestId = await journal.reserveRun(context.runId, "__recovery__", provider, body, cfg.spec.budget, signal);
      let recorded = false;
      store.event("objective.recovery.model.request", {
        objectiveId: context.objectiveId, run: context.runId, revision: context.revision,
        agent, provider, attempt: attempt + 1, requestBytes: Buffer.byteLength(encoded),
      }, context.runId);
      try {
        const timeout = AbortSignal.timeout(cfg.spec.budget.requestTimeoutMs);
        const response = await fetcher(profile.url, {
          method: "POST", headers: headers(profile), body: encoded, redirect: "error",
          signal: AbortSignal.any([signal, timeout]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          journal.complete(requestId, null, null); recorded = true;
          if (TRANSIENT.has(response.status) && attempt === 0) {
            journal.cooldown(provider, 250);
            await delay(250, undefined, { signal });
            continue;
          }
          throw new FatalAttemptError(`Recovery model HTTP ${response.status}; provider/configuration requires attention`);
        }
        const raw = await boundedJson(response, cfg.spec.budget.maxToolOutputBytes);
        journal.complete(requestId, usageTokens(raw, profile.protocol), raw); recorded = true;
        const plan = decodePlan(profile.protocol, raw);
        store.event("objective.recovery.model.reply", {
          objectiveId: context.objectiveId, run: context.runId, revision: context.revision,
          agent, provider, decision: plan ? "replan" : "decline",
          proposalHash: digest(plan ?? { declined: true }),
        }, context.runId);
        return plan;
      } catch (error) {
        if (!recorded) journal.complete(requestId, null, null);
        signal.throwIfAborted();
        if (attempt === 0 && isTransportFailure(error)) {
          journal.cooldown(provider, 250);
          await delay(250, undefined, { signal });
          continue;
        }
        throw error;
      }
    }
    throw new Error("recovery planner retry budget exhausted");
  };
}
