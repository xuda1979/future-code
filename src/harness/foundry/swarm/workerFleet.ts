import { randomUUID } from "node:crypto";
import { canonical, digest, invariant } from "../kernel.ts";
import { invoke } from "../commands.ts";
import { DeferredAttemptError } from "../continuation.ts";
import { FatalAttemptError } from "../errors.ts";
import type { Capsule, Json, Verification } from "../types.ts";
import type { Store } from "../store.ts";
import type { AgentProfile, PinnedSwarm } from "./config.ts";
import type { Call } from "./context.ts";
import { orderedTasks, patchText, readPatchArtifact, verifyPatch, type Hands, type HandsBackend, type WorkspaceBatchResult } from "./workspace.ts";

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
  // A replacement must never reuse a private tree with unpublished edits,
  // even when the coordinator restarts under the same task fence.
  return digest({ run: c.runId, task: c.task.id, fence: c.fence, contract: c.contractHash, recipe: c.recipeHash, generation: randomUUID() });
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
function releaseLease(store: Store, c: Capsule, workspace?: string): void {
  store.db.prepare(`DELETE FROM swarm_worker_leases WHERE run=? AND task=? AND fence=?${workspace ? " AND workspace=?" : ""}`)
    .run(c.runId, c.task.id, c.fence, ...(workspace ? [workspace] : []));
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
    if (existing && !exclude.has(String(existing.worker))) {
      const workspace = workspaceId(c);
      store.db.prepare("UPDATE swarm_worker_leases SET workspace=? WHERE run=? AND task=? AND fence=?")
        .run(workspace, c.runId, c.task.id, c.fence);
      return { worker: String(existing.worker), workspace, deadline: Number(existing.deadline) };
    }
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
      const healthyBusy = eligible.some(x => x.quarantineUntil <= now && x.active >= x.capacity);
      const quarantineWake = eligible.filter(x => x.quarantineUntil > now)
        .reduce((min, x) => Math.min(min, x.quarantineUntil), Number.POSITIVE_INFINITY);
      const wake = healthyBusy ? now + 250 : quarantineWake;
      throw new DeferredAttemptError("worker-capacity", Number.isFinite(wake) ? wake : now + 250,
        healthyBusy
          ? "All healthy execution workers are busy; retry scheduled"
          : "All remaining execution workers are quarantined; retry scheduled");
    }
    const worker = ranked[0]!.id; const workspace = workspaceId(c);
    store.db.prepare("INSERT INTO swarm_worker_leases VALUES(?,?,?,?,?,?)")
      .run(c.runId, c.task.id, c.fence, worker, workspace, Number(task.deadline));
    store.event("worker.claimed", { worker, workspace }, c.runId, c.task.id);
    return { worker, workspace, deadline: Number(task.deadline) };
  });
}

class RemoteHands implements Hands {
  readonly batchPolicy = { reads: 4, writes: true, maxCalls: 32 };
  readonly store: Store; readonly cfg: PinnedSwarm; readonly c: Capsule; readonly profile: AgentProfile; readonly signal: AbortSignal;
  private lease: WorkerLease | null = null;
  private prepared = false;
  private supportsBatch = false;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private restorePatch: string | null;
  private failedWorkers = new Set<string>();
  constructor(store: Store, cfg: PinnedSwarm, c: Capsule, profile: AgentProfile, signal: AbortSignal, restore: string | null) {
    this.store = store; this.cfg = cfg; this.c = c; this.profile = profile; this.signal = signal; this.restorePatch = restore;
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      invariant(!this.closed, "remote workspace disposed"); this.signal.throwIfAborted(); return work();
    });
    this.tail = result.then(() => {}, () => {});
    return result;
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
  private async rpc(lease: WorkerLease, request: Json): Promise<WorkerReply> {
    this.signal.throwIfAborted();
    const id = lease.worker; const spec = this.cfg.spec.workers?.[id]; const command = this.cfg.workerAdapters?.[id];
    invariant(spec && command, "execution worker configuration missing");
    invariant(Buffer.byteLength(canonical(request)) <= 64 * 1024 * 1024, "remote request exceeds protocol budget");
    const result = await invoke(command, request, spec.maxRpcBytes, this.signal) as WorkerReply;
    invariant(result && typeof result === "object" && typeof result.ok === "boolean", "invalid worker reply");
    return result;
  }
  private async prepare(lease: WorkerLease): Promise<void> {
    if (this.prepared) return;
    const reply = await this.rpc(lease, {
      schema: 1, op: "prepare", workspace: lease.workspace, baseCommit: this.cfg.baseCommit,
      dependencyPatches: this.dependencies(), restorePatch: this.restorePatch === null ? null
        : patchText(this.store, this.restorePatch, this.cfg.spec.budget.maxPatchBytes),
      task: { writeScope: this.c.task.writeScope, readScope: this.c.task.readScope ?? [] },
      protectedPaths: this.cfg.spec.protectedPaths, allowedChecks: this.profile.checks,
      limits: { toolTimeoutMs: this.cfg.spec.budget.toolTimeoutMs,
        maxToolOutputBytes: this.cfg.spec.budget.maxToolOutputBytes, maxPatchBytes: this.cfg.spec.budget.maxPatchBytes },
    });
    // A successful workspace prepare proves reachability only. Do not clear a
    // durable RPC-failure streak until useful tool/snapshot traffic succeeds;
    // otherwise prepare -> tool-failure loops can keep a broken host healthy forever.
    invariant(reply.ok, reply.error ?? "remote worker prepare failed"); this.prepared = true;
    this.supportsBatch = (reply.result as any)?.capabilities?.workspaceBatch === 1;
  }
  private failover(lease: WorkerLease, error: unknown): void {
    const prior = lease.worker;
    if (prior) {
      this.failedWorkers.add(prior);
      workerFailed(this.store, prior, error);
    }
    releaseLease(this.store, this.c, lease.workspace); this.lease = null; this.prepared = false; this.supportsBatch = false;
    this.store.event("worker.failed_over", { from: prior ?? null, reason: error instanceof Error ? error.message.slice(0, 512) : "worker RPC failed" },
      this.c.runId, this.c.task.id);
  }
  private async retry<T>(work: (lease: WorkerLease) => Promise<T>): Promise<T> {
    for (;;) {
      const lease = this.ensureLease();
      try {
        await this.prepare(lease); return await work(lease);
      } catch (e) {
        this.signal.throwIfAborted();
        if (e instanceof DeferredAttemptError || e instanceof FatalAttemptError) throw e;
        this.failover(lease, e);
        if (this.failedWorkers.size >= Object.keys(this.cfg.spec.workers ?? {}).length) throw e;
      }
    }
  }
  tool(call: Call): Promise<Json> {
    return this.exclusive(() => this.retry(async lease => {
      const reply = await this.rpc(lease, { schema: 1, op: "tool", workspace: lease.workspace, call });
      workerSucceeded(this.store, lease.worker);
      return reply.ok ? reply.result ?? null : { error: reply.error ?? "remote tool failed" };
    }));
  }
  private savePatch(reply: WorkerReply): string {
    invariant(reply.ok && typeof reply.patch === "string", reply.error ?? "remote snapshot failed");
    invariant(Buffer.byteLength(reply.patch) <= this.cfg.spec.budget.maxPatchBytes, "remote patch exceeds budget");
    return this.store.artifact(reply.patch);
  }
  batch(kind: "read" | "workspace-write", calls: Call[]): Promise<WorkspaceBatchResult> {
    invariant(["read", "workspace-write"].includes(kind) && calls.length > 0 && calls.length <= 32 && calls.every(c =>
      (kind === "read" ? ["read_file", "list_files"] : ["write_file", "edit_file", "delete_file"]).includes(c.name)),
    "invalid remote workspace batch");
    return this.exclusive(() => this.retry(async lease => {
      const results: Json[] = []; let patchHash: string | undefined;
      if (this.supportsBatch) {
        // Bound aggregate JSON replies as well as each individual tool. Split
        // RPCs remain one replay unit and never promote an intermediate patch.
        const bytes = this.cfg.spec.workers![lease.worker]!.maxRpcBytes;
        const budget = this.cfg.spec.budget;
        const reserve = kind === "workspace-write" ? 6 * budget.maxPatchBytes + 4096 : 4096;
        const perCall = kind === "read" ? 6 * budget.maxToolOutputBytes + 1024 : 1024;
        const width = Math.max(1, Math.min(32, Math.floor((bytes - reserve) / perCall)));
        for (let offset = 0; offset < calls.length; offset += width) {
          const chunk = calls.slice(offset, offset + width);
          const reply = await this.rpc(lease, { schema: 1, op: "batch", workspace: lease.workspace, kind, calls: chunk });
          invariant(reply.ok, reply.error ?? "remote batch failed");
          const rows = (reply.result as any)?.results;
          invariant(Array.isArray(rows) && rows.length === chunk.length &&
            rows.every((row, i) => row?.callId === chunk[i]!.id && Object.hasOwn(row, "result")), "invalid remote batch results");
          results.push(...rows.map(row => row.result));
          if (kind === "workspace-write") patchHash = this.savePatch(reply);
        }
      } else {
        // Old workers retain serial wire I/O. Failover still replays every
        // admitted call from the last committed patch, rather than one edit.
        for (const call of calls) {
          const reply = await this.rpc(lease, { schema: 1, op: "tool", workspace: lease.workspace, call });
          results.push(reply.ok ? reply.result ?? null : { error: reply.error ?? "remote tool failed" });
        }
        if (kind === "workspace-write") patchHash = this.savePatch(await this.rpc(lease, { schema: 1, op: "snapshot", workspace: lease.workspace }));
      }
      this.signal.throwIfAborted(); workerSucceeded(this.store, lease.worker);
      if (patchHash !== undefined) this.restorePatch = patchHash;
      this.store.event("worker.batch", { worker: lease.worker, kind, calls: calls.length, protocol: this.supportsBatch ? "batch-v1" : "serial-v1" },
        this.c.runId, this.c.task.id);
      return { results, ...(patchHash === undefined ? {} : { patchHash }) };
    }));
  }
  snapshot(): Promise<string> {
    return this.exclusive(async () => {
      const lease = this.ensureLease(); await this.prepare(lease);
      // A single mutating tool may already have succeeded here. Its enclosing
      // attempt must retry from the last durable patch if snapshot is lost.
      const reply = await this.rpc(lease, { schema: 1, op: "snapshot", workspace: lease.workspace });
      this.restorePatch = this.savePatch(reply); workerSucceeded(this.store, lease.worker);
      return this.restorePatch;
    });
  }
  async dispose(): Promise<void> {
    this.closed = true; await this.tail;
    if (this.lease) {
      const lease = this.lease;
      try { await this.rpc(lease, { schema: 1, op: "dispose", workspace: lease.workspace }); }
      catch { /* disposable remote workspace; lease release is authoritative */ }
      releaseLease(this.store, this.c, lease.workspace);
    }
    this.lease = null; this.prepared = false;
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
