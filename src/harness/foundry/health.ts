import { invariant } from "./kernel.ts";
import type { Store } from "./store.ts";
export interface HealthReport {
  runId: string; at: number; status: string; elapsedMs: number;
  counts: Record<string, number>; waiting: number;
  tasks: { id: string; status: string; stage: string; activityAgeMs: number | null;
    progressAgeMs: number | null; checkAgeMs: number | null; deadline: number | null;
    wakeAt: number | null; reason: string | null }[];
  truncated: boolean;
}
export type HealthObserver = (report: HealthReport) => void;
/** No model invocation, no test rerun, and no invented heartbeat from a worker.
 * The observer is alive; task activity/progress/check timestamps are independent. */
export function runHealth(store: Store, runId: string, now = Date.now()): HealthReport {
  const run = store.db.prepare("SELECT status,started FROM runs WHERE id=?").get(runId);
  invariant(run, "unknown run");
  const counts = Object.fromEntries(store.db.prepare("SELECT status,COUNT(*) AS n FROM tasks WHERE run=? GROUP BY status").all(runId).map(r => [r.status, r.n]));
  const waiting = store.db.prepare("SELECT COUNT(*) AS n FROM task_waits WHERE run=?").get(runId)!.n;
  const rows = store.db.prepare(`SELECT t.id,t.status,t.deadline,t.error,h.stage,h.activity_at,h.progress_at,h.check_at,w.wake,w.kind,w.reason
    FROM tasks t LEFT JOIN attempt_health h ON t.run=h.run AND t.id=h.task AND t.fence=h.fence
    LEFT JOIN task_waits w ON t.run=w.run AND t.id=w.task
    WHERE t.run=? AND t.status<>'PASS' ORDER BY CASE t.status WHEN 'RUNNING' THEN 0 WHEN 'FAIL' THEN 1 ELSE 2 END,t.id LIMIT 101`).all(runId);
  const age = (t: number | null | undefined) => t == null ? null : Math.max(0, now - t);
  return { runId, at: now, status: run.status, elapsedMs: Math.max(0, now - run.started), counts, waiting,
    tasks: rows.slice(0, 100).map(r => ({ id: r.id, status: r.status, stage: r.kind ?? r.stage ?? "queued",
      activityAgeMs: age(r.activity_at), progressAgeMs: age(r.progress_at), checkAgeMs: age(r.check_at),
      deadline: r.deadline ?? null, wakeAt: r.wake ?? null, reason: r.reason ?? r.error ?? null })), truncated: rows.length > 100 };
}
export function formatHealth(r: HealthReport): string {
  const age = (n: number | null) => n === null ? "none" : `${Math.floor(n / 1000)}s ago`;
  const head = `[swarm ${r.runId}] ${r.status} | accepted=${r.counts.PASS ?? 0} active=${r.counts.RUNNING ?? 0} waiting=${r.waiting} failed=${r.counts.FAIL ?? 0} | elapsed=${Math.floor(r.elapsedMs / 1000)}s`;
  return [head, ...r.tasks.slice(0, 8).map(t => `${t.id}: ${t.stage}; activity=${age(t.activityAgeMs)} progress=${age(t.progressAgeMs)} check=${age(t.checkAgeMs)}${t.reason ? `; ${t.reason}` : ""}`),
    ...(r.tasks.length > 8 || r.truncated ? ["More tasks are available through /swarm status."] : [])].join("\n");
}
