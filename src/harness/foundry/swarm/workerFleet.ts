import { digest, invariant } from "../kernel.ts";
import { invoke } from "../commands.ts";
import { DeferredAttemptError } from "../continuation.ts";
import type { Capsule, Json, Verification } from "../types.ts";
import type { Store } from "../store.ts";
import type { AgentProfile, PinnedSwarm } from "./config.ts";
import type { Call } from "./context.ts";
import { orderedTasks, patchText, readPatchArtifact, verifyPatch, type Hands, type HandsBackend } from "./workspace.ts";

interface WorkerReply { ok: boolean; result?: Json; patch?: string; error?: string }
interface WorkerLease { worker: string; workspace: string; deadline: number }

function install(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS swarm_worker_leases(
    run TEXT NOT NULL, task TEXT NOT NULL, fence INTEGER NOT NULL,
    worker TEXT NOT NULL, workspace TEXT NOT NULL, deadline REAL NOT NULL,
    PRIMARY KEY(run,task,fence));
    CREATE INDEX IF NOT EXISTS swarm_worker_leases_worker ON swarm_worker_leases(worker,deadline);
    CREATE TABLE IF NOT EXISTS swarm_worker_health(
      worker TEXT PRIMARY KEY, failures INTEGER NOT NULL, quarantine_until REAL, updated REAL NOT NULL);`);
}
function workspaceId(c: Capsule): string {
  return digest({ run: c.runId, task: c.task.id, fence: c.fence, contract: c.contractHash, recipe: c.recipeHash });
}
function spawnedRoots(store: Store, c: Capsule): string[] {
  return store.db.prepare("SELECT child FROM spawn_edges WHERE run=? AND parent=? ORDER BY child")
    .all(c.runId, c.task.id).map(r => String(r.child));
}
function activeCount(store: Store, worker: string, now: number): number {
  return Number(store.db.prepare("SELECT COUNT(*) AS n FROM swarm_worker_leases WHERE worker=? AND deadline>?")
    .get(worker, now)?.n ?? 0);
}
function workerHealth(store: Store, worker: string): { failures: number; quarantineUntil: number } {
  const row = store.db.prepare("SELECT failures,quarantine_until FROM swarm_worker_health WHERE worker=?").get(worker);
  return { failures: Number(row?.failures ?? 0), quarantineUntil: Number(row?.quarantine_until ?? 0) };
}
function workerSucceeded(store: Store, worker: string): void {
  store.db.prepare(`INSERT INTO swarm_worker_health(worker,failures,quarantine_until,updated)
    VALUES(?,0,NULL,?) ON CONFLICT(worker) DO UPDATE SET failures=0,quarantine_until=NULL,updated=excluded.updated`)
    .run(worker, Date.now());
}
function workerFailed(store: Store, worker: string, reason: unknown): void {
  const now = Date.now();
  store.transaction(() => {
    const current = workerHealth(store, worker);
    const failures = current.failures + 1;
    const quarantineUntil = failures >= 2 ? now + 30_000 : null;
    store.db.prepare(`INSERT INTO swarm_worker_health(worker,failures,quarantine_until,updated)
      VALUES(?,?,?,?) ON CONFLICT(worker) DO UPDATE SET
      failures=excluded.failures,quarantine_until=excluded.quarantine_until,updated=excluded.updated`)
      .run(worker, failures, quarantineUntil, now);
    store.event("worker.health", {
      worker, failures, quarantineUntil,
      reason: reason instanceof Error ? reason.message.slice(0, 512) : "worker RPC failed",
    });
  });
}
function releaseLease(store: Store, c: Capsule): void {
  store.db.prepare("DELETE FROM swarm_worker_leases WHERE run=? AND task=? AND fence=?").run(c.runId, c.task.id, c.fence);
}
function claimLease(store: Store, cfg: PinnedSwarm, c: Capsule, exclude = new Set<string>()): WorkerLease {
  install(store); const now = Date.now();
  const task = store.db.prepare("SELECT deadline FROM tasks WHERE run=? AND id=? AND fence=?").get(c.runId, c.task.id, c.fence);
  invariant(task?.deadline && task.deadline > now, "stale worker lease request");
  const workers = Object.keys(cfg.spec.workers ?? {}).sort();
  invariant(workers.length > 0, "no execution workers configured");
  return store.transaction(() => {
    store.db.prepare("DELETE FROM swarm_worker_leases WHERE deadline<=?").run(now);
    const existing = store.db.prepare("SELECT worker,workspace,deadline FROM swarm_worker_leases WHERE run=? AND task=? AND fence=?")
      .get(c.runId, c.task.id, c.fence);
    if (existing && !exclude.has(String(existing.worker))) return {
      worker: String(existing.worker), workspace: String(existing.workspace), deadline: Number(existing.deadline),
    };
    if (existing) releaseLease(store, c);
    const eligible = workers.filter(id => !exclude.has(id)).map(id => {
      const health = workerHealth(store, id);
      return {
        id, active: activeCount(store, id, now), capacity: cfg.spec.workers![id]!.maxConcurrent,
        failures: health.failures, quarantineUntil: health.quarantineUntil,
        tie: digest({ run: c.runId, task: c.task.id, fence: c.fence, worker: id }),
      };
    });
    const ranked = eligible.filter(x => x.quarantineUntil <= now && x.active < x.capacity)
      .sort((a, b) => a.failures - b.failures || a.active - b.active ||
        (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0));
    if (!ranked.length) {
      const wake = eligible.filter(x => x.quarantineUntil > now)
        .reduce((min, x) => Math.min(min, x.quarantineUntil), Number.POSITIVE_INFINITY);
      throw new DeferredAttemptError("worker-capacity", Number.isFinite(wake) ? wake : now + 250,
        Number.isFinite(wake)
          ? "All remaining execution workers are quarantined; retry scheduled"
          : "All configured execution workers are busy; retry scheduled");
    }
    const worker = ranked[0]!.id; const workspace = workspaceId(c);
    store.db.prepare("INSERT INTO swarm_worker_leases VALUES(?,?,?,?,?,?)")
      .run(c.runId, c.task.id, c.fence, worker, workspace, Number(task.deadline));
    store.event("worker.claimed", { worker, workspace }, c.runId, c.task.id);
    return { worker, workspace, deadline: Number(task.deadline) };
  });
}

class RemoteHands implements Hands {
  readonly store: Store; readonly cfg: PinnedSwarm; readonly c: Capsule; readonly profile: AgentProfile; readonly signal: AbortSignal;
  private lease: WorkerLease | null = null;
  private prepared = false;
  private restorePatch: string | null;
  private failedWorkers = new Set<string>();
  constructor(store: Store, cfg: PinnedSwarm, c: Capsule, profile: AgentProfile, signal: AbortSignal, restore: string | null) {
    this.store = store; this.cfg = cfg; this.c = c; this.profile = profile; this.signal = signal; this.restorePatch = restore;
  }
  private dependencies(): string[] {
    const roots = [...this.c.task.dependencies, ...spawnedRoots(this.store, this.c)];
    return orderedTasks(this.store, this.c.runId, roots).map(task => {
      const artifact = readPatchArtifact(this.store, this.c.runId, task.id);
      return patchText(this.store, artifact.patchHash, this.cfg.spec.budget.maxPatchBytes);
    }).filter(Boolean);
  }
  private ensureLease(): WorkerLease {
    this.signal.throwIfAborted();
    const total = Object.keys(this.cfg.spec.workers ?? {}).length;
    if (!this.lease && this.failedWorkers.size >= total)
      throw new Error("all configured execution workers failed for this task attempt");
    if (!this.lease) this.lease = claimLease(this.store, this.cfg, this.c, this.failedWorkers);
    return this.lease;
  }
  private async rpc(request: Json): Promise<WorkerReply> {
    this.signal.throwIfAborted();
    const lease = this.ensureLease();
    const id = lease.worker; const spec = this.cfg.spec.workers?.[id]; const command = this.cfg.workerAdapters?.[id];
    invariant(spec && command, "execution worker configuration missing");
    const result = await invoke(command, request, spec.maxRpcBytes, this.signal) as WorkerReply;
    invariant(result && typeof result === "object" && typeof result.ok === "boolean", "invalid worker reply");
    return result;
  }
  private async prepare(): Promise<void> {
    if (this.prepared) return;
    const lease = this.ensureLease();
    const reply = await this.rpc({
      schema: 1, op: "prepare", workspace: lease.workspace, baseCommit: this.cfg.baseCommit,
      dependencyPatches: this.dependencies(), restorePatch: this.restorePatch,
      task: { writeScope: this.c.task.writeScope, readScope: this.c.task.readScope ?? [] },
      protectedPaths: this.cfg.spec.protectedPaths, allowedChecks: this.profile.checks,
      limits: { toolTimeoutMs: this.cfg.spec.budget.toolTimeoutMs,
        maxToolOutputBytes: this.cfg.spec.budget.maxToolOutputBytes, maxPatchBytes: this.cfg.spec.budget.maxPatchBytes },
    });
    if (reply.ok) workerSucceeded(this.store, lease.worker);
    invariant(reply.ok, reply.error ?? "remote worker prepare failed"); this.prepared = true;
  }
  private async failover(error: unknown): Promise<void> {
    const prior = this.lease?.worker;
    if (prior) {
      this.failedWorkers.add(prior);
      workerFailed(this.store, prior, error);
    }
    releaseLease(this.store, this.c); this.lease = null; this.prepared = false;
    this.store.event("worker.failed_over", { from: prior ?? null, reason: error instanceof Error ? error.message.slice(0, 512) : "worker RPC failed" },
      this.c.runId, this.c.task.id);
  }
  async tool(call: Call): Promise<Json> {
    for (;;) {
      try {
        await this.prepare();
        const reply = await this.rpc({ schema: 1, op: "tool", workspace: this.lease!.workspace, call });
        workerSucceeded(this.store, this.lease!.worker);
        if (!reply.ok) return { error: reply.error ?? "remote tool failed" };
        return reply.result ?? null;
      } catch (e) {
        if (e instanceof DeferredAttemptError) throw e;
        await this.failover(e);
        if (this.failedWorkers.size >= Object.keys(this.cfg.spec.workers ?? {}).length) throw e;
      }
    }
  }
  async snapshot(): Promise<string> {
    await this.prepare();
    // Do not fail over inside snapshot. A mutating tool may already have
    // succeeded on this worker; if snapshot transport fails, the enclosing
    // attempt must retry the still-pending tool from the last durable patch.
    const reply = await this.rpc({ schema: 1, op: "snapshot", workspace: this.lease!.workspace });
    if (reply.ok && typeof reply.patch === "string") workerSucceeded(this.store, this.lease!.worker);
    invariant(reply.ok && typeof reply.patch === "string", reply.error ?? "remote snapshot failed");
    invariant(Buffer.byteLength(reply.patch) <= this.cfg.spec.budget.maxPatchBytes, "remote patch exceeds budget");
    this.restorePatch = this.store.artifact(reply.patch);
    return this.restorePatch;
  }
  async dispose(): Promise<void> {
    if (this.lease) {
      try { await this.rpc({ schema: 1, op: "dispose", workspace: this.lease.workspace }); }
      catch { /* disposable remote workspace; lease release is authoritative */ }
    }
    releaseLease(this.store, this.c); this.lease = null; this.prepared = false;
  }
}

/** Multi-host execution with one authoritative coordinator.
 * Remote workers can execute tools, but only local verification may certify PASS. */
export const remoteWorkerFleetBackend: HandsBackend = {
  id: "remote-worker-fleet-v1",
  open: (store, cfg, c, profile, signal, restore) => new RemoteHands(store, cfg, c, profile, signal, restore),
  verify: (store: Store, cfg: PinnedSwarm, c: Capsule, artifact: Json, signal: AbortSignal): Promise<Verification> =>
    verifyPatch(store, cfg, c, artifact, signal),
};
