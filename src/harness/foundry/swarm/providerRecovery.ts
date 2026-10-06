import { invariant } from "../kernel.ts";
import type { Store } from "../store.ts";

const MAX_WAIT_MS = 86_400_000;
export const transientStatus = (status: number): boolean => [408, 425, 429, 500, 502, 503, 504, 529].includes(status);
/** Bound upstream advice; never parse an error body or persist credentials. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  const ms = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 :
    /^[A-Za-z]/.test(text) ? Date.parse(text) - now : NaN;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(MAX_WAIT_MS, Math.ceil(ms)) : null;
}
export interface ProviderCircuit {
  provider: string; state: "OPEN" | "HALF_OPEN"; failures: number;
  retryAt: number; reason: string | null;
}

/** A durable admission projection, not another task scheduler. The caller's
 * SQLite transaction serializes cooldown observation and request admission. */
export class ProviderRecovery {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS agent_provider_health(
      provider TEXT PRIMARY KEY, failures INTEGER NOT NULL, epoch INTEGER NOT NULL,
      retry_at REAL NOT NULL, reason TEXT, updated REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_provider_admissions(
      request TEXT PRIMARY KEY, provider TEXT NOT NULL, epoch INTEGER NOT NULL,
      outcome TEXT, wake REAL);
      CREATE TABLE IF NOT EXISTS agent_provider_waits(
      run TEXT NOT NULL, task TEXT NOT NULL, provider TEXT NOT NULL,
      fence INTEGER NOT NULL, wake REAL NOT NULL, PRIMARY KEY(run,task,provider));
      CREATE INDEX IF NOT EXISTS agent_provider_waits_pool ON agent_provider_waits(provider,run,task);`);
  }
  ready(provider: string, run: string, task: string, fence: number, now = Date.now()): number | null {
    const health = this.store.db.prepare("SELECT * FROM agent_provider_health WHERE provider=?").get(provider);
    const cooldown = Number(this.store.db.prepare("SELECT until_ms FROM agent_cooldowns WHERE provider=?").get(provider)?.until_ms ?? 0);
    let wake = Math.max(cooldown, Number(health?.retry_at ?? 0));
    if (wake <= now && Number(health?.failures ?? 0) > 0) {
      // After an outage, one probe across all store connections owns recovery.
      // Old in-flight calls also count, so they cannot race a fresh probe.
      wake = Number(this.store.db.prepare(`SELECT MIN(deadline) AS wake FROM agent_requests
        WHERE provider=? AND status='ACTIVE' AND deadline>?`).get(provider, now)?.wake ?? 0);
    }
    if (wake > now) {
      wake = Math.ceil(wake);
      this.store.db.prepare(`INSERT INTO agent_provider_waits VALUES(?,?,?,?,?)
        ON CONFLICT(run,task,provider) DO UPDATE SET fence=excluded.fence,wake=excluded.wake`)
        .run(run, task, provider, fence, wake);
      return wake;
    }
    this.store.db.prepare("DELETE FROM agent_provider_waits WHERE run=? AND task=? AND provider=?").run(run, task, provider);
    return null;
  }
  admit(id: string, provider: string): void {
    const epoch = Number(this.store.db.prepare("SELECT epoch FROM agent_provider_health WHERE provider=?").get(provider)?.epoch ?? 0);
    this.store.db.prepare("INSERT INTO agent_provider_admissions VALUES(?,?,?,NULL,NULL)").run(id, provider, epoch);
  }
  failure(id: string, retryAfter: string | null = null, status: number | null = null, now = Date.now()): number {
    invariant(status === null || transientStatus(status), "not a transient provider failure");
    return this.store.transaction(() => {
      const admission = this.store.db.prepare("SELECT * FROM agent_provider_admissions WHERE request=?").get(id);
      invariant(admission, "unknown provider admission");
      if (admission.outcome === "FAILURE") return Number(admission.wake);
      invariant(admission.outcome === null, "provider outcome already recorded");
      const request = this.store.db.prepare("SELECT run,task FROM agent_requests WHERE id=?").get(id)!;
      const health = this.store.db.prepare("SELECT * FROM agent_provider_health WHERE provider=?").get(admission.provider);
      const failures = Math.min(64, Number(health?.failures ?? 0) + 1);
      const epoch = Number(health?.epoch ?? 0) + 1;
      const backoff = Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6));
      const previous = Number(this.store.db.prepare("SELECT until_ms FROM agent_cooldowns WHERE provider=?").get(admission.provider)?.until_ms ?? 0);
      const wake = Math.ceil(Math.max(previous, Number(health?.retry_at ?? 0), now + backoff, now + (retryAfterMs(retryAfter, now) ?? 0)));
      const reason = status === null ? "transport" : "HTTP " + status;
      this.store.db.prepare(`INSERT INTO agent_provider_health VALUES(?,?,?,?,?,?) ON CONFLICT(provider)
        DO UPDATE SET failures=excluded.failures,epoch=excluded.epoch,retry_at=excluded.retry_at,reason=excluded.reason,updated=excluded.updated`)
        .run(admission.provider, failures, epoch, wake, reason, now);
      this.store.db.prepare(`INSERT INTO agent_cooldowns VALUES(?,?) ON CONFLICT(provider)
        DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)`).run(admission.provider, wake);
      this.store.db.prepare("UPDATE agent_provider_admissions SET outcome='FAILURE',wake=? WHERE request=?").run(wake, id);
      this.store.event("provider.recovery.deferred", { provider: admission.provider, request: id, epoch, failures, retryAt: wake, reason }, request.run, request.task);
      return wake;
    });
  }
  success(id: string, now = Date.now()): void {
    this.store.transaction(() => {
      const admission = this.store.db.prepare("SELECT * FROM agent_provider_admissions WHERE request=?").get(id);
      invariant(admission, "unknown provider admission");
      if (admission.outcome === "SUCCESS") return;
      invariant(admission.outcome === null, "provider outcome already recorded");
      this.store.db.prepare("UPDATE agent_provider_admissions SET outcome='SUCCESS' WHERE request=?").run(id);
      const health = this.store.db.prepare("SELECT * FROM agent_provider_health WHERE provider=?").get(admission.provider);
      // A reply admitted before a newer failure is evidence of old availability.
      // It must not erase a newer Retry-After, even within the same millisecond.
      if (!health || Number(health.epoch) !== Number(admission.epoch)) return;
      this.store.db.prepare("UPDATE agent_provider_health SET failures=0,retry_at=0,reason=NULL,updated=? WHERE provider=?").run(now, admission.provider);
      const cooldown = Number(this.store.db.prepare("SELECT until_ms FROM agent_cooldowns WHERE provider=?").get(admission.provider)?.until_ms ?? 0);
      if (cooldown > now) return;
      this.store.db.prepare(`UPDATE task_waits SET wake=? WHERE kind='provider' AND EXISTS (
        SELECT 1 FROM agent_provider_waits p JOIN tasks t ON t.run=p.run AND t.id=p.task
        WHERE p.provider=? AND p.run=task_waits.run AND p.task=task_waits.task
          AND t.status='READY' AND t.fence=p.fence AND task_waits.wake=p.wake)`)
        .run(now, admission.provider);
      // Retain the fenced wait until its next admission. Success can arrive
      // before the scheduler persists a just-thrown continuation; the scheduler
      // must still be able to observe that recovery and avoid a lost wakeup.
      const request = this.store.db.prepare("SELECT run,task FROM agent_requests WHERE id=?").get(id)!;
      this.store.event("provider.recovery.resumed", { provider: admission.provider, request: id, epoch: admission.epoch }, request.run, request.task);
    });
  }
}

export function providerWaitRecovered(store: Store, run: string, task: string, fence: number, wake: number, now: number): boolean {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_provider_waits'").get()) return false;
  return !!store.db.prepare(`SELECT 1 FROM agent_provider_waits p
    LEFT JOIN agent_provider_health h ON h.provider=p.provider LEFT JOIN agent_cooldowns c ON c.provider=p.provider
    WHERE p.run=? AND p.task=? AND p.fence=? AND p.wake=? AND COALESCE(h.failures,0)=0
      AND COALESCE(h.retry_at,0)<=? AND COALESCE(c.until_ms,0)<=? LIMIT 1`).get(run, task, fence, wake, now, now);
}

export function providerRecoveryStatus(store: Store, run: string, now = Date.now()): {
  coolingPools: number; nextRetryAt: number | null; circuits: ProviderCircuit[]; circuitsTruncated: boolean;
} {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_provider_health'").get())
    return { coolingPools: 0, nextRetryAt: null, circuits: [], circuitsTruncated: false };
  const query = `WITH pools AS (SELECT p.provider,COALESCE(h.failures,0) AS failures,h.reason,
    MAX(COALESCE(h.retry_at,0),COALESCE(c.until_ms,0)) AS retry_at FROM (
    SELECT DISTINCT provider FROM agent_requests WHERE run=? UNION SELECT provider FROM agent_provider_waits WHERE run=?
    ) p LEFT JOIN agent_provider_health h ON h.provider=p.provider LEFT JOIN agent_cooldowns c ON c.provider=p.provider
    )`;
  const counts = store.db.prepare(query + ` SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN retry_at>? THEN 1 ELSE 0 END),0) AS cooling,
    MIN(CASE WHEN retry_at>? THEN retry_at END) AS wake FROM pools WHERE failures>0 OR retry_at>?`).get(run, run, now, now, now)!;
  const circuits: ProviderCircuit[] = store.db.prepare(query + " SELECT * FROM pools WHERE failures>0 OR retry_at>? ORDER BY provider LIMIT 20")
    .all(run, run, now).map(row => {
      const retryAt = Number(row.retry_at);
      return { provider: String(row.provider), state: retryAt > now ? "OPEN" : "HALF_OPEN",
        failures: Number(row.failures ?? 0), retryAt, reason: row.reason == null ? null : String(row.reason) };
    });
  return { coolingPools: Number(counts.cooling), nextRetryAt: counts.wake == null ? null : Number(counts.wake),
    circuits, circuitsTruncated: Number(counts.total) > circuits.length };
}
