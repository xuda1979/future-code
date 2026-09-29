import { invariant } from "./kernel.ts";
import type { Store } from "./store.ts";
import type { Lease, Measurement } from "./types.ts";

/** Yield a durable continuation, not a failed implementation attempt.
 * A deadline only bounds the current episode; it never cancels a remote job. */
export class DeferredAttemptError extends Error {
  readonly wakeAt: number;
  readonly kind: string;
  constructor(kind: "provider" | "remote-job" | "remote-stalled" | "checkpoint" | "spawn" | "cancelled", wakeAt: number, reason: string) {
    super(reason); this.name = "DeferredAttemptError";
    invariant(Number.isSafeInteger(wakeAt) && wakeAt >= 0, "invalid continuation time");
    this.wakeAt = wakeAt; this.kind = kind;
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
    CREATE TABLE IF NOT EXISTS attempt_health(
    run TEXT NOT NULL, task TEXT NOT NULL, fence INTEGER NOT NULL, stage TEXT NOT NULL,
    activity_at REAL NOT NULL, progress_at REAL, check_at REAL, PRIMARY KEY(run,task,fence));`);
}

/** Caller owns the transaction and has already checked the current lease. */
export function persistContinuation(store: Store, lease: Lease, error: DeferredAttemptError, measurement: Measurement, now: number): void {
  const a = store.db.prepare("SELECT started FROM attempts WHERE run=? AND task=? AND fence=?").get(lease.runId, lease.taskId, lease.fence)!;
  store.db.prepare("UPDATE attempts SET status='DEFERRED',ended=?,duration=?,tokens=?,cost=? WHERE run=? AND task=? AND fence=?")
    .run(now, Math.max(0, now - a.started), measurement.tokens, measurement.costUsd, lease.runId, lease.taskId, lease.fence);
  store.db.prepare("UPDATE tasks SET status='READY',owner=NULL,deadline=NULL,error=? WHERE run=? AND id=?")
    .run(error.message.slice(0, 1024), lease.runId, lease.taskId);
  store.db.prepare(`INSERT INTO task_waits VALUES(?,?,?,?,?) ON CONFLICT(run,task)
    DO UPDATE SET wake=excluded.wake,kind=excluded.kind,reason=excluded.reason`)
    .run(lease.runId, lease.taskId, Math.max(now, error.wakeAt), error.kind, error.message.slice(0, 1024));
  store.event("task.deferred", { fence: lease.fence, wakeAt: Math.max(now, error.wakeAt), kind: error.kind,
    reason: error.message.slice(0, 1024) }, lease.runId, lease.taskId);
}
