import { DeferredAttemptError } from "../continuation.ts";
import { FatalAttemptError } from "../errors.ts";
import { checkPins } from "../commands.ts";
import { canonical, digest, invariant } from "../kernel.ts";
import type { Capsule, Json } from "../types.ts";
import type { PinnedSwarm, AgentProfile, JobTemplate } from "./config.ts";
import { keys } from "./config.ts";
import type { Call } from "./context.ts";
import { SessionJournal } from "./session.ts";
import { runProcess } from "./process.ts";

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

/** Durable external jobs share Foundry's DB. No LLM is used to poll.
 * The adapter is trusted and pinned. ensure(key) MUST implement remote dedupe.
 * After a jobId is known, only inspect is sent, even after disconnect/not-found. */
export class ResearchJobs {
  readonly journal: SessionJournal;
  readonly cfg: PinnedSwarm;
  readonly rpc: JobRPC;
  constructor(journal: SessionJournal, cfg: PinnedSwarm, rpc: JobRPC = defaultRPC) {
    this.journal = journal; this.cfg = cfg; this.rpc = rpc;
    journal.store.db.exec(`CREATE TABLE IF NOT EXISTS research_jobs(
      key TEXT PRIMARY KEY, run TEXT NOT NULL, task TEXT NOT NULL, template TEXT NOT NULL,
      input_hash TEXT NOT NULL, created REAL NOT NULL, progress_at REAL NOT NULL,
      progress_token TEXT, poll_at REAL NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
      job_id TEXT, status TEXT NOT NULL, result_hash TEXT, updated REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS research_jobs_run ON research_jobs(run,task);`);
  }
  async execute(c: Capsule, profile: AgentProfile, call: Call, signal: AbortSignal): Promise<Json> {
    this.journal.assertLease(c); signal.throwIfAborted();
    keys(call.arguments, ["name", "input"]);
    const name = call.arguments.name;
    invariant(typeof name === "string" && profile.jobs?.includes(name), "job capability denied");
    const template = this.cfg.spec.jobs?.[name]; const command = this.cfg.jobAdapters?.[name];
    invariant(template && command && template.idempotentEnsure, "job adapter not pinned");
    checkPins(command); // Configuration drift is not a transient network failure.
    const store = this.journal.store; const input = call.arguments.input;
    invariant(Buffer.byteLength(canonical(input)) <= this.cfg.spec.budget.maxToolOutputBytes, "job input too large");
    const binding = digest({ command, template, input, base: this.cfg.baseCommit });
    const key = digest({ run: c.runId, task: c.task.id, call: call.id, name });
    let row = store.transaction(() => {
      this.journal.assertLease(c);
      const old = store.db.prepare("SELECT * FROM research_jobs WHERE key=?").get(key);
      if (old) { invariant(old.input_hash === binding, "job replay input drift"); return old; }
      const count = store.db.prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE run=? AND template=?").get(c.runId, name)!.n;
      if (count >= template.maxJobs) throw new FatalAttemptError("RUN_JOB_BUDGET_EXHAUSTED");
      const live = store.db.prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE template=? AND result_hash IS NULL").get(name)!.n;
      if (live >= template.maxConcurrent) throw new DeferredAttemptError("remote-job", Date.now() + template.pollMs, `Remote capacity busy for ${name}; no new job submitted`);
      const now = Date.now();
      store.db.prepare("INSERT INTO research_jobs VALUES(?,?,?,?,?,?,?,NULL,0,0,NULL,'UNKNOWN',NULL,?)")
        .run(key, c.runId, c.task.id, name, binding, now, now, now);
      store.event("job.intent", { key, template: name, inputHash: binding }, c.runId, c.task.id);
      return store.db.prepare("SELECT * FROM research_jobs WHERE key=?").get(key)!;
    });
    if (row.result_hash) return store.readArtifact(row.result_hash);
    if (row.poll_at > Date.now()) throw this.wait(row, template);
    const request = { schema: 1, operation: row.job_id ? "inspect" : "ensure", key, jobId: row.job_id ?? null,
      input, inputHash: binding, baseCommit: this.cfg.baseCommit } as Json;
    let raw: unknown;
    try { raw = await this.rpc(command, this.cfg, request, signal); }
    catch (e) {
      signal.throwIfAborted(); this.journal.assertLease(c);
      if (e instanceof FatalAttemptError) throw e;
      store.transaction(() => {
        this.journal.assertLease(c);
        const backoff = Math.min(60000, template.pollMs * 2 ** Math.min(row.failures, 10));
        store.db.prepare("UPDATE research_jobs SET failures=failures+1,poll_at=?,status='UNKNOWN',updated=? WHERE key=?")
          .run(Date.now() + backoff, Date.now(), key);
        store.event("job.reconciling", { key, jobId: row.job_id ?? null, reason: "adapter RPC failed; never infer remote termination" }, c.runId, c.task.id);
      });
      row = store.db.prepare("SELECT * FROM research_jobs WHERE key=?").get(key)!;
      throw this.wait(row, template);
    }
    signal.throwIfAborted(); this.journal.assertLease(c);
    const v = raw as JobReply;
    // Invalid schema or identity is not success, and is never silently retried.
    try {
      keys(v, ["schema", "key", "jobId", "status"], ["progressToken", "result"]);
      invariant(v.schema === 1 && v.key === key && typeof v.jobId === "string" && v.jobId.length > 0 && v.jobId.length <= 512, "invalid job identity");
      invariant(!row.job_id || v.jobId === row.job_id, "remote job identity changed");
      invariant(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"].includes(v.status), "invalid job status");
      invariant(v.progressToken === undefined || (typeof v.progressToken === "string" && v.progressToken.length > 0 && v.progressToken.length <= 256), "invalid remote progress");
      invariant(v.status !== "SUCCEEDED" || Object.hasOwn(v, "result"), "successful job needs a result");
      invariant(Buffer.byteLength(canonical(v)) <= this.cfg.spec.budget.maxToolOutputBytes, "job response too large");
    } catch { throw new FatalAttemptError("INVALID_JOB_REPLY: check adapter schema and immutable identity"); }
    const receipt = store.artifact(v as unknown as Json);
    const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(v.status);
    store.transaction(() => {
      this.journal.assertLease(c); const now = Date.now();
      const changed = v.progressToken !== undefined && v.progressToken !== row.progress_token;
      store.db.prepare(`UPDATE research_jobs SET job_id=?,status=?,progress_at=?,progress_token=?,poll_at=?,failures=0,result_hash=?,updated=? WHERE key=?`)
        .run(v.jobId, v.status, changed ? now : row.progress_at, v.progressToken ?? row.progress_token,
          now + template.pollMs, terminal ? receipt : null, now, key);
      // Store only meaningful changes; polling does not manufacture progress.
      if (changed || row.status !== v.status || row.job_id !== v.jobId) store.event("job.observed",
        { key, jobId: v.jobId, status: v.status, progress: changed, receipt }, c.runId, c.task.id);
    });
    if (terminal) return v as unknown as Json;
    row = store.db.prepare("SELECT * FROM research_jobs WHERE key=?").get(key)!;
    throw this.wait(row, template);
  }
  private wait(row: Record<string, any>, template: JobTemplate): DeferredAttemptError | FatalAttemptError {
    const age = Math.max(0, Date.now() - row.progress_at);
    const reconcileAfterMs = template.reconcileAfterMs ?? Math.min(604800000, template.staleMs * 3);
    if (age >= reconcileAfterMs) {
      return new FatalAttemptError(`REMOTE_JOB_RECONCILIATION_REQUIRED: job ${row.key.slice(0, 12)} ${row.status}; no semantic milestone for ${age}ms. Inspect/adopt/cancel the remote job before any replacement work.`);
    }
    const stale = age >= template.staleMs;
    return new DeferredAttemptError(stale ? "remote-stalled" : "remote-job", Math.max(Date.now() + 10, row.poll_at),
      `job ${row.key.slice(0, 12)} ${row.status}${stale ? "; no new milestone: inspect remote worker/queue" : "; durable poll scheduled"}`);
  }
  list(run: string): Json {
    const rows = this.journal.store.db.prepare(`SELECT key,task,template,job_id,status,progress_at,poll_at,failures,result_hash,updated
      FROM research_jobs WHERE run=? ORDER BY created LIMIT 201`).all(run);
    return { items: rows.slice(0, 200) as Json[], truncated: rows.length > 200 };
  }
}
