import { DeferredAttemptError, persistContinuation } from "./continuation.ts";
import { randomUUID } from "node:crypto";
import { Store } from "./store.ts";
import { conflicts, digest, encodeCapsule, invariant, validMeasurement, validateTasks, validateEvidence, progressDensity } from "./kernel.ts";
import { accessConflicts, compilePlan, projectDependency } from "./productivity.ts";
import type { Capsule, FailureOptions, Json, Lease, Measurement, Recipe, RunSummary, Task } from "./types.ts";

export class Scheduler {
  readonly store: Store;
  // Only immutable task specifications are cached. Lease/status state is always
  // re-read inside BEGIN IMMEDIATE, including when another process claims work.
  private cachedPlan?: { runId: string; recipeHash: string; taskCount: number; plan: ReturnType<typeof compilePlan> };
  constructor(store: Store) { this.store = store; }
  private plan(runId: string, recipeHash: string, recipe: Recipe, rows?: Record<string, unknown>[]) {
    const source = rows ?? this.store.db.prepare("SELECT spec FROM tasks WHERE run=?").all(runId);
    const taskCount = source.length;
    if (this.cachedPlan?.runId === runId && this.cachedPlan.recipeHash === recipeHash &&
        this.cachedPlan.taskCount === taskCount) return this.cachedPlan.plan;
    const tasks: Task[] = source.map(t => {
      invariant(typeof t.spec === "string", "missing persisted task specification");
      return JSON.parse(t.spec) as Task;
    });
    const plan = compilePlan(tasks, recipe, this.store.contract().limits.contextBytes);
    this.cachedPlan = { runId, recipeHash, taskCount, plan }; return plan;
  }
  start(tasks: Task[], recipeHash = this.store.active(), now = Date.now(), id = randomUUID()): string {
    const contract = this.store.contract(); validateTasks(contract, tasks);
    // Reject an impossible reservation before creating a permanently idle run.
    compilePlan(tasks, this.store.recipe(recipeHash), contract.limits.contextBytes);
    return this.store.transaction(() => {
      const existing = this.store.db.prepare("SELECT recipe,contract FROM runs WHERE id=?").get(id);
      if (existing) {
        invariant(existing.recipe === recipeHash && existing.contract === digest(contract), "run id binding drift");
        const actual = this.store.db.prepare("SELECT spec FROM tasks WHERE run=? ORDER BY id").all(id).map(t => JSON.parse(t.spec));
        const expected = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
        invariant(digest(actual) === digest(expected), "run id task graph drift");
        return id;
      }
      this.store.db.prepare("INSERT INTO runs(id,recipe,contract,started,status) VALUES(?,?,?,?, 'RUNNING')").run(id, recipeHash, digest(contract), now);
      const insert = this.store.db.prepare("INSERT INTO tasks(run,id,spec,status) VALUES(?,?,?,'READY')");
      for (const task of tasks) insert.run(id, task.id, JSON.stringify(task));
      this.store.event("run.started", { recipeHash, contractHash: digest(contract), taskCount: tasks.length, taskHash: digest(tasks) }, id);
      return id;
    });
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
      const waits = new Map(this.store.db.prepare("SELECT task,wake FROM task_waits WHERE run=?").all(runId).map(t => [t.task, t.wake]));
      for (const t of rows.filter(t => t.status === "RUNNING" && t.deadline <= now)) {
        const attempt = this.store.db.prepare("SELECT started FROM attempts WHERE run=? AND task=? AND fence=?").get(runId, t.id, t.fence)!;
        this.store.db.prepare("UPDATE attempts SET status='EXPIRED',ended=?,duration=? WHERE run=? AND task=? AND fence=? AND status='RUNNING'").run(now, Math.max(0, now - attempt.started), runId, t.id, t.fence);
        t.status = this.failureCount(runId, t.id) >= recipe.attempts ? "FAIL" : "READY";
        this.store.db.prepare("UPDATE tasks SET status=?,owner=NULL,deadline=NULL,error='lease expired' WHERE run=? AND id=?").run(t.status, runId, t.id);
        this.store.event("lease.expired", { fence: t.fence }, runId, t.id);
      }
      // Runtime-spawned children are scheduler dependencies without mutating the
      // parent's immutable task/thread binding. A failed child blocks its parent;
      // an incomplete child set keeps the parent unclaimable.
      const spawned = new Map<string, string[]>();
      for (const edge of this.store.db.prepare(
        "SELECT parent,child FROM spawn_edges WHERE run=? ORDER BY parent,child"
      ).all(runId)) {
        const list = spawned.get(edge.parent) ?? [];
        list.push(edge.child); spawned.set(edge.parent, list);
      }
      // Linear failure propagation, rather than repeated full SQL rescans for
      // each level of a deep failed dependency chain.
      const failed = rows.filter(t => t.status === "FAIL" || t.status === "BLOCKED").map(t => t.id as string);
      for (const [parentId, children] of spawned) {
        const parent = byId.get(parentId);
        if (!parent || parent.status !== "READY") continue;
        if (!children.some(id => ["FAIL", "BLOCKED"].includes(byId.get(id)?.status as string))) continue;
        parent.status = "BLOCKED"; failed.push(parentId);
        this.store.db.prepare(
          "UPDATE tasks SET status='BLOCKED',error='spawned child failed' WHERE run=? AND id=?"
        ).run(runId, parentId);
        this.store.event("task.blocked", { reason: "spawned child failed" }, runId, parentId);
      }
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
      const snapshotReads = this.store.contract().readIsolation === "snapshot";
      for (const task of plan.order) {
        const row = byId.get(task.id)!;
        if (row.status !== "READY" || (waits.get(task.id) ?? 0) > now ||
            !task.dependencies.every(d => byId.get(d)!.status === "PASS") ||
            !(spawned.get(task.id) ?? []).every(d => byId.get(d)?.status === "PASS") ||
            active.some(other => snapshotReads
              ? conflicts(task.writeScope, other.writeScope) : accessConflicts(task, other))) continue;
        const budget = plan.budgets.get(task.id)!;
        if (recipe.maxInFlightContextBytes !== undefined && reserved + budget > recipe.maxInFlightContextBytes) continue;
        const fence = row.fence + 1; const deadline = now + recipe.timeoutMs;
        this.store.db.prepare("UPDATE tasks SET status='RUNNING',fence=?,owner=?,deadline=?,error=NULL WHERE run=? AND id=?").run(fence, owner, deadline, runId, task.id);
        this.store.db.prepare("INSERT INTO attempts(run,task,fence,started,status) VALUES(?,?,?,?,'RUNNING')").run(runId, task.id, fence, now);
        this.store.event("task.claimed", { owner, fence, deadline, reservedContextBytes: budget,
          criticalPathEstimate: plan.ranks.get(task.id) ?? null }, runId, task.id);
        leases.push({ runId, taskId: task.id, owner, fence, deadline, recipeHash: run.recipe, contractHash: run.contract });
        this.store.db.prepare("DELETE FROM task_waits WHERE run=? AND task=?").run(runId, task.id);
        this.store.db.prepare("INSERT INTO attempt_health VALUES(?,?,?,?,?,NULL,NULL)").run(runId, task.id, fence, "prepare", now);
        active.push(task); reserved += budget; row.status = "RUNNING";
        if (leases.length >= capacity) break;
      }
      return leases;
    });
  }
  private failureCount(run: string, task: string): number {
    return this.store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE run=? AND task=? AND status IN ('FAIL','EXPIRED')").get(run, task)!.n;
  }
  defer(lease: Lease, error: DeferredAttemptError, measurement: Measurement = { tokens: null, costUsd: null }, now = Date.now()): boolean {
    validMeasurement(measurement);
    return this.store.transaction(() => {
      if (!this.current(lease, now)) return false;
      persistContinuation(this.store, lease, error, measurement, now); return true;
    });
  }
  activity(lease: Lease, stage: string, checked = false, now = Date.now()): boolean {
    invariant(typeof stage === "string" && stage.length > 0 && stage.length <= 128, "invalid stage");
    return this.store.transaction(() => {
      if (!this.current(lease, now)) return false;
      this.store.db.prepare("UPDATE attempt_health SET stage=?,activity_at=?,check_at=CASE WHEN ? THEN ? ELSE check_at END WHERE run=? AND task=? AND fence=?")
        .run(stage, now, checked ? 1 : 0, now, lease.runId, lease.taskId, lease.fence); return true;
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
      this.store.db.prepare("UPDATE attempt_health SET progress_at=? WHERE run=? AND task=? AND fence=?").run(now, lease.runId, lease.taskId, lease.fence);
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
        ON a.run=m.run AND a.task=m.task AND a.fence=m.fence WHERE a.run=? AND a.task=? AND a.status<>'DEFERRED' ORDER BY a.fence DESC`)
        .all(lease.runId, lease.taskId);
      for (const prior of previous) { if (prior.failure_fingerprint !== fingerprint) break; repeated++; }
      const exhausted = recipe.maxRepeatedFailures !== undefined && repeated >= recipe.maxRepeatedFailures;
      const status = options.retryable === false || exhausted || this.failureCount(lease.runId, lease.taskId) + 1 >= recipe.attempts ? "FAIL" : "READY";
      this.store.db.prepare("UPDATE attempts SET status='FAIL',ended=?,duration=?,tokens=?,cost=? WHERE run=? AND task=? AND fence=?").run(now, Math.max(0, now - a.started), measurement.tokens, measurement.costUsd, lease.runId, lease.taskId, lease.fence);
      this.store.db.prepare("UPDATE tasks SET status=?,owner=NULL,deadline=NULL,error=? WHERE run=? AND id=?").run(status, reason.slice(0, 4096), lease.runId, lease.taskId);
      this.store.event("task.failed", { fence: lease.fence, reason: reason.slice(0, 4096), retry: status === "READY", repeated, fingerprint }, lease.runId, lease.taskId); return true;
    });
  }
  summary(id: string, now = Date.now()): RunSummary {
    const r = this.store.db.prepare("SELECT * FROM runs WHERE id=?").get(id); invariant(r, "unknown run");
    const tasks = this.store.db.prepare("SELECT id,status FROM tasks WHERE run=?").all(id);
    const attempts = this.store.db.prepare("SELECT tokens,cost FROM attempts WHERE run=?").all(id);
    const sum = (key: string): number | null => attempts.length && attempts.every(a => a[key] !== null && Number.isFinite(a[key])) ? attempts.reduce((n, a) => n + a[key], 0) : null;
    const accepted = tasks.filter(t => t.status === "PASS").length;
    // Dynamic children are implementation work, not additional objective progress.
    // Keep the numerator bound to the admitted task graph so a provider cannot
    // improve progressDensity merely by splitting one task into many verified
    // subtasks. Child attempts still contribute to the measured input denominator.
    const spawnedChildren = new Set(this.store.db.prepare(
      "SELECT child FROM spawn_edges WHERE run=?"
    ).all(id).map(row => String(row.child)));
    const verifiedProgress = tasks.filter(t =>
      t.status === "PASS" && !spawnedChildren.has(String(t.id))).length;
    // Progress density uses actual encoded capsule bytes recorded by the trusted
    // host for prepared attempts. It is not a recipe allocation, token bill, or
    // provider KV/prompt-cache metric.
    const contexts = this.store.db.prepare(
      "SELECT context_bytes FROM attempt_telemetry WHERE run=? AND context_bytes IS NOT NULL"
    ).all(id);
    const validContexts = contexts.every(x =>
      Number.isSafeInteger(x.context_bytes) && x.context_bytes > 0);
    const totalContext = contexts.length && validContexts
      ? contexts.reduce((n, x) => n + x.context_bytes, 0) : null;
    const pd = totalContext === null ? null : progressDensity(verifiedProgress, totalContext);
    return { id, recipeHash: r.recipe, contractHash: r.contract, status: r.status,
      accepted, failed: tasks.filter(t => t.status === "FAIL").length,
      blocked: tasks.filter(t => t.status === "BLOCKED").length, attempts: attempts.length,
      durationMs: Math.max(0, (r.ended ?? now) - r.started), tokens: sum("tokens"), costUsd: sum("cost"),
      progressDensity: pd };
  }
}
