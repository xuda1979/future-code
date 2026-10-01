import { invariant } from "./kernel.ts";
import type { Store } from "./store.ts";
import { schedulerIndexCurrent, schedulerIndexStats, type SchedulerIndexStats } from "./schedulerIndex.ts";
import { fabricStatus } from "./evidenceFabric.ts";

export interface HealthReport {
  runId: string; at: number; status: string; elapsedMs: number;
  counts: Record<string, number>; waiting: number;
  scheduler: SchedulerIndexStats | null;
  provider: { active: number; done: number; unknown: number; requests: number; requestBytes: number; tokens: number | null } | null;
  remoteJobs: { active: number; stalled: number; terminal: number; unattestedTerminal: number } | null;
  fabric: { goals: number; evidence: number; openConflicts: number; experiences: number;
    topAllocations: { task: string; score: number }[] };
  integrity: {
    schedulerIndexCurrent: boolean;
    graphVersion: number;
    indexedVersion: number | null;
    unattestedTerminalJobs: number;
  };
  tasks: { id: string; status: string; stage: string; activityAgeMs: number | null;
    progressAgeMs: number | null; checkAgeMs: number | null; deadline: number | null;
    wakeAt: number | null; reason: string | null }[];
  truncated: boolean;
}
export type HealthObserver = (report: HealthReport) => void;

/** No model invocation, no test rerun, and no invented heartbeat from a worker.
 * The observer is alive; task activity/progress/check timestamps are independent. */
export function runHealth(store: Store, runId: string, now = Date.now()): HealthReport {
  const run = store.db.prepare("SELECT status,started,graph_version FROM runs WHERE id=?").get(runId);
  invariant(run, "unknown run");
  const counts = Object.fromEntries(store.db.prepare(
    "SELECT status,COUNT(*) AS n FROM tasks WHERE run=? GROUP BY status"
  ).all(runId).map(r => [r.status, r.n]));
  const waiting = store.db.prepare("SELECT COUNT(*) AS n FROM task_waits WHERE run=?").get(runId)!.n;
  const scheduler = schedulerIndexStats(store, runId, now);

  const hasRequests = !!store.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_requests'"
  ).get();
  const provider = hasRequests ? (() => {
    const row = store.db.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(bytes),0) AS request_bytes,
      SUM(CASE WHEN status='ACTIVE' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status='DONE' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status='UNKNOWN' THEN 1 ELSE 0 END) AS unknown,
      COALESCE(SUM(tokens),0) AS tokens,
      SUM(CASE WHEN tokens IS NULL THEN 1 ELSE 0 END) AS missing
      FROM agent_requests WHERE run=?`).get(runId)!;
    return { active: Number(row.active ?? 0), done: Number(row.done ?? 0), unknown: Number(row.unknown ?? 0),
      requests: Number(row.requests ?? 0), requestBytes: Number(row.request_bytes ?? 0),
      tokens: Number(row.missing ?? 0) ? null : Number(row.tokens ?? 0) };
  })() : null;

  const hasJobs = !!store.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_jobs'"
  ).get();
  const remoteJobs = hasJobs ? (() => {
    const jobColumns = new Set(store.db.prepare("PRAGMA table_info(research_jobs)").all().map(r => String(r.name)));
    const hasAttestation = jobColumns.has("reconciliation_hash");
    const hasStaleDeadline = jobColumns.has("stale_at");
    const stalledPredicate = hasStaleDeadline ? "stale_at IS NOT NULL AND stale_at<=?" : "status='UNKNOWN'";
    const row = store.db.prepare(`SELECT
      SUM(CASE WHEN result_hash IS NULL THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN result_hash IS NULL AND ${stalledPredicate} THEN 1 ELSE 0 END) AS stalled,
      SUM(CASE WHEN result_hash IS NOT NULL THEN 1 ELSE 0 END) AS terminal
      FROM research_jobs WHERE run=?`).get(...(hasStaleDeadline ? [now, runId] : [runId]))!;
    const terminal = Number(row.terminal ?? 0);
    const unattested = hasAttestation ? Number(store.db.prepare(
      "SELECT COUNT(*) AS n FROM research_jobs WHERE run=? AND result_hash IS NOT NULL AND reconciliation_hash IS NULL"
    ).get(runId)!.n) : terminal;
    return { active: Number(row.active ?? 0), stalled: Number(row.stalled ?? 0),
      terminal, unattestedTerminal: unattested };
  })() : null;

  const rows = store.db.prepare(`SELECT t.id,t.status,t.deadline,t.error,h.stage,h.activity_at,h.progress_at,h.check_at,w.wake,w.kind,w.reason
    FROM tasks t LEFT JOIN attempt_health h ON t.run=h.run AND t.id=h.task AND t.fence=h.fence
    LEFT JOIN task_waits w ON t.run=w.run AND t.id=w.task
    WHERE t.run=? AND t.status<>'PASS'
    ORDER BY CASE t.status WHEN 'RUNNING' THEN 0 WHEN 'FAIL' THEN 1 ELSE 2 END,t.id LIMIT 101`).all(runId);
  const age = (t: number | null | undefined) => t == null ? null : Math.max(0, now - t);
  const fabric = fabricStatus(store, runId);
  const integrity = {
    schedulerIndexCurrent: schedulerIndexCurrent(store, runId),
    graphVersion: Number(run.graph_version ?? 0),
    indexedVersion: scheduler?.sourceVersion ?? null,
    unattestedTerminalJobs: remoteJobs?.unattestedTerminal ?? 0,
  };
  return { runId, at: now, status: run.status, elapsedMs: Math.max(0, now - run.started), counts, waiting,
    scheduler, provider, remoteJobs, fabric, integrity,
    tasks: rows.slice(0, 100).map(r => ({ id: r.id, status: r.status, stage: r.kind ?? r.stage ?? "queued",
      activityAgeMs: age(r.activity_at), progressAgeMs: age(r.progress_at), checkAgeMs: age(r.check_at),
      deadline: r.deadline ?? null, wakeAt: r.wake ?? null, reason: r.reason ?? r.error ?? null })),
    truncated: rows.length > 100 };
}

export function formatHealth(r: HealthReport): string {
  const age = (n: number | null) => n === null ? "none" : `${Math.floor(n / 1000)}s ago`;
  const head = `[swarm ${r.runId}] ${r.status} | accepted=${r.counts.PASS ?? 0} active=${r.counts.RUNNING ?? 0} waiting=${r.waiting} failed=${r.counts.FAIL ?? 0} | elapsed=${Math.floor(r.elapsedMs / 1000)}s`;
  const queue = r.scheduler ? `queue runnable=${r.scheduler.runnable} deps=${r.scheduler.dependencyBlocked} delayed=${r.scheduler.delayed} indexed=${r.scheduler.indexedTasks}` : "queue index=unavailable";
  const provider = r.provider ? `provider active=${r.provider.active} requests=${r.provider.requests} unknown=${r.provider.unknown}` : "provider no-ledger";
  const jobs = r.remoteJobs ? `jobs active=${r.remoteJobs.active} stalled=${r.remoteJobs.stalled} terminal=${r.remoteJobs.terminal} unattested=${r.remoteJobs.unattestedTerminal}` : "jobs none";
  const fabric = `fabric goals=${r.fabric.goals} evidence=${r.fabric.evidence} conflicts=${r.fabric.openConflicts} experience=${r.fabric.experiences}`;
  const integrity = `integrity index=${r.integrity.schedulerIndexCurrent ? "current" : "DRIFT"} graph=${r.integrity.graphVersion} indexed=${r.integrity.indexedVersion ?? "none"}`;
  return [head, `${queue} | ${provider} | ${jobs}`, `${fabric} | ${integrity}`,
    ...r.tasks.slice(0, 8).map(t => `${t.id}: ${t.stage}; activity=${age(t.activityAgeMs)} progress=${age(t.progressAgeMs)} check=${age(t.checkAgeMs)}${t.reason ? `; ${t.reason}` : ""}`),
    ...(r.tasks.length > 8 || r.truncated ? ["More tasks are available through /swarm status."] : [])].join("\n");
}
