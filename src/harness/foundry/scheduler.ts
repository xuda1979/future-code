import { randomUUID } from "node:crypto";
import { Store } from "./store.ts";
import { conflicts, digest, encodeCapsule, invariant, validMeasurement, validateTasks, validateEvidence } from "./kernel.ts";
import type { Capsule, Json, Lease, Measurement, RunSummary, Task } from "./types.ts";

export class Scheduler {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }
  start(tasks: Task[], recipeHash = this.store.active(), now = Date.now()): string {
    const contract = this.store.contract(); validateTasks(contract, tasks); this.store.recipe(recipeHash);
    const id = randomUUID();
    this.store.transaction(() => {
      this.store.db.prepare("INSERT INTO runs(id,recipe,contract,started,status) VALUES(?,?,?,?, 'RUNNING')").run(id, recipeHash, digest(contract), now);
      for (const task of tasks) this.store.db.prepare("INSERT INTO tasks(run,id,spec,status) VALUES(?,?,?,'READY')").run(id, task.id, JSON.stringify(task));
      this.store.event("run.started", { recipeHash, contractHash: digest(contract), taskCount: tasks.length, taskHash: digest(tasks) }, id);
    });
    return id;
  }
  /** Claim, expiry, scope locks, and attempt accounting form one transaction. */
  claim(runId: string, owner: string, now = Date.now()): Lease | null {
    invariant(owner.length > 0, "missing owner");
    return this.store.transaction(() => {
      const run = this.store.db.prepare("SELECT * FROM runs WHERE id=?").get(runId); invariant(run, "unknown run");
      if (run.status !== "RUNNING") return null;
      invariant(run.contract === digest(this.store.contract()), "run contract drift");
      const recipe = this.store.recipe(run.recipe);
      let rows = this.store.db.prepare("SELECT * FROM tasks WHERE run=?").all(runId);
      for (const t of rows.filter(t => t.status === "RUNNING" && t.deadline <= now)) {
        this.store.db.prepare("UPDATE attempts SET status='EXPIRED',ended=?,duration=? WHERE run=? AND task=? AND fence=? AND status='RUNNING'").run(now, Math.max(0, now - (t.deadline - recipe.timeoutMs)), runId, t.id, t.fence);
        this.store.db.prepare("UPDATE tasks SET status=?,owner=NULL,deadline=NULL,error='lease expired' WHERE run=? AND id=?").run(t.fence >= recipe.attempts ? "FAIL" : "READY", runId, t.id);
        this.store.event("lease.expired", { fence: t.fence }, runId, t.id);
      }
      // Propagate terminal dependency failure all the way through the DAG.
      let changed = true;
      while (changed) {
        changed = false; rows = this.store.db.prepare("SELECT * FROM tasks WHERE run=?").all(runId);
        const states = new Map(rows.map(t => [t.id, t.status]));
        for (const t of rows.filter(t => t.status === "READY")) {
          const spec: Task = JSON.parse(t.spec);
          if (spec.dependencies.some(d => ["FAIL", "BLOCKED"].includes(states.get(d)!))) {
            this.store.db.prepare("UPDATE tasks SET status='BLOCKED',error='dependency failed' WHERE run=? AND id=?").run(runId, t.id);
            this.store.event("task.blocked", { reason: "dependency failed" }, runId, t.id); changed = true;
          }
        }
      }
      rows = this.store.db.prepare("SELECT * FROM tasks WHERE run=?").all(runId);
      const running = rows.filter(t => t.status === "RUNNING");
      if (running.length >= recipe.parallelism) return null;
      const states = new Map(rows.map(t => [t.id, t.status]));
      const scopes = running.map(t => (JSON.parse(t.spec) as Task).writeScope);
      const ready = rows.filter(t => t.status === "READY").sort((a, b) =>
        ((JSON.parse(b.spec) as Task).priority ?? 0) - ((JSON.parse(a.spec) as Task).priority ?? 0) || a.id.localeCompare(b.id));
      for (const t of ready) {
        const task: Task = JSON.parse(t.spec);
        if (!task.dependencies.every(d => states.get(d) === "PASS") || scopes.some(s => conflicts(s, task.writeScope))) continue;
        const fence = t.fence + 1; const deadline = now + recipe.timeoutMs;
        this.store.db.prepare("UPDATE tasks SET status='RUNNING',fence=?,owner=?,deadline=?,error=NULL WHERE run=? AND id=?").run(fence, owner, deadline, runId, t.id);
        this.store.db.prepare("INSERT INTO attempts(run,task,fence,started,status) VALUES(?,?,?,?,'RUNNING')").run(runId, t.id, fence, now);
        this.store.event("task.claimed", { owner, fence, deadline }, runId, t.id);
        return { runId, taskId: t.id, owner, fence, deadline, recipeHash: run.recipe, contractHash: run.contract };
      }
      if (rows.every(t => ["PASS", "FAIL", "BLOCKED"].includes(t.status))) {
        const status = rows.length > 0 && rows.every(t => t.status === "PASS") ? "PASS" : "FAIL";
        this.store.db.prepare("UPDATE runs SET status=?,ended=? WHERE id=?").run(status, now, runId);
        this.store.event("run.finished", { status }, runId);
      }
      return null;
    });
  }
  private current(lease: Lease, now: number): boolean {
    const t = this.store.db.prepare("SELECT * FROM tasks WHERE run=? AND id=?").get(lease.runId, lease.taskId);
    const run = this.store.db.prepare("SELECT * FROM runs WHERE id=?").get(lease.runId);
    return !!t && !!run && run.recipe === lease.recipeHash && run.contract === lease.contractHash &&
      t.status === "RUNNING" && t.owner === lease.owner && t.fence === lease.fence && t.deadline === lease.deadline && t.deadline > now;
  }
  capsule(lease: Lease): Capsule {
    invariant(this.current(lease, Date.now()), "stale lease");
    const row = this.store.db.prepare("SELECT spec FROM tasks WHERE run=? AND id=?").get(lease.runId, lease.taskId)!;
    const task: Task = JSON.parse(row.spec);
    const dependencies = task.dependencies.map(id => {
      const dep = this.store.db.prepare("SELECT status,artifact FROM tasks WHERE run=? AND id=?").get(lease.runId, id);
      invariant(dep?.status === "PASS" && dep.artifact, "unverified dependency");
      return { taskId: id, artifactHash: dep.artifact as string, artifact: this.store.readArtifact(dep.artifact) };
    });
    const capsule: Capsule = { schema: 1, runId: lease.runId, task, contractHash: lease.contractHash, recipeHash: lease.recipeHash, fence: lease.fence, dependencies };
    encodeCapsule(capsule, this.store.recipe(lease.recipeHash).contextBytes);
    return capsule;
  }
  /** Only the trusted runtime calls finish after independent verification. */
  finish(lease: Lease, artifact: Json, evidence: Json, measurement: Measurement, now = Date.now()): boolean {
    validMeasurement(measurement);
    // Materialize first. A crash can leave an orphan artifact, never a dangling PASS.
    const artifactHash = this.store.artifact(artifact); const evidenceHash = this.store.artifact(evidence);
    return this.store.transaction(() => {
      if (!this.current(lease, now)) {
        this.store.event("result.stale", { fence: lease.fence, artifactHash, evidenceHash }, lease.runId, lease.taskId); return false;
      }
      const task: Task = JSON.parse(this.store.db.prepare("SELECT spec FROM tasks WHERE run=? AND id=?").get(lease.runId, lease.taskId)!.spec);
      validateEvidence(this.store.contract(), lease.recipeHash, task, artifact, evidence);
      const e = evidence as any;
      invariant(e.metrics.tokens === measurement.tokens && e.metrics.costUsd === measurement.costUsd, "measurement binding mismatch");
      const a = this.store.db.prepare("SELECT started FROM attempts WHERE run=? AND task=? AND fence=?").get(lease.runId, lease.taskId, lease.fence)!;
      this.store.db.prepare("UPDATE attempts SET status='PASS',ended=?,duration=?,tokens=?,cost=? WHERE run=? AND task=? AND fence=?").run(now, Math.max(0, now - a.started), measurement.tokens, measurement.costUsd, lease.runId, lease.taskId, lease.fence);
      this.store.db.prepare("UPDATE tasks SET status='PASS',artifact=?,evidence=?,owner=NULL,deadline=NULL WHERE run=? AND id=?").run(artifactHash, evidenceHash, lease.runId, lease.taskId);
      this.store.event("task.accepted", { fence: lease.fence, artifactHash, evidenceHash }, lease.runId, lease.taskId); return true;
    });
  }
  fail(lease: Lease, reason: string, measurement: Measurement = { tokens: null, costUsd: null }, now = Date.now()): boolean {
    validMeasurement(measurement);
    return this.store.transaction(() => {
      // An expired lease is reclaimed by claim(); do not overwrite a new owner.
      if (!this.current(lease, now)) { this.store.event("failure.stale", { fence: lease.fence, reason }, lease.runId, lease.taskId); return false; }
      const recipe = this.store.recipe(lease.recipeHash);
      const a = this.store.db.prepare("SELECT started FROM attempts WHERE run=? AND task=? AND fence=?").get(lease.runId, lease.taskId, lease.fence)!;
      const status = lease.fence >= recipe.attempts ? "FAIL" : "READY";
      this.store.db.prepare("UPDATE attempts SET status='FAIL',ended=?,duration=?,tokens=?,cost=? WHERE run=? AND task=? AND fence=?").run(now, Math.max(0, now - a.started), measurement.tokens, measurement.costUsd, lease.runId, lease.taskId, lease.fence);
      this.store.db.prepare("UPDATE tasks SET status=?,owner=NULL,deadline=NULL,error=? WHERE run=? AND id=?").run(status, reason.slice(0, 4096), lease.runId, lease.taskId);
      this.store.event("task.failed", { fence: lease.fence, reason: reason.slice(0, 4096), retry: status === "READY" }, lease.runId, lease.taskId); return true;
    });
  }
  summary(id: string, now = Date.now()): RunSummary {
    const r = this.store.db.prepare("SELECT * FROM runs WHERE id=?").get(id); invariant(r, "unknown run");
    const tasks = this.store.db.prepare("SELECT status FROM tasks WHERE run=?").all(id);
    const attempts = this.store.db.prepare("SELECT tokens,cost FROM attempts WHERE run=?").all(id);
    const sum = (key: string): number | null => attempts.length && attempts.every(a => a[key] !== null && Number.isFinite(a[key])) ? attempts.reduce((n, a) => n + a[key], 0) : null;
    return { id, recipeHash: r.recipe, contractHash: r.contract, status: r.status,
      accepted: tasks.filter(t => t.status === "PASS").length, failed: tasks.filter(t => t.status === "FAIL").length,
      blocked: tasks.filter(t => t.status === "BLOCKED").length, attempts: attempts.length,
      durationMs: Math.max(0, (r.ended ?? now) - r.started), tokens: sum("tokens"), costUsd: sum("cost") };
  }
}
