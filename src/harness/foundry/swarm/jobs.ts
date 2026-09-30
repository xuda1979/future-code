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
      job_id TEXT, status TEXT NOT NULL, result_hash TEXT, updated REAL NOT NULL,
      reconciliation_hash TEXT, progress_rank INTEGER NOT NULL DEFAULT 0, stale_at REAL);
      CREATE INDEX IF NOT EXISTS research_jobs_run ON research_jobs(run,task);
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
      store.db.prepare(`INSERT INTO research_jobs
        (key,run,task,template,input_hash,created,progress_at,progress_token,poll_at,failures,job_id,status,result_hash,updated,reconciliation_hash,progress_rank,stale_at)
        VALUES(?,?,?,?,?,?,?,NULL,0,0,NULL,'UNKNOWN',NULL,?,NULL,0,?)`)
        .run(key, c.runId, c.task.id, name, binding, now, now, now, now + template.staleMs);
      store.event("job.intent", { key, template: name, inputHash: binding }, c.runId, c.task.id);
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
    const reconciliationHash = terminal ? store.artifact({
      schema: 1, key, jobId: v.jobId, status: v.status, template: name,
      inputHash: binding, baseCommit: this.cfg.baseCommit, replyHash: receipt,
    }) : null;
    store.transaction(() => {
      this.journal.assertLease(c); const now = Date.now();
      const rank = v.status === "QUEUED" ? 1 : v.status === "RUNNING" ? 2 : terminal ? 3 : 0;
      let changed = rank > Number(row.progress_rank ?? 0);
      if (v.progressToken !== undefined) {
        // A semantic milestone renews liveness only once. Alternating or replayed
        // old tokens (A -> B -> A -> B) must not keep a stalled remote job alive.
        const inserted = store.db.prepare(
          "INSERT OR IGNORE INTO research_job_progress(key,token,observed) VALUES(?,?,?)"
        ).run(key, v.progressToken, now);
        changed = changed || (v.progressToken !== row.progress_token && inserted.changes > 0);
      }
      store.db.prepare(`UPDATE research_jobs SET job_id=?,status=?,progress_at=?,progress_token=?,poll_at=?,failures=0,
        result_hash=?,updated=?,reconciliation_hash=?,progress_rank=?,stale_at=? WHERE key=?`)
        .run(v.jobId, v.status, changed ? now : row.progress_at, v.progressToken ?? row.progress_token,
          now + template.pollMs, terminal ? receipt : null, now, reconciliationHash,
          Math.max(Number(row.progress_rank ?? 0), rank), changed ? now + template.staleMs : row.stale_at, key);
      // Store only meaningful changes; polling/replayed milestones do not
      // manufacture progress.
      if (changed || row.status !== v.status || row.job_id !== v.jobId) store.event("job.observed",
        { key, jobId: v.jobId, status: v.status, progress: changed, receipt }, c.runId, c.task.id);
    });
    if (terminal) return v as unknown as Json;
    row = store.db.prepare("SELECT * FROM research_jobs WHERE key=?").get(key)!;
    throw this.wait(row, template);
  }
  private wait(row: Record<string, any>, template: JobTemplate): DeferredAttemptError | FatalAttemptError {
    const now = Date.now();
    const age = Math.max(0, now - row.progress_at);
    const staleAt = Number(row.stale_at ?? (row.progress_at + template.staleMs));
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
      store.event("job.reconciled", { key, jobId: reply.jobId, status: reply.status,
        receipt, reconciliationHash }, run, row.task);
    });
    return reply as unknown as Json;
  }
  list(run: string): Json {
    const rows = this.journal.store.db.prepare(`SELECT key,task,template,job_id,status,progress_at,stale_at,progress_rank,poll_at,failures,result_hash,reconciliation_hash,updated
      FROM research_jobs WHERE run=? ORDER BY created LIMIT 201`).all(run);
    return { items: rows.slice(0, 200) as Json[], truncated: rows.length > 200 };
  }
}
