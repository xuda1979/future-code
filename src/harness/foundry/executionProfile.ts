import type { Store } from "./store.ts";
import { invariant } from "./kernel.ts";

export interface AttemptTiming {
  prepareMs: number; executeMs: number; verifyMs: number;
  toolMs: number; remoteRpcMs: number; toolCalls: number; remoteRpcs: number;
}
export function installExecutionProfile(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS attempt_timings(
    run TEXT NOT NULL,task TEXT NOT NULL,fence INTEGER NOT NULL,
    prepare_ms REAL NOT NULL,execute_ms REAL NOT NULL,verify_ms REAL NOT NULL,
    tool_ms REAL NOT NULL,remote_rpc_ms REAL NOT NULL,tool_calls INTEGER NOT NULL,remote_rpcs INTEGER NOT NULL,
    PRIMARY KEY(run,task,fence));`);
}
export function recordAttemptTiming(store: Store, run: string, task: string, fence: number, timing: AttemptTiming): void {
  invariant(Object.values(timing).every(n => Number.isFinite(n) && n >= 0), "invalid host timing");
  invariant(store.db.prepare("SELECT 1 FROM attempts WHERE run=? AND task=? AND fence=?").get(run, task, fence),
    "timing references unknown attempt");
  store.db.prepare("INSERT INTO attempt_timings VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run,task,fence) DO NOTHING")
    .run(run, task, fence, timing.prepareMs, timing.executeMs, timing.verifyMs,
      timing.toolMs, timing.remoteRpcMs, timing.toolCalls, timing.remoteRpcs);
}

/** Phase sums are worker time: concurrent work overlaps in wall time. Tool and
 * RPC time are nested in execute time and must never be added to it. Counts of
 * spawned children cannot inflate verified objective throughput. */
export function executionProfile(store: Store, run: string, now = Date.now()) {
  const r = store.db.prepare("SELECT status,started,ended FROM runs WHERE id=?").get(run);
  invariant(r, "unknown profiled run");
  const elapsedMs = Math.max(0, Number(r.ended ?? now) - Number(r.started));
  const roots = store.db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(t.status='PASS' AND t.artifact IS NOT NULL AND t.evidence IS NOT NULL),0) AS verified
    FROM tasks t WHERE t.run=? AND NOT EXISTS(SELECT 1 FROM spawn_edges e WHERE e.run=t.run AND e.child=t.id)`).get(run)!;
  const attempts = Number(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE run=?").get(run)!.n);
  const timing = store.db.prepare(`SELECT COUNT(*) AS measured,
    COALESCE(SUM(prepare_ms),0) AS prepareMs,COALESCE(SUM(execute_ms),0) AS executeMs,
    COALESCE(SUM(verify_ms),0) AS verifyMs,COALESCE(SUM(tool_ms),0) AS toolMs,
    COALESCE(SUM(remote_rpc_ms),0) AS remoteRpcMs,COALESCE(SUM(tool_calls),0) AS toolCalls,
    COALESCE(SUM(remote_rpcs),0) AS remoteRpcs FROM attempt_timings WHERE run=?`).get(run)!;
  const hasRequests = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_requests' AND type='table'").get();
  const columns = hasRequests ? new Set(store.db.prepare("PRAGMA table_info(agent_requests)").all().map(r => String(r.name))) : new Set();
  const provider = columns.has("finished") && columns.has("wait_ms") ? store.db.prepare(`SELECT COUNT(*) AS requests,
    COALESCE(SUM(wait_ms IS NOT NULL),0) AS measuredWaits,SUM(wait_ms) AS admissionWaitMs,
    COALESCE(SUM(finished IS NOT NULL),0) AS measuredReplies,
    SUM(CASE WHEN finished IS NOT NULL THEN MAX(0,finished-started) ELSE 0 END) AS responseMs
    FROM agent_requests WHERE run=?`).get(run)! : null;
  return {
    elapsedMs, admittedObjectives: Number(roots.total), verifiedObjectives: Number(roots.verified),
    verifiedPerHour: elapsedMs > 0 ? Number(roots.verified) * 3_600_000 / elapsedMs : null,
    attempts, measuredAttempts: Number(timing.measured),
    phaseWorkerMs: Number(timing.measured) ? {
      prepare: Number(timing.prepareMs), execute: Number(timing.executeMs), verify: Number(timing.verifyMs),
      toolsWithinExecute: Number(timing.toolMs), remoteRpcWithinTools: Number(timing.remoteRpcMs),
    } : null,
    toolCalls: Number(timing.toolCalls), remoteRpcs: Number(timing.remoteRpcs),
    provider: provider ? { requests: Number(provider.requests), measuredWaits: Number(provider.measuredWaits),
      admissionWaitMs: provider.measuredWaits ? Number(provider.admissionWaitMs) : null,
      measuredReplies: Number(provider.measuredReplies), responseMs: provider.measuredReplies ? Number(provider.responseMs) : null } : null,
    measurement: "HOST_TIMINGS_PARTIAL_COVERAGE_NO_LIVE_BASELINE" as const,
  };
}
