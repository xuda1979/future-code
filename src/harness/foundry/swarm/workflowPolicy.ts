import { randomUUID } from "node:crypto";
import { canonical, digest, invariant } from "../kernel.ts";
import { applyWorkflowProposal, workflowObservation, workflowVersions } from "../workflow.ts";
import type { Store } from "../store.ts";
import type { Json } from "../types.ts";
import { createCombinedAbortSignal } from "../../../utils/combinedAbortSignal.ts";
import { type PinnedSwarm } from "./config.ts";
import { boundedJson, isTransportFailure } from "./model.ts";
import { decodeResponse } from "./response.ts";
import { SessionJournal } from "./session.ts";
import { decodeSpawnChildren, spawnChildrenSchema } from "./spawn.ts";
import { boundedFetch, discardResponse } from "./transport.ts";
import { transientStatus } from "./providerRecovery.ts";

const TOOL = "propose_workflow";
const integer = { type: "integer", minimum: 0 };
export function workflowPolicyMetrics(store: Store, run: string): Json {
  const installed = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_reviews'").get();
  const reviews = installed ? store.db.prepare("SELECT status,COUNT(*) AS n FROM workflow_reviews WHERE run=? GROUP BY status").all(run) : [];
  const decisions = store.db.prepare(`SELECT a.verdict,COUNT(*) AS n FROM kernel_admissions a
    JOIN kernel_proposals p ON p.id=a.proposal WHERE p.run=? AND p.kind='POLICY' GROUP BY a.verdict`).all(run);
  const usage = store.db.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(bytes),0) AS request_bytes,
    COALESCE(SUM(tokens),0) AS tokens,COUNT(*)-COUNT(tokens) AS unknown_tokens
    FROM agent_requests WHERE run=? AND task='__workflow__'`).get(run)!;
  return { reviews: Object.fromEntries(reviews.map(row => [row.status, Number(row.n)])),
    decisions: Object.fromEntries(decisions.map(row => [row.verdict, Number(row.n)])),
    requests: Number(usage.requests), requestBytes: Number(usage.request_bytes),
    tokens: usage.unknown_tokens ? null : Number(usage.tokens), costUsd: null };
}
export const workflowProposalSchema = {
  type: "object", additionalProperties: false,
  properties: { schema: { type: "integer", enum: [1] }, expectedGraphVersion: integer,
    expectedPolicyVersion: integer, expectedStateVersion: integer,
    reason: { type: "string", minLength: 1, maxLength: 2048 },
    operations: { type: "array", maxItems: 16, items: { oneOf: [
      { type: "object", additionalProperties: false, required: ["op", "taskId", "children"],
        properties: { op: { type: "string", enum: ["expand_task"] }, taskId: { type: "string" }, children: spawnChildrenSchema } },
      { type: "object", additionalProperties: false, required: ["op", "taskId", "timeoutMs"],
        properties: { op: { type: "string", enum: ["set_task_timeout"] }, taskId: { type: "string" }, timeoutMs: { type: "integer", minimum: 1 } } },
      { type: "object", additionalProperties: false, required: ["op", "parallelism"],
        properties: { op: { type: "string", enum: ["set_parallelism"] }, parallelism: { type: "integer", minimum: 1 } } },
    ] } },
  },
  required: ["schema", "expectedGraphVersion", "expectedPolicyVersion", "expectedStateVersion", "reason", "operations"],
};

/** One independent role over existing external APIs. Durable review reservations
 * prevent competing hosts from spending on the same review. Unknown outbound
 * work is never assumed free or automatically resubmitted. */
export class WorkflowPolicyAgent {
  readonly store: Store;
  readonly cfg: PinnedSwarm;
  readonly journal: SessionJournal;
  readonly fetcher: typeof fetch;
  readonly owner = randomUUID();
  private nextCheckAt = 0;
  constructor(store: Store, cfg: PinnedSwarm, fetcher: typeof fetch = fetch) {
    this.store = store; this.cfg = cfg; this.fetcher = fetcher; this.journal = new SessionJournal(store);
    invariant(cfg.spec.supervision?.workflowPolicy, "workflow policy is not configured");
    store.db.exec(`CREATE TABLE IF NOT EXISTS workflow_reviews(
      run TEXT NOT NULL, round INTEGER NOT NULL, owner TEXT NOT NULL, created REAL NOT NULL, deadline REAL NOT NULL,
      trigger_hash TEXT NOT NULL, after_hash TEXT, request_hash TEXT NOT NULL, status TEXT NOT NULL,
      receipt_hash TEXT, PRIMARY KEY(run,round));`);
  }

  private body(run: string): Json {
    const p = this.cfg.spec.supervision!.workflowPolicy!, profile = this.cfg.spec.agents[p.agent];
    const instruction = [
      "You are the independent workflow policy adviser. Propose data only; the host decides authority and acceptance.",
      "Call propose_workflow exactly once. Copy the three expected versions from the observation.",
      "Prefer an empty operations array when a change has no clear benefit. State the measured bottleneck and intended benefit.",
      "Use only allowedOperations. Expand only unstarted READY tasks; preserve their goal and acceptance.",
      "Children use local IDs and dependsOn sibling IDs, inherit the parent's verified dependencies and must stay inside parent file scopes.",
      "Child input is explicit JSON; reference the problem in the parent goal when appropriate. Do not fabricate unseen evidence.",
      "Timeouts affect future leases only; parallelism is bounded by the admitted recipe. Ongoing work drains without preemption.",
      "Never request changes to checks, scopes, budgets, protocols or task outcomes. Agreement between agents is not proof.",
      "This is a bounded active-work page. Omitted nodes and truncated previews are unknown, not absent. Do not rewrite the whole graph.",
    ].join(" ");
    const packet = canonical({ observation: workflowObservation(this.store, run,
      { limit: p.maxSnapshotTasks, maxBytes: p.maxSnapshotBytes }),
      requestBudget: { maxRequests: this.cfg.spec.budget.maxRequests,
        maxRequestBytes: this.cfg.spec.budget.maxRequestBytes, modelConcurrency: this.cfg.spec.budget.modelConcurrency,
        used: this.journal.usage(run), costUsd: null },
      policy: { mode: p.mode, allowedOperations: p.allowedOperations, maxOperations: p.maxOperations,
        maxTaskTimeoutMs: p.maxTaskTimeoutMs, spawn: this.cfg.spec.supervision!.dynamicDAG ?? null },
      allowedAgents: Object.keys(this.cfg.spec.agents).sort() });
    const messages = [{ role: "user", content: packet }];
    const system = `${profile.system}\n\n${instruction}`;
    const description = "Propose one atomic bounded workflow patch, or retain the current workflow with operations=[]; never execute worker tools.";
    if (profile.protocol === "chat-completions") return { model: profile.model, stream: false,
      max_tokens: this.cfg.spec.budget.maxOutputTokens, messages: [{ role: "system", content: system }, ...messages],
      tools: [{ type: "function", function: { name: TOOL, description, parameters: workflowProposalSchema } }],
      tool_choice: { type: "function", function: { name: TOOL } } };
    return { model: profile.model, stream: false, max_tokens: this.cfg.spec.budget.maxOutputTokens,
      system: [{ type: "text", text: system }], messages,
      tools: [{ name: TOOL, description, input_schema: workflowProposalSchema }], tool_choice: { type: "tool", name: TOOL } };
  }

  private async query(run: string, body: Json, signal: AbortSignal): Promise<Json> {
    const profile = this.cfg.spec.agents[this.cfg.spec.supervision!.workflowPolicy!.agent];
    const budget = this.cfg.spec.budget, encoded = canonical(body);
    invariant(Buffer.byteLength(encoded) <= Math.min(budget.maxRequestBytes, this.cfg.spec.limits.contextBytes),
      "workflow provider envelope exceeds context/byte budget");
    const cached = this.journal.cachedRun(run, "__workflow__", body);
    if (cached !== null) return cached;
    const provider = digest({ quotaPool: profile.quotaPool ?? `${profile.url}#${profile.model}` });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (profile.protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";
    if (profile.keyEnv) {
      const key = process.env[profile.keyEnv]; invariant(key, "missing workflow policy credential");
      headers[profile.protocol === "anthropic" ? "x-api-key" : "authorization"] = profile.protocol === "anthropic" ? key : `Bearer ${key}`;
    }
    // Includes quota waiting, network and streamed-body decoding in one deadline.
    const combined = createCombinedAbortSignal(signal, { timeoutMs: budget.requestTimeoutMs });
    let id: string | undefined, recorded = false;
    try {
      id = await this.journal.reserveRun(run, "__workflow__", provider, body, budget, combined.signal);
      const response = await boundedFetch(this.fetcher, profile.url,
        { method: "POST", body: encoded, headers, redirect: "error", signal: combined.signal });
      if (!response.ok) {
        discardResponse(response);
        this.journal.complete(id, null, { httpStatus: response.status }); recorded = true;
        if (transientStatus(response.status)) this.journal.providerFailure(id, response.headers.get("retry-after"), response.status);
        throw new Error(`Workflow provider HTTP ${response.status}`);
      }
      const raw = await boundedJson(response, budget.maxToolOutputBytes, combined.signal);
      // Malformed calls still consume their actual metered request and tokens.
      const turn = decodeResponse(profile.protocol, raw);
      this.journal.complete(id, turn.tokens, raw); recorded = true;
      this.journal.providerSuccess(id);
      return raw;
    } catch (error) {
      if (id && !recorded) this.journal.complete(id, null, null);
      if (id && (isTransportFailure(error) || combined.signal.aborted) && !signal.aborted) this.journal.providerFailure(id);
      throw error;
    } finally { combined.cleanup(); }
  }

  private finish(run: string, round: number, body: Json, raw: Json): void {
    const p = this.cfg.spec.supervision!.workflowPolicy!, profile = this.cfg.spec.agents[p.agent];
    const turn = decodeResponse(profile.protocol, raw), calls = turn.message.calls ?? [];
    invariant(!turn.truncated && !turn.rejection && calls.length === 1 && calls[0].name === TOOL,
      "workflow policy must return exactly one complete proposal");
    const payload = calls[0].arguments;
    const assertCurrent = () => {
      const review = this.store.db.prepare("SELECT owner,status,deadline FROM workflow_reviews WHERE run=? AND round=?").get(run, round);
      invariant(review?.owner === this.owner && review.status === "ACTIVE" && review.deadline > Date.now(),
        "stale workflow review authority");
    };
    let receipt: Json;
    if (p.mode === "observe") {
      // A read-only rollout records the complete proposal and its input binding;
      // it cannot mutate a DAG or obtain an ADMIT receipt for later reuse.
      assertCurrent();
      receipt = { mode: "observe", requestHash: digest(body), proposal: payload };
    } else receipt = JSON.parse(canonical(applyWorkflowProposal(this.store, run, `review:${round}`, payload,
      { ...p, spawn: this.cfg.spec.supervision!.dynamicDAG },
      (parent, children) => decodeSpawnChildren(this.cfg.spec, parent, children), Date.now(),
      { observed: JSON.parse((body as any).messages.find((m: any) => m.role === "user").content).observation, assertCurrent })));
    this.store.transaction(() => {
      const hash = this.store.artifact(receipt);
      // A stale rejection did not consider the newly changed graph. Permit a
      // fresh bounded review of that state; do not mark it observed by accident.
      const after = (receipt as any).verdict === "ADMIT" ? (receipt as any).stateHash : null;
      this.store.db.prepare(`UPDATE workflow_reviews SET status='DONE',receipt_hash=?,after_hash=?
        WHERE run=? AND round=? AND owner=?`).run(hash, after, run, round, this.owner);
      this.store.event("workflow.policy.reviewed", { round, mode: p.mode, receiptHash: hash }, run);
    });
  }

  /** Called between scheduler refills. Disabled configurations never instantiate
   * this role. Cooldown checks do no graph scans and make no provider requests. */
  async review(run: string, signal: AbortSignal): Promise<void> {
    const now = Date.now(), p = this.cfg.spec.supervision!.workflowPolicy!;
    if (now < this.nextCheckAt || signal.aborted) return;
    this.nextCheckAt = now + p.minIntervalMs;
    let round: number | undefined;
    try {
      const work = this.store.transaction(() => {
        const pending = this.store.db.prepare("SELECT * FROM workflow_reviews WHERE run=? AND status='ACTIVE' ORDER BY round LIMIT 1").get(run);
        if (pending) {
          if (pending.deadline > now) return null;
          const body = this.store.readArtifact(String(pending.request_hash));
          const raw = this.journal.cachedRun(run, "__workflow__", body);
          if (raw !== null) {
            this.store.db.prepare("UPDATE workflow_reviews SET owner=?,deadline=? WHERE run=? AND round=?")
              .run(this.owner, now + this.cfg.spec.budget.requestTimeoutMs, run, pending.round);
            return { round: Number(pending.round), body, raw };
          }
          this.store.db.prepare("UPDATE workflow_reviews SET status='UNKNOWN' WHERE run=? AND round=?").run(run, pending.round);
          this.store.event("workflow.policy.unknown", { round: pending.round,
            reason: "expired review without a recorded response; no blind resubmission" }, run);
          return null;
        }
        const latest = this.store.db.prepare("SELECT * FROM workflow_reviews WHERE run=? ORDER BY round DESC LIMIT 1").get(run);
        const versions = workflowVersions(this.store, run), trigger = digest(versions);
        if (versions.status !== "RUNNING" || (latest && (latest.round >= p.maxReviews ||
          latest.trigger_hash === trigger || latest.after_hash === trigger || now < latest.created + p.minIntervalMs))) return null;
        if (!this.store.db.prepare("SELECT 1 FROM tasks WHERE run=? AND status IN ('READY','RUNNING') LIMIT 1").get(run)) return null;
        const n = Number(latest?.round ?? 0) + 1, body = this.body(run);
        this.store.db.prepare(`INSERT INTO workflow_reviews
          (run,round,owner,created,deadline,trigger_hash,request_hash,status) VALUES(?,?,?,?,?,?,?,'ACTIVE')`)
          .run(run, n, this.owner, now, now + this.cfg.spec.budget.requestTimeoutMs, trigger, this.store.artifact(body));
        this.store.event("workflow.policy.requested", { round: n, requestHash: digest(body), agent: p.agent }, run);
        return { round: n, body, raw: null };
      });
      if (!work) return;
      round = work.round;
      const raw = work.raw ?? await this.query(run, work.body, signal);
      signal.throwIfAborted();
      this.finish(run, round, work.body, raw);
    } catch {
      // Policy failure never fails a worker or changes acceptance. Avoid logging
      // arbitrary upstream bodies, model text or credential-bearing exceptions.
      if (round !== undefined) this.store.transaction(() => {
        this.store.db.prepare("UPDATE workflow_reviews SET status='ERROR' WHERE run=? AND round=? AND owner=?")
          .run(run, round, this.owner);
        this.store.event("workflow.policy.error", { round,
          reason: "policy review unavailable or invalid; worker scheduling continues" }, run);
      });
    }
  }
}
