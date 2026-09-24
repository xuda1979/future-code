import { randomUUID } from "node:crypto";
import { Store } from "./store.ts";
import { digest, encodeCapsule, invariant, validMeasurement, validateTasks, validateEvidence, progressDensity } from "./kernel.ts";
import { accessConflicts, compilePlan, projectDependency } from "./productivity.ts";
import type { Capsule, FailureOptions, Json, Lease, Measurement, Recipe, RunSummary, Task } from "./types.ts";

export class Scheduler {
  readonly store: Store;
  // Only immutable task specifications are cached. Lease/status state is always
  // re-read inside BEGIN IMMEDIATE, including when another process claims work.
  private cachedPlan?: { runId: string; recipeHash: string; plan: ReturnType<typeof compilePlan> };
  constructor(store: Store) { this.store = store; }
  private plan(runId: string, recipeHash: string, recipe: Recipe, rows?: Record<string, unknown>[]) {
    if (this.cachedPlan?.runId === runId && this.cachedPlan.recipeHash === recipeHash) return this.cachedPlan.plan;
    const tasks: Task[] = (rows ?? this.store.db.prepare("SELECT spec FROM tasks WHERE run=?").all(runId)).map(t => {
      invariant(typeof t.spec === "string", "missing persisted task specification");
      return JSON.parse(t.spec) as Task;
    });
    const plan = compilePlan(tasks, recipe, this.store.contract().limits.contextBytes);
    this.cachedPlan = { runId, recipeHash, plan }; return plan;
  }
  start(tasks: Task[], recipeHash = this.store.active(), now = Date.now()): string {
    const contract = this.store.contract(); validateTasks(contract, tasks);
    // Reject an impossible reservation before creating a permanently idle run.
    compilePlan(tasks, this.store.recipe(recipeHash), contract.limits.contextBytes);
    const id = randomUUID();
    this.store.transaction(() => {
      this.store.db.prepare("INSERT INTO runs(id,recipe,contract,started,status) VALUES(?,?,?,?, 'RUNNING')").run(id, recipeHash, digest(contract), now);
      const insert = this.store.db.prepare("INSERT INTO tasks(run,id,spec,status) VALUES(?,?,?,'READY')");
      for (const task of tasks) insert.run(id, task.id, JSON.stringify(task));
      this.store.event("run.started", { recipeHash, contractHash: digest(contract), taskCount: tasks.length, taskHash: digest(tasks) }, id);
    });
    return id;
  }
  /** Backward-compatible single claim; all reservations share the batch path. */
  claim(runId: string, owner: string, now = Date.now()): Lease | null {
    return this.claimMany(runId, owner, 1, now)[0] ?? null;
  }
  /** One durable transaction per refill, not one DAG parse/commit per agent.
   *  There are no wave barriers: a finishing agent immediately frees a slot. */
  claimMany(runId: string, owner: string, limit: number, now = Date.now()): Lease[] {
    invariant(typeof owner === "string" && owner.length > 0, "missing owner");
    invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 256, "invalid claim batch size");
    return this.store.transaction(() => {
      const run = this.store.db.prepare("SELECT * FROM runs WHERE id=?").get(runId); invariant(run, "unknown run");
      if (run.status !== "RUNNING") return [];
      invariant(run.contract === digest(this.store.contract()), "run contract drift");
      const recipe = this.store.recipe(run.recipe);
      const rows = this.store.db.prepare("SELECT * FROM tasks WHERE run=?").all(runId);
      const plan = this.plan(runId, run.recipe, recipe, rows);
      const byId = new Map(rows.map(t => [t.id as string, t]));
      for (const t of rows.filter(t => t.status === "RUNNING" && t.deadline <= now)) {
        const attempt = this.store.db.prepare("SELECT started FROM attempts WHERE run=? AND task=? AND fence=?").get(runId, t.id, t.fence)!;
        this.store.db.prepare("UPDATE attempts SET status='EXPIRED',ended=?,duration=? WHERE run=? AND task=? AND fence=? AND status='RUNNING'").run(now, Math.max(0, now - attempt.started), runId, t.id, t.fence);
        t.status = t.fence >= recipe.attempts ? "FAIL" : "READY";
        this.store.db.prepare("UPDATE tasks SET status=?,owner=NULL,deadline=NULL,error='lease expired' WHERE run=? AND id=?").run(t.status, runId, t.id);
        this.store.event("lease.expired", { fence: t.fence }, runId, t.id);
      }
      // Linear failure propagation, rather than repeated full SQL rescans for
      // each level of a deep failed dependency chain.
      const failed = rows.filter(t => t.status === "FAIL" || t.status === "BLOCKED").map(t => t.id as string);
      for (let i = 0; i < failed.length; i++) for (const id of plan.children.get(failed[i]) ?? []) {
        const child = byId.get(id)!;
        if (child.status !== "READY") continue;
        child.status = "BLOCKED"; failed.push(id);
        this.store.db.prepare("UPDATE tasks SET status='BLOCKED',error='dependency failed' WHERE run=? AND id=?").run(runId, id);
        this.store.event("task.blocked", { reason: "dependency failed" }, runId, id);
      }
      if (rows.every(t => ["PASS", "FAIL", "BLOCKED"].includes(t.status))) {
        const status = rows.length > 0 && rows.every(t => t.status === "PASS") ? "PASS" : "FAIL";
        this.store.db.prepare("UPDATE runs SET status=?,ended=? WHERE id=?").run(status, now, runId);
        this.store.event("run.finished", { status }, runId); return [];
      }
      const running = rows.filter(t => t.status === "RUNNING");
      const capacity = Math.min(limit, recipe.parallelism - running.length);
      if (capacity <= 0) return [];
      const active = running.map(t => plan.byId.get(t.id)!);
      let reserved = active.reduce((n, task) => n + plan.budgets.get(task.id)!, 0);
      const leases: Lease[] = [];
      for (const task of plan.order) {
        const row = byId.get(task.id)!;
        if (row.status !== "READY" || !task.dependencies.every(d => byId.get(d)!.status === "PASS") ||
            active.some(other => accessConflicts(task, other))) continue;
        const budget = plan.budgets.get(task.id)!;
        if (recipe.maxInFlightContextBytes !== undefined && reserved + budget > recipe.maxInFlightContextBytes) continue;
        const fence = row.fence + 1; const deadline = now + recipe.timeoutMs;
        this.store.db.prepare("UPDATE tasks SET status='RUNNING',fence=?,owner=?,deadline=?,error=NULL WHERE run=? AND id=?").run(fence, owner, deadline, runId, task.id);
        this.store.db.prepare("INSERT INTO attempts(run,task,fence,started,status) VALUES(?,?,?,?,'RUNNING')").run(runId, task.id, fence, now);
        this.store.event("task.claimed", { owner, fence, deadline, reservedContextBytes: budget,
          criticalPathEstimate: plan.ranks.get(task.id) ?? null }, runId, task.id);
        leases.push({ runId, taskId: task.id, owner, fence, deadline, recipeHash: run.recipe, contractHash: run.contract });
        active.push(task); reserved += budget; row.status = "RUNNING";
        if (leases.length >= capacity) break;
      }
      return leases;
    });
  }
  status(runId: string): RunSummary["status"] {
    const row = this.store.db.prepare("SELECT status FROM runs WHERE id=?").get(runId);
    invariant(row, "unknown run"); return row.status;
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
      const source = this.store.readArtifact(dep.artifact);
      const pointers = task.dependencyViews && Object.hasOwn(task.dependencyViews, id) ? task.dependencyViews[id] : undefined;
      if (!pointers) return { taskId: id, artifactHash: dep.artifact as string, artifact: source };
      const artifact = projectDependency(source, pointers);
      return { taskId: id, artifactHash: dep.artifact as string, artifact, view: { pointers, hash: digest(artifact) } };
    });
    const capsule: Capsule = { schema: 1, runId: lease.runId, task, contractHash: lease.contractHash, recipeHash: lease.recipeHash, fence: lease.fence, dependencies };
    // Use per-task context budget when available, falling back to recipe default.
    const recipe = this.store.recipe(lease.recipeHash);
    const budgets = this.plan(lease.runId, lease.recipeHash, recipe).budgets;
    const taskBudget = budgets.get(lease.taskId) ?? recipe.contextBytes;
    const text = encodeCapsule(capsule, Math.min(taskBudget, this.store.contract().limits.contextBytes));
    this.store.transaction(() => {
      invariant(this.current(lease, Date.now()), "stale lease");
      this.store.db.prepare(`INSERT INTO attempt_telemetry(run,task,fence,context_bytes) VALUES(?,?,?,?)
        ON CONFLICT(run,task,fence) DO UPDATE SET context_bytes=excluded.context_bytes`)
        .run(lease.runId, lease.taskId, lease.fence, Buffer.byteLength(text, "utf8"));
    });
    return capsule;
  }
  /** Progress changes liveness only; it can never release dependencies. */
  progress(lease: Lease, fingerprint: string, now = Date.now()): boolean {
    return this.store.transaction(() => {
      if (!this.current(lease, now)) return false;
      this.store.db.prepare(`INSERT INTO attempt_telemetry(run,task,fence,progress_count,last_progress_at) VALUES(?,?,?,1,?)
        ON CONFLICT(run,task,fence) DO UPDATE SET progress_count=progress_count+1,last_progress_at=excluded.last_progress_at`)
        .run(lease.runId, lease.taskId, lease.fence, now);
      this.store.event("attempt.progress", { fence: lease.fence, fingerprint: digest(fingerprint) }, lease.runId, lease.taskId);
      return true;
    });
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
  fail(lease: Lease, reason: string, measurement: Measurement = { tokens: null, costUsd: null }, now = Date.now(), options: FailureOptions = {}): boolean {
    validMeasurement(measurement);
    return this.store.transaction(() => {
      // An expired lease is reclaimed by claim(); do not overwrite a new owner.
      if (!this.current(lease, now)) { this.store.event("failure.stale", { fence: lease.fence, reason }, lease.runId, lease.taskId); return false; }
      const recipe = this.store.recipe(lease.recipeHash);
      const a = this.store.db.prepare("SELECT started FROM attempts WHERE run=? AND task=? AND fence=?").get(lease.runId, lease.taskId, lease.fence)!;
      const fingerprint = digest(options.fingerprint ?? reason.slice(0, 4096));
      this.store.db.prepare(`INSERT INTO attempt_telemetry(run,task,fence,failure_fingerprint) VALUES(?,?,?,?)
        ON CONFLICT(run,task,fence) DO UPDATE SET failure_fingerprint=excluded.failure_fingerprint`)
        .run(lease.runId, lease.taskId, lease.fence, fingerprint);
      let repeated = 0;
      const previous = this.store.db.prepare(`SELECT m.failure_fingerprint FROM attempts a LEFT JOIN attempt_telemetry m
        ON a.run=m.run AND a.task=m.task AND a.fence=m.fence WHERE a.run=? AND a.task=? ORDER BY a.fence DESC`)
        .all(lease.runId, lease.taskId);
      for (const prior of previous) { if (prior.failure_fingerprint !== fingerprint) break; repeated++; }
      const exhausted = recipe.maxRepeatedFailures !== undefined && repeated >= recipe.maxRepeatedFailures;
      const status = options.retryable === false || exhausted || lease.fence >= recipe.attempts ? "FAIL" : "READY";
      this.store.db.prepare("UPDATE attempts SET status='FAIL',ended=?,duration=?,tokens=?,cost=? WHERE run=? AND task=? AND fence=?").run(now, Math.max(0, now - a.started), measurement.tokens, measurement.costUsd, lease.runId, lease.taskId, lease.fence);
      this.store.db.prepare("UPDATE tasks SET status=?,owner=NULL,deadline=NULL,error=? WHERE run=? AND id=?").run(status, reason.slice(0, 4096), lease.runId, lease.taskId);
      this.store.event("task.failed", { fence: lease.fence, reason: reason.slice(0, 4096), retry: status === "READY", repeated, fingerprint }, lease.runId, lease.taskId); return true;
    });
  }
  summary(id: string, now = Date.now()): RunSummary {
    const r = this.store.db.prepare("SELECT * FROM runs WHERE id=?").get(id); invariant(r, "unknown run");
    const tasks = this.store.db.prepare("SELECT status FROM tasks WHERE run=?").all(id);
    const attempts = this.store.db.prepare("SELECT tokens,cost FROM attempts WHERE run=?").all(id);
    const sum = (key: string): number | null => attempts.length && attempts.every(a => a[key] !== null && Number.isFinite(a[key])) ? attempts.reduce((n, a) => n + a[key], 0) : null;
    const accepted = tasks.filter(t => t.status === "PASS").length;
    const recipe = this.store.recipe(r.recipe);
    // Progress density: verified accepted tasks per total context budget allocated.
    const totalContext = tasks.length * recipe.contextBytes;
    const pd = progressDensity(accepted, totalContext);
    return { id, recipeHash: r.recipe, contractHash: r.contract, status: r.status,
      accepted, failed: tasks.filter(t => t.status === "FAIL").length,
      blocked: tasks.filter(t => t.status === "BLOCKED").length, attempts: attempts.length,
      durationMs: Math.max(0, (r.ended ?? now) - r.started), tokens: sum("tokens"), costUsd: sum("cost"),
      progressDensity: pd };
  }
}
