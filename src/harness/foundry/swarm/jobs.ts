import { DeferredAttemptError } from "../continuation.ts";
import { FatalAttemptError } from "../errors.ts";
import { checkPins } from "../commands.ts";
import { runPlanValidation } from "../researchValidation.ts";
import { canonical, digest, identifier, invariant } from "../kernel.ts";
import type { Store } from "../store.ts";
import type { Capsule, Json } from "../types.ts";
import type { PinnedSwarm, AgentProfile, JobTemplate } from "./config.ts";
import { keys } from "./config.ts";
import type { Call } from "./context.ts";
import { SessionJournal, type ThreadState } from "./session.ts";
import { jobPreflight } from "./decisions.ts";
import { runProcess } from "./process.ts";
import { createCombinedAbortSignal } from "../../../utils/combinedAbortSignal.ts";
import { abortable } from "./transport.ts";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { theoryPremises } from "./theory.ts";
import { experimentBinding, experimentPromotion, installExperimentPipelines, recordExperimentInput } from "./experimentPipeline.ts";

/** Host-only polling advice. No effect on remote identity or acceptance. */
export function nextRemotePollMs(template: Pick<JobTemplate, "pollMs" | "maxPollMs">, idlePolls: number): number {
  const ceiling = template.maxPollMs ?? template.pollMs;
  if (!Number.isSafeInteger(idlePolls) || idlePolls < 0) return template.pollMs;
  return Math.min(ceiling, template.pollMs * 2 ** Math.min(30, Math.max(0, idlePolls - 1)));
}

export interface JobReply {
  schema: 1; key: string; jobId: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
  /** Stable semantic milestone, e.g. training step, NOT current time/heartbeat. */
  progressToken?: string;
  result?: Json;
}
export type JobRPC = (command: NonNullable<PinnedSwarm["jobAdapters"]>[string], cfg: PinnedSwarm,
  request: Json, signal: AbortSignal) => Promise<unknown>;
const defaultRPC: JobRPC = async (command, cfg, request, signal) => {
  const result = await runProcess(command, cfg.spec.project, [], signal,
    cfg.spec.budget.toolTimeoutMs, cfg.spec.budget.maxToolOutputBytes, canonical(request));
  if (result.code === 64) throw new FatalAttemptError("JOB_ADAPTER_REQUIRES_RECONCILIATION");
  invariant(result.code === 0, "job adapter failed; remote outcome may be unknown");
  try { return JSON.parse(result.stdout); } catch { throw new FatalAttemptError("MALFORMED_JOB_ADAPTER_REPLY"); }
};


function tableExists(store: Store, name: string): boolean {
  return !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function objectiveForRun(store: Store, run: string): string | null {
  if (!tableExists(store, "swarm_objective_revisions") || !tableExists(store, "swarm_objectives")) return null;
  const rows = store.db.prepare(`SELECT objective AS id FROM swarm_objective_revisions WHERE run=?
    UNION SELECT id FROM swarm_objectives WHERE run=?`).all(run, run);
  const ids = [...new Set(rows.map(row => String(row.id)))];
  invariant(ids.length <= 1, "run belongs to multiple objectives");
  return ids[0] ?? null;
}

const objectiveRunClause = `run IN (
  SELECT run FROM swarm_objective_revisions WHERE objective=?
  UNION SELECT run FROM swarm_objectives WHERE id=? AND run IS NOT NULL
)`;

export interface ObjectiveJobUsage {
  template: string;
  used: number;
  unresolved: number;
  maxPerRun: number;
  maxObjectiveJobs: number;
}

export interface ExternalEffectSnapshot {
  count: number;
  unresolved: number;
  byTemplate: Record<string, number>;
  records: Json[];
}

/** Host-measured remote-compute consumption across the full durable objective
 * lineage. It never trusts model-authored cost or completion claims. */
export function objectiveJobUsage(store: Store, cfg: PinnedSwarm, objective: string): ObjectiveJobUsage[] {
  const jobs = Object.entries(cfg.spec.jobs ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const measurable = tableExists(store, "research_jobs") &&
    tableExists(store, "swarm_objective_revisions") && tableExists(store, "swarm_objectives");
  return jobs.map(([template, spec]) => {
    const row = measurable ? store.db.prepare(`SELECT COUNT(*) AS used,
      COALESCE(SUM(CASE WHEN result_hash IS NULL THEN 1 ELSE 0 END),0) AS unresolved
      FROM research_jobs WHERE template=? AND ${objectiveRunClause}`)
      .get(template, objective, objective) : { used: 0, unresolved: 0 };
    return {
      template,
      used: Number(row?.used ?? 0),
      unresolved: Number(row?.unresolved ?? 0),
      maxPerRun: spec.maxJobs,
      maxObjectiveJobs: spec.maxObjectiveJobs ?? spec.maxJobs,
    };
  });
}

/** Deterministic external-effect ledger used by the objective completion gate
 * and attestation. Terminal receipts are re-read so corrupted result or
 * reconciliation artifacts fail closed. */
export function externalEffectSnapshot(store: Store, run: string, objective?: string): ExternalEffectSnapshot {
  if (!tableExists(store, "research_jobs"))
    return { count: 0, unresolved: 0, byTemplate: {}, records: [] };
  let rows: Record<string, any>[];
  if (objective && tableExists(store, "swarm_objective_revisions") && tableExists(store, "swarm_objectives")) {
    rows = store.db.prepare(`SELECT key,run,task,template,input_hash,job_id,status,result_hash,reconciliation_hash
      FROM research_jobs WHERE ${objectiveRunClause} ORDER BY template,key`).all(objective, objective);
  } else {
    rows = store.db.prepare(`SELECT key,run,task,template,input_hash,job_id,status,result_hash,reconciliation_hash
      FROM research_jobs WHERE run=? ORDER BY template,key`).all(run);
  }
  const byTemplate: Record<string, number> = {};
  let unresolved = 0;
  const records = rows.map(row => {
    byTemplate[String(row.template)] = (byTemplate[String(row.template)] ?? 0) + 1;
    if (row.result_hash == null) unresolved++;
    else {
      invariant(typeof row.reconciliation_hash === "string",
        "terminal external job missing reconciliation proof");
      store.readArtifact(String(row.result_hash));
      store.readArtifact(String(row.reconciliation_hash));
    }
    return JSON.parse(canonical({
      key: String(row.key), run: String(row.run), task: String(row.task),
      template: String(row.template), inputHash: String(row.input_hash),
      jobId: row.job_id == null ? null : String(row.job_id), status: String(row.status),
      resultHash: row.result_hash == null ? null : String(row.result_hash),
      reconciliationHash: row.reconciliation_hash == null ? null : String(row.reconciliation_hash),
    })) as Json;
  });
  return { count: rows.length, unresolved, byTemplate, records };
}

/** Durable external jobs share Foundry's DB. No LLM is used to poll.
 * The adapter is trusted and pinned. ensure(key) MUST implement remote dedupe.
 * After a jobId is known, only inspect is sent, even after disconnect/not-found. */
export class ResearchJobs {
  readonly journal: SessionJournal;
  readonly cfg: PinnedSwarm;
  readonly rpc: JobRPC;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  // Coalesced callers share one remote observation, not one poll/failure each.
  private readonly observedRPCs = new WeakSet<Promise<unknown>>();
  private readonly failedRPCs = new WeakSet<Promise<unknown>>();
  constructor(journal: SessionJournal, cfg: PinnedSwarm, rpc: JobRPC = defaultRPC) {
    this.journal = journal; this.cfg = cfg; this.rpc = rpc;
    installExperimentPipelines(journal.store);
    journal.store.db.exec(`CREATE TABLE IF NOT EXISTS research_jobs(
      key TEXT PRIMARY KEY, run TEXT NOT NULL, task TEXT NOT NULL, template TEXT NOT NULL,
      input_hash TEXT NOT NULL, created REAL NOT NULL, progress_at REAL NOT NULL,
      progress_token TEXT, poll_at REAL NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
      job_id TEXT, status TEXT NOT NULL, result_hash TEXT, updated REAL NOT NULL,
      reconciliation_hash TEXT, progress_rank INTEGER NOT NULL DEFAULT 0, stale_at REAL,
      idle_polls INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS research_jobs_run ON research_jobs(run,task);
      CREATE TABLE IF NOT EXISTS research_plan_reports(
        key TEXT NOT NULL, validator TEXT NOT NULL, implementation_hash TEXT NOT NULL,
        request_hash TEXT NOT NULL, report_hash TEXT NOT NULL, PRIMARY KEY(key,validator));
      CREATE TABLE IF NOT EXISTS research_job_progress(
        key TEXT NOT NULL, token TEXT NOT NULL, observed REAL NOT NULL,
        PRIMARY KEY(key,token));`);
    const columns = new Set(journal.store.db.prepare("PRAGMA table_info(research_jobs)").all().map(r => String(r.name)));
    if (!columns.has("reconciliation_hash"))
      journal.store.db.exec("ALTER TABLE research_jobs ADD COLUMN reconciliation_hash TEXT");
    if (!columns.has("progress_rank"))
      journal.store.db.exec("ALTER TABLE research_jobs ADD COLUMN progress_rank INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("stale_at"))
      journal.store.db.exec("ALTER TABLE research_jobs ADD COLUMN stale_at REAL");
    if (!columns.has("idle_polls"))
      journal.store.db.exec("ALTER TABLE research_jobs ADD COLUMN idle_polls INTEGER NOT NULL DEFAULT 0");
    journal.store.db.exec(`CREATE INDEX IF NOT EXISTS research_jobs_run_template ON research_jobs(run,template);
      CREATE INDEX IF NOT EXISTS research_jobs_live_template ON research_jobs(template) WHERE result_hash IS NULL;
      CREATE INDEX IF NOT EXISTS research_jobs_receipt ON research_jobs(run,task,result_hash);
      CREATE INDEX IF NOT EXISTS research_jobs_template_history ON research_jobs(template,updated);`);
  }
  /** Read-only RPC on an existing terminal job. An artifact reference never
   * grants another thread's data, changes acceptance, or calls ensure again. */
  async readArtifact(c: Capsule, profile: AgentProfile, call: Call, signal: AbortSignal,
    onRpc?: (durationMs: number) => void): Promise<Json> {
    this.journal.assertLease(c); signal.throwIfAborted();
    keys(call.arguments, ["receipt", "artifact"], ["offset", "length"]);
    const a = call.arguments, offset = a.offset ?? 0, length = a.length ?? 4096;
    invariant(Number.isSafeInteger(offset) && (offset as number) >= 0 &&
      Number.isSafeInteger(length) && (length as number) > 0 && (length as number) <= 8192, "invalid artifact range");
    invariant(typeof a.receipt === "string" && this.journal.ownsReceipt(c, a.receipt), "job result not owned by this thread");
    invariant(typeof a.artifact === "string", "invalid job artifact name"); identifier(a.artifact);
    const store = this.journal.store;
    const row = store.db.prepare("SELECT * FROM research_jobs WHERE run=? AND task=? AND result_hash=?")
      .get(c.runId, c.task.id, a.receipt);
    invariant(row && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(row.status), "receipt is not a terminal job result");
    invariant(profile.jobs?.includes(row.template), "job artifact capability denied");
    const command = this.cfg.jobAdapters?.[row.template];
    invariant(command && this.cfg.spec.jobs?.[row.template]?.idempotentEnsure, "job adapter not pinned");
    checkPins(command);
    const original = store.readArtifact(a.receipt) as any;
    const meta = original?.result?.artifacts?.[a.artifact];
    invariant(original?.key === row.key && original?.jobId === row.job_id && original?.status === row.status &&
      Object.hasOwn(original?.result?.artifacts ?? {}, a.artifact) && meta && typeof meta.sha256 === "string" && /^[a-f0-9]{64}$/.test(meta.sha256) &&
      Number.isSafeInteger(meta.bytes) && meta.bytes >= 0, "missing or invalid terminal artifact manifest");
    const request = { schema: 1, operation: "read_artifact", key: row.key, jobId: row.job_id,
      artifact: a.artifact, offset, length } as Json;
    const started = performance.now(), deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.cfg.spec.budget.toolTimeoutMs);
    const bounded = createCombinedAbortSignal(signal, { signalB: deadline.signal });
    let raw: unknown;
    try { raw = await abortable(this.rpc(command, this.cfg, request, bounded.signal), bounded.signal); }
    finally { clearTimeout(timer); bounded.cleanup(); onRpc?.(Math.max(0, performance.now() - started)); }
    signal.throwIfAborted(); this.journal.assertLease(c);
    const v = raw as Record<string, any>;
    let content: Buffer;
    try {
      invariant(Buffer.byteLength(canonical(v)) <= this.cfg.spec.budget.maxToolOutputBytes, "artifact response too large");
      keys(v, ["schema", "key", "jobId", "artifact", "sha256", "offset", "bytes", "contentBase64", "nextOffset"]);
      invariant(v.schema === 1 && v.key === row.key && v.jobId === row.job_id && v.artifact === a.artifact &&
        v.sha256 === meta.sha256 && v.offset === offset && v.bytes === meta.bytes, "artifact reply binding changed");
      invariant(typeof v.contentBase64 === "string", "artifact page must be base64");
      content = Buffer.from(v.contentBase64, "base64");
      invariant(content.toString("base64") === v.contentBase64 &&
        content.length === Math.max(0, Math.min(length as number, meta.bytes - (offset as number))), "invalid artifact page bytes");
      if (offset === 0 && content.length === meta.bytes)
        invariant(createHash("sha256").update(content).digest("hex") === meta.sha256, "complete artifact checksum changed");
      invariant(v.nextOffset === ((offset as number) + content.length < meta.bytes
        ? (offset as number) + content.length : null), "invalid artifact continuation");
    } catch { throw new FatalAttemptError("INVALID_JOB_ARTIFACT_REPLY: exact terminal artifact binding required"); }
    return { ...v, sourceReceipt: a.receipt, content: content!.toString("utf8"),
      trust: "OBSERVATION_NOT_ACCEPTANCE" } as Json;
  }
  async execute(c: Capsule, profile: AgentProfile, call: Call, signal: AbortSignal,
    onRpc?: (durationMs: number) => void): Promise<Json> {
    this.journal.assertLease(c); signal.throwIfAborted();
    keys(call.arguments, ["name", "input"]);
    const name = call.arguments.name;
    invariant(typeof name === "string" && profile.jobs?.includes(name), "job capability denied");
    const template = this.cfg.spec.jobs?.[name]; const command = this.cfg.jobAdapters?.[name];
    invariant(template && command && template.idempotentEnsure, "job adapter not pinned");
    checkPins(command); // Configuration drift is not a transient network failure.
    const store = this.journal.store; const input = call.arguments.input;
    const objective = objectiveForRun(store, c.runId);
    invariant(Buffer.byteLength(canonical(input)) <= this.cfg.spec.budget.maxToolOutputBytes, "job input too large");
    if (template.research) invariant(digest(input) === digest(template.research.spec.input), "experiment input differs from frozen research protocol");
    const experiment = experimentBinding(store, this.cfg, c, call);
    const { key, binding } = experiment;
    if (this.cfg.spec.researchStrategy?.frontier && template.research &&
      !store.db.prepare("SELECT 1 FROM research_jobs WHERE key=?").get(key)) {
      invariant(c.task.research?.includes(name), "frontier experiment requires an admitted task assignment");
    }
    const planReceipts: string[] = [];
    if (template.research?.spec.schema === 2 && template.research.spec.theory &&
      !store.db.prepare("SELECT 1 FROM research_jobs WHERE key=?").get(key))
      theoryPremises(store, this.cfg, c.runId, c.task, template.research.spec);
    // Never gate reconciliation of an already submitted experiment on a new
    // pre-execution decision. Its durable intent was admitted under this binding.
    if (template.research?.spec.schema === 2 && template.research.spec.planValidation &&
      !store.db.prepare("SELECT 1 FROM research_jobs WHERE key=?").get(key)) {
      const cached = store.db.prepare("SELECT * FROM research_plan_reports WHERE key=?").all(key);
      const context = { key, adapterHash: digest(command), inputHash: digest(input) };
      await runPlanValidation(template.research.spec, context, this.cfg.experimentValidators?.[name] ?? {}, signal, {
        cached: cached.map(r => ({ id: String(r.validator), implementationHash: String(r.implementation_hash),
          report: store.readArtifact(String(r.report_hash)) })),
        onReport: (id, implementationHash, requestHash, report) => store.transaction(() => {
          signal.throwIfAborted(); this.journal.assertLease(c);
          const reportHash = store.artifact(report);
          const old = store.db.prepare("SELECT * FROM research_plan_reports WHERE key=? AND validator=?").get(key, id);
          invariant(!old || (old.report_hash === reportHash && old.request_hash === requestHash &&
            old.implementation_hash === implementationHash), "plan validation replay drift");
          if (!old) {
            store.db.prepare("INSERT INTO research_plan_reports VALUES(?,?,?,?,?)").run(key, id, implementationHash, requestHash, reportHash);
            store.event("research.plan.observed", { key, template: name, validator: id, implementationHash,
              requestHash, reportHash, trust: "OUTPUT_REQUIRES_HOST_VALIDATION" }, c.runId, c.task.id);
          }
        }),
      });
      // Collect references from durable storage, including reports recovered from
      // a prior interrupted attempt. No transcript or raw input enters the event.
      planReceipts.push(...store.db.prepare("SELECT report_hash FROM research_plan_reports WHERE key=? ORDER BY validator")
        .all(key).map(r => String(r.report_hash)));
    }
    signal.throwIfAborted(); this.journal.assertLease(c); checkPins(command);
    let row = store.transaction(() => {
      this.journal.assertLease(c);
      const old = store.db.prepare("SELECT * FROM research_jobs WHERE key=?").get(key);
      if (old) {
        invariant(old.input_hash === binding, "job replay input drift");
        recordExperimentInput(store, this.cfg, c, call, experiment);
        if (template.experiment?.reuseIdentical) store.event("job.reused", { key, template: name,
          sourceHash: experiment.sourceHash, terminal: old.result_hash !== null }, c.runId, c.task.id);
        return old;
      }
      const promotion = experimentPromotion(store, this.cfg, c, call, experiment);
      if (template.research?.spec.schema === 2 && template.research.spec.theory)
        theoryPremises(store, this.cfg, c.runId, c.task, template.research.spec);
      for (const requirement of template.research?.spec.schema === 2 ? template.research.spec.planValidation ?? [] : [])
        checkPins(this.cfg.experimentValidators![name][requirement.id].command);
      let preflight: Json | null = null;
      if (template.preflightChecks || profile.decisionPolicy) {
        const thread = store.db.prepare("SELECT state,fence FROM agent_threads WHERE run=? AND task=?")
          .get(c.runId, c.task.id);
        invariant(thread && thread.fence === c.fence, "JOB_PREFLIGHT_REQUIRED: durable task observations missing");
        preflight = jobPreflight(this.journal, store.readArtifact(thread.state) as unknown as ThreadState,
          c, template.preflightChecks ?? []);
      }
      const count = store.db.prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE run=? AND template=?").get(c.runId, name)!.n;
      if (count >= template.maxJobs) throw new FatalAttemptError("RUN_JOB_BUDGET_EXHAUSTED");
      if (objective) {
        const objectiveCount = Number(store.db.prepare(`SELECT COUNT(*) AS n FROM research_jobs
          WHERE template=? AND ${objectiveRunClause}`).get(name, objective, objective)?.n ?? 0);
        const objectiveLimit = template.maxObjectiveJobs ?? template.maxJobs;
        if (objectiveCount >= objectiveLimit)
          throw new FatalAttemptError("OBJECTIVE_JOB_BUDGET_EXHAUSTED");
      }
      const live = store.db.prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE template=? AND result_hash IS NULL").get(name)!.n;
      if (live >= template.maxConcurrent) throw new DeferredAttemptError("remote-job", Date.now() + template.pollMs,
        `Remote capacity busy for ${name}; no new job submitted`, { template: name, maxConcurrent: template.maxConcurrent });
      const now = Date.now();
      store.db.prepare(`INSERT INTO research_jobs
        (key,run,task,template,input_hash,created,progress_at,progress_token,poll_at,failures,job_id,status,result_hash,updated,reconciliation_hash,progress_rank,stale_at,idle_polls)
        VALUES(?,?,?,?,?,?,?,NULL,0,0,NULL,'UNKNOWN',NULL,?,NULL,0,?,0)`)
        .run(key, c.runId, c.task.id, name, binding, now, now, now, now + template.staleMs);
      recordExperimentInput(store, this.cfg, c, call, experiment);
      const promotionReceipt = promotion ? store.artifact(promotion) : null;
      const preflightReceipt = preflight ? store.artifact({ ...preflight as object, key, inputHash: binding } as Json) : null;
      if (preflightReceipt) store.db.prepare("INSERT OR IGNORE INTO agent_receipts VALUES(?,?,?)")
        .run(c.runId, c.task.id, preflightReceipt);
      store.event("job.intent", { key, template: name, inputHash: binding, objective,
        ...(promotionReceipt ? { promotionReceipt } : {}),
        ...(preflightReceipt ? { preflightReceipt } : {}),
        ...(planReceipts.length ? { planReceipts } : {}) }, c.runId, c.task.id);
      return store.db.prepare("SELECT * FROM research_jobs WHERE key=?").get(key)!;
    });
    if (row.stale_at == null) {
      const initialRank = row.status === "QUEUED" ? 1 : row.status === "RUNNING" ? 2 :
        ["SUCCEEDED", "FAILED", "CANCELLED"].includes(row.status) ? 3 : 0;
      store.db.prepare("UPDATE research_jobs SET progress_rank=?,stale_at=? WHERE key=? AND stale_at IS NULL")
        .run(initialRank, row.progress_at + template.staleMs, key);
      row = store.db.prepare("SELECT * FROM research_jobs WHERE key=?").get(key)!;
    }
    if (row.result_hash) return store.readArtifact(row.result_hash);
    if (row.poll_at > Date.now()) throw this.wait(row, template);
    const request = { schema: 1, operation: row.job_id ? "inspect" : "ensure", key, jobId: row.job_id ?? null,
      input, inputHash: binding, baseCommit: this.cfg.baseCommit } as Json;
    let raw: unknown;
    let pending: Promise<unknown> | undefined;
    try {
      const started = performance.now();
      let rpcOwner = true;
      // Keep this deadline referenced: a custom adapter may return a pending
      // promise without any I/O handles to keep the process alive until timeout.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), this.cfg.spec.budget.toolTimeoutMs);
      const bounded = createCombinedAbortSignal(signal, { signalB: deadline.signal });
      try {
        // Cross-process ensure(key) deduplication remains the adapter's duty.
        // Also coalesce a pending RPC for duplicate calls in this controller.
        pending = template.experiment?.reuseIdentical ? this.inFlight.get(key) : undefined;
        rpcOwner = !pending;
        if (!pending) {
          pending = Promise.resolve().then(() => this.rpc(command, this.cfg, request, bounded.signal));
          if (template.experiment?.reuseIdentical) this.inFlight.set(key, pending);
        }
        try { raw = await abortable(pending, bounded.signal); }
        finally { if (rpcOwner && this.inFlight.get(key) === pending) this.inFlight.delete(key); }
      }
      finally {
        clearTimeout(timer); bounded.cleanup();
        if (rpcOwner) onRpc?.(Math.max(0, performance.now() - started));
      }
    }
    catch (e) {
      signal.throwIfAborted(); this.journal.assertLease(c);
      if (e instanceof FatalAttemptError) throw e;
      store.transaction(() => {
        this.journal.assertLease(c);
        // Another controller or an operator may have reconciled this job while
        // the RPC was pending. A late transport error cannot undo that receipt.
        const current = store.db.prepare("SELECT * FROM research_jobs WHERE key=?").get(key)!;
        if (current.result_hash || (pending && (this.observedRPCs.has(pending) || this.failedRPCs.has(pending)))) return;
        const backoff = Math.min(60000, template.pollMs * 2 ** Math.min(current.failures, 10));
        store.db.prepare("UPDATE research_jobs SET failures=failures+1,poll_at=?,status='UNKNOWN',updated=? WHERE key=?")
          .run(Date.now() + backoff, Date.now(), key);
        store.event("job.reconciling", { key, jobId: current.job_id ?? null, reason: "adapter RPC failed; never infer remote termination" }, c.runId, c.task.id);
      });
      // A caller's deadline is an unknown outcome. A coalesced caller may still
      // receive the actual reply, which must remain eligible for reconciliation.
      if (pending) this.failedRPCs.add(pending);
      row = store.db.prepare("SELECT * FROM research_jobs WHERE key=?").get(key)!;
      if (row.result_hash) return store.readArtifact(row.result_hash);
      throw this.wait(row, template);
    }
    signal.throwIfAborted(); this.journal.assertLease(c);
    const v = raw as JobReply;
    // Invalid schema or identity is not success, and is never silently retried.
    try {
      keys(v, ["schema", "key", "jobId", "status"], ["progressToken", "result"]);
      invariant(v.schema === 1 && v.key === key && typeof v.jobId === "string" && v.jobId.length > 0 && v.jobId.length <= 512, "invalid job identity");
      invariant(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"].includes(v.status), "invalid job status");
      invariant(v.progressToken === undefined || (typeof v.progressToken === "string" && v.progressToken.length > 0 && v.progressToken.length <= 256), "invalid remote progress");
      invariant(v.status !== "SUCCEEDED" || Object.hasOwn(v, "result"), "successful job needs a result");
      invariant(Buffer.byteLength(canonical(v)) <= this.cfg.spec.budget.maxToolOutputBytes, "job response too large");
    } catch { throw new FatalAttemptError("INVALID_JOB_REPLY: check adapter schema and immutable identity"); }
    const receipt = store.artifact(v as unknown as Json);
    const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(v.status);
    const reconciliationHash = terminal ? store.artifact({
      schema: 1, key, jobId: v.jobId, status: v.status, template: name,
      inputHash: binding, baseCommit: this.cfg.baseCommit, replyHash: receipt,
    }) : null;
    row = store.transaction(() => {
      this.journal.assertLease(c); const now = Date.now();
      // The pre-RPC snapshot is not authoritative after an await. Serialize
      // identity, terminality and progress checks against the latest job row.
      const current = store.db.prepare("SELECT * FROM research_jobs WHERE key=?").get(key)!;
      if (current.job_id && current.job_id !== v.jobId)
        throw new FatalAttemptError("INVALID_JOB_REPLY: remote job identity changed");
      if (current.result_hash) {
        invariant(!terminal || current.result_hash === receipt, "concurrent job result drift");
        return current;
      }
      if (pending && this.observedRPCs.has(pending)) return current;
      const rank = v.status === "QUEUED" ? 1 : v.status === "RUNNING" ? 2 : terminal ? 3 : 0;
      let changed = rank > Number(current.progress_rank ?? 0);
      if (v.progressToken !== undefined) {
        // A semantic milestone renews liveness only once. Alternating or replayed
        // old tokens (A -> B -> A -> B) must not keep a stalled remote job alive.
        const inserted = store.db.prepare(
          "INSERT OR IGNORE INTO research_job_progress(key,token,observed) VALUES(?,?,?)"
        ).run(key, v.progressToken, now);
        changed = changed || (v.progressToken !== current.progress_token && inserted.changes > 0);
      }
      const idlePolls = changed || terminal ? 0 : Math.min(1_000_000, Number(current.idle_polls ?? 0) + 1);
      const pollMs = nextRemotePollMs(template, idlePolls);
      store.db.prepare(`UPDATE research_jobs SET job_id=?,status=?,progress_at=?,progress_token=?,poll_at=?,failures=0,
        result_hash=?,updated=?,reconciliation_hash=?,progress_rank=?,stale_at=?,idle_polls=? WHERE key=?`)
        .run(v.jobId, v.status, changed ? now : current.progress_at, v.progressToken ?? current.progress_token,
          now + pollMs, terminal ? receipt : null, now, reconciliationHash,
          Math.max(Number(current.progress_rank ?? 0), rank), changed ? now + template.staleMs : current.stale_at, idlePolls, key);
      // Store only meaningful changes; polling/replayed milestones do not
      // manufacture progress.
      if (changed || current.status !== v.status || current.job_id !== v.jobId) store.event("job.observed",
        { key, jobId: v.jobId, status: v.status, progress: changed, receipt }, c.runId, c.task.id);
      if (terminal) this.releaseCapacity(name, now);
      return store.db.prepare("SELECT * FROM research_jobs WHERE key=?").get(key)!;
    });
    if (pending) this.observedRPCs.add(pending);
    if (row.result_hash) return store.readArtifact(row.result_hash);
    throw this.wait(row, template);
  }
  private wait(row: Record<string, any>, template: JobTemplate): DeferredAttemptError | FatalAttemptError {
    const now = Date.now();
    const age = Math.max(0, now - row.progress_at);
    const staleAt = Math.min(Number(row.stale_at ?? Number.POSITIVE_INFINITY), row.progress_at + template.staleMs);
    const reconcileAfterMs = template.reconcileAfterMs ?? Math.min(604800000, template.staleMs * 3);
    if (age >= reconcileAfterMs) {
      return new FatalAttemptError(`REMOTE_JOB_RECONCILIATION_REQUIRED: job ${row.key.slice(0, 12)} ${row.status}; no semantic milestone for ${age}ms. Inspect/adopt/cancel the remote job before any replacement work.`);
    }
    const stale = now >= staleAt;
    return new DeferredAttemptError(stale ? "remote-stalled" : "remote-job", Math.max(now + 10, row.poll_at),
      `job ${row.key.slice(0, 12)} ${row.status}${stale ? "; no new milestone: inspect remote worker/queue" : "; durable poll scheduled"}`);
  }
  reconcile(run: string, key: string, reply: JobReply): Json {
    const store = this.journal.store;
    const row = store.db.prepare("SELECT * FROM research_jobs WHERE run=? AND key=?").get(run, key);
    invariant(row, "unknown research job");
    keys(reply, ["schema", "key", "jobId", "status"], ["progressToken", "result"]);
    invariant(reply.schema === 1 && reply.key === key && typeof reply.jobId === "string" && reply.jobId.length > 0 && reply.jobId.length <= 512, "invalid job identity");
    invariant(!row.job_id || reply.jobId === row.job_id, "remote job identity changed");
    invariant(["SUCCEEDED", "FAILED", "CANCELLED"].includes(reply.status), "reconciliation must provide a terminal remote status");
    invariant(reply.status !== "SUCCEEDED" || Object.hasOwn(reply, "result"), "successful job needs a result");
    invariant(Buffer.byteLength(canonical(reply)) <= this.cfg.spec.budget.maxToolOutputBytes, "job response too large");
    const receipt = store.artifact(reply as unknown as Json);
    const reconciliationHash = store.artifact({
      schema: 1, key, jobId: reply.jobId, status: reply.status, template: row.template,
      inputHash: row.input_hash, baseCommit: this.cfg.baseCommit, replyHash: receipt,
      mode: "operator-reconcile",
    });
    const now = Date.now();
    store.transaction(() => {
      const current = store.db.prepare("SELECT job_id,result_hash FROM research_jobs WHERE run=? AND key=?").get(run, key);
      invariant(current && !current.result_hash, "research job already reconciled");
      invariant(!current.job_id || current.job_id === reply.jobId, "remote job identity changed");
      store.db.prepare("UPDATE research_jobs SET job_id=?,status=?,result_hash=?,poll_at=?,updated=?,reconciliation_hash=? WHERE run=? AND key=?")
        .run(reply.jobId, reply.status, receipt, now, now, reconciliationHash, run, key);
      store.db.prepare("UPDATE task_waits SET wake=MIN(wake,?) WHERE run=? AND task=? AND kind IN ('remote-job','remote-stalled')")
        .run(now, run, row.task);
      store.event("job.reconciled", { key, jobId: reply.jobId, status: reply.status,
        receipt, reconciliationHash }, run, row.task);
      this.releaseCapacity(String(row.template), now);
    });
    return reply as unknown as Json;
  }
  private releaseCapacity(template: string, now: number): void {
    // Only capacity waiters become eligible. A running job retains its own
    // identity, inspect deadline and semantic-progress policy.
    const store = this.journal.store;
    const released = store.db.prepare("UPDATE task_waits SET wake=MIN(wake,?) WHERE kind='remote-job' AND reason=?")
      .run(now, `Remote capacity busy for ${template}; no new job submitted`);
    if (released.changes) store.event("job.capacity.released", { template, waiters: Number(released.changes) });
  }
  list(run: string): Json {
    const rows = this.journal.store.db.prepare(`SELECT key,task,template,job_id,status,progress_at,stale_at,progress_rank,poll_at,idle_polls,failures,result_hash,reconciliation_hash,updated
      FROM research_jobs WHERE run=? ORDER BY created LIMIT 201`).all(run);
    return { items: rows.slice(0, 200) as Json[], truncated: rows.length > 200 };
  }
}
