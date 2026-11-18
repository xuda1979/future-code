import { invariant } from "./kernel.ts";
import type { Store } from "./store.ts";
import type { Lease, Measurement } from "./types.ts";
import { providerWaitDeadline } from "./swarm/providerRecovery.ts";

type RemoteJobWait =
  | { kind: "job"; key: string }
  | { kind: "capacity"; template: string; maxConcurrent: number };

/** Yield a durable continuation, not a failed implementation attempt.
 * A deadline only bounds the current episode; it never cancels a remote job. */
export class DeferredAttemptError extends Error {
  readonly wakeAt: number;
  readonly kind: string;
  readonly jobWaits: readonly RemoteJobWait[];
  constructor(kind: "provider" | "remote-job" | "remote-stalled" | "external-action" | "checkpoint" | "spawn" | "cancelled" | "cohort-capacity",
    wakeAt: number, reason: string, jobWaits: readonly RemoteJobWait[] = []) {
    super(reason); this.name = "DeferredAttemptError";
    invariant(Number.isSafeInteger(wakeAt) && wakeAt >= 0, "invalid continuation time");
    this.wakeAt = wakeAt; this.kind = kind;
    invariant(jobWaits.length === 0 || kind === "remote-job" || kind === "remote-stalled", "invalid remote job wait");
    for (const wait of jobWaits) {
      if (wait.kind === "capacity") invariant(kind === "remote-job" && typeof wait.template === "string" &&
        Number.isSafeInteger(wait.maxConcurrent) && wait.maxConcurrent > 0, "invalid remote capacity advice");
    }
    this.jobWaits = jobWaits;
  }
}

export class PersistedDeferredAttemptError extends DeferredAttemptError {
  constructor(kind: "provider" | "remote-job" | "remote-stalled" | "checkpoint" | "spawn" | "cancelled",
    wakeAt: number, reason: string) {
    super(kind, wakeAt, reason); this.name = "PersistedDeferredAttemptError";
  }
}

export function installContinuationTables(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS task_waits(
    run TEXT NOT NULL, task TEXT NOT NULL, wake REAL NOT NULL, kind TEXT NOT NULL,
    reason TEXT NOT NULL, PRIMARY KEY(run,task));
    CREATE INDEX IF NOT EXISTS task_waits_wake ON task_waits(run,wake);
    CREATE INDEX IF NOT EXISTS task_waits_remote_reason ON task_waits(reason) WHERE kind='remote-job';
    CREATE TABLE IF NOT EXISTS task_remote_job_waits(
      run TEXT NOT NULL, task TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
      max_concurrent INTEGER, PRIMARY KEY(run,task,kind,target));
    CREATE INDEX IF NOT EXISTS task_remote_job_waits_target ON task_remote_job_waits(kind,target);
    CREATE TRIGGER IF NOT EXISTS task_remote_job_waits_cleanup AFTER DELETE ON task_waits BEGIN
      DELETE FROM task_remote_job_waits WHERE run=OLD.run AND task=OLD.task;
    END;
    CREATE TABLE IF NOT EXISTS attempt_health(
    run TEXT NOT NULL, task TEXT NOT NULL, fence INTEGER NOT NULL, stage TEXT NOT NULL,
    activity_at REAL NOT NULL, progress_at REAL, check_at REAL, PRIMARY KEY(run,task,fence));`);
}

/** Caller owns the transaction and has already checked the current lease. */
export function persistContinuation(store: Store, lease: Lease, error: DeferredAttemptError, measurement: Measurement, now: number): void {
  const providerWake = error.kind === "provider" ? providerWaitDeadline(store, lease.runId, lease.taskId, lease.fence, error.wakeAt, now) : null;
  // A job can finish between the attempt deciding to wait and this
  // transaction. Recheck every exact dependency while publishing the wait.
  const waits = new Map(error.jobWaits.map(wait =>
    [wait.kind === "job" ? `job:${wait.key}` : `capacity:${wait.template}`, wait] as const));
  const recovered = [...waits.values()].some(wait => wait.kind === "job"
    ? !!store.db.prepare("SELECT 1 FROM research_jobs WHERE key=? AND result_hash IS NOT NULL").get(wait.key)
    : Number(store.db.prepare(`SELECT COUNT(*) AS n FROM research_jobs INDEXED BY research_jobs_live_template
      WHERE template=? AND result_hash IS NULL`)
      .get(wait.template)!.n) < wait.maxConcurrent);
  const wake = recovered ? now : Math.max(now, Math.min(error.wakeAt, providerWake ?? error.wakeAt));
  const a = store.db.prepare("SELECT started FROM attempts WHERE run=? AND task=? AND fence=?").get(lease.runId, lease.taskId, lease.fence)!;
  store.db.prepare("UPDATE attempts SET status='DEFERRED',ended=?,duration=?,tokens=?,cost=? WHERE run=? AND task=? AND fence=?")
    .run(now, Math.max(0, now - a.started), measurement.tokens, measurement.costUsd, lease.runId, lease.taskId, lease.fence);
  store.db.prepare("UPDATE tasks SET status='READY',owner=NULL,deadline=NULL,error=? WHERE run=? AND id=?")
    .run(error.message.slice(0, 1024), lease.runId, lease.taskId);
  store.db.prepare(`INSERT INTO task_waits VALUES(?,?,?,?,?) ON CONFLICT(run,task)
    DO UPDATE SET wake=excluded.wake,kind=excluded.kind,reason=excluded.reason`)
    .run(lease.runId, lease.taskId, wake, error.kind, error.message.slice(0, 1024));
  if (waits.size) {
    const insert = store.db.prepare("INSERT INTO task_remote_job_waits VALUES(?,?,?,?,?)");
    for (const wait of waits.values())
      insert.run(lease.runId, lease.taskId, wait.kind, wait.kind === "job" ? wait.key : wait.template,
        wait.kind === "capacity" ? wait.maxConcurrent : null);
  }
  store.event("task.deferred", { fence: lease.fence, wakeAt: wake, kind: error.kind,
    reason: error.message.slice(0, 1024) }, lease.runId, lease.taskId);
}

/** Called within the transaction that records a terminal job result. Legacy
 * waits written before structured dependencies still honor their old selectors. */
export function wakeRemoteJobWaiters(store: Store, job: { key: string; run: string; task: string; template: string }, now: number): void {
  // Resolving rowids in the indexed dependency query gives SQLite a direct
  // update for each waiter. A composite IN predicate scans task_waits.
  store.db.prepare(`UPDATE task_waits SET wake=? WHERE wake>? AND rowid IN (
    SELECT w.rowid FROM task_remote_job_waits d JOIN task_waits w ON w.run=d.run AND w.task=d.task
      WHERE d.kind='job' AND d.target=?
    UNION ALL
    SELECT w.rowid FROM task_waits w WHERE run=? AND task=? AND kind IN ('remote-job','remote-stalled')
      AND NOT EXISTS (SELECT 1 FROM task_remote_job_waits d WHERE d.run=w.run AND d.task=w.task)
  )`).run(now, now, job.key, job.run, job.task);
  const released = store.db.prepare(`UPDATE task_waits SET wake=? WHERE wake>? AND rowid IN (
    SELECT w.rowid FROM task_remote_job_waits d JOIN task_waits w ON w.run=d.run AND w.task=d.task
      WHERE d.kind='capacity' AND d.target=? AND d.max_concurrent >
        (SELECT COUNT(*) FROM research_jobs INDEXED BY research_jobs_live_template WHERE template=? AND result_hash IS NULL)
    UNION ALL
    SELECT w.rowid FROM task_waits w WHERE kind='remote-job' AND reason=?
      AND NOT EXISTS (SELECT 1 FROM task_remote_job_waits d WHERE d.run=w.run AND d.task=w.task)
  )`).run(now, now, job.template, job.template, `Remote capacity busy for ${job.template}; no new job submitted`);
  if (released.changes) store.event("job.capacity.released", { template: job.template, waiters: Number(released.changes) });
}
