import { randomUUID } from "node:crypto";
import { DeferredAttemptError } from "../continuation.ts";
import { ensureRunFabric } from "../evidenceFabric.ts";
import { setTimeout as delay } from "node:timers/promises";
import { canonical, digest, identifier, invariant, validateTasks } from "../kernel.ts";
import { runHealth, type HealthObserver } from "../health.ts";
import { Scheduler } from "../scheduler.ts";
import type { Store } from "../store.ts";
import type { Json, Task } from "../types.ts";
import { integrateSwarm, loadSwarm, runSwarm } from "./host.ts";
import { inScope, validateSwarmTasks } from "./config.ts";
import { createApiRecoveryPlanner } from "./recovery.ts";

export interface ObjectiveInput { id: string; goal?: string; tasks?: Task[] }
export interface RecoveryContext {
  objectiveId: string; goal: string; runId: string; reason: string; revision: number;
  tasks: Task[]; failures: { id: string; status: string; error: string | null }[];
}
export interface RecoveryPlan { reason: string; tasks: Task[] }
export type RecoveryPlanner = (context: RecoveryContext, signal: AbortSignal) => Promise<RecoveryPlan | null>;

export interface ObjectiveEvidenceGate {
  status: "PASS" | "BLOCKED";
  taskCount: number;
  verifiedTasks: number;
  missingTaskEvidence: string[];
  openConflicts: number;
  conflictIds: string[];
}

/** Host-owned completion gate. External models may propose work, but they never
 * get to declare an objective complete. Every task must have durable accepted
 * artifact/evidence, and unresolved contradictory evidence blocks completion. */
export function objectiveEvidenceGate(store: Store, run: string): ObjectiveEvidenceGate {
  ensureRunFabric(store, run);
  const counts = store.db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN status='PASS' AND artifact IS NOT NULL AND evidence IS NOT NULL THEN 1 ELSE 0 END),0) AS verified
    FROM tasks WHERE run=?`).get(run);
  invariant(counts && Number(counts.total) > 0, "unknown objective run");
  const missingTaskEvidence = store.db.prepare(`SELECT id FROM tasks
    WHERE run=? AND (status<>'PASS' OR artifact IS NULL OR evidence IS NULL)
    ORDER BY id LIMIT 20`).all(run).map(row => String(row.id));
  const conflictRows = store.db.prepare(`SELECT id FROM fabric_conflicts
    WHERE run=? AND status='OPEN' ORDER BY created,id LIMIT 20`).all(run);
  const openConflicts = Number(store.db.prepare(
    "SELECT COUNT(*) AS n FROM fabric_conflicts WHERE run=? AND status='OPEN'"
  ).get(run)?.n ?? 0);
  return {
    status: Number(counts.verified) === Number(counts.total) && openConflicts === 0 ? "PASS" : "BLOCKED",
    taskCount: Number(counts.total),
    verifiedTasks: Number(counts.verified),
    missingTaskEvidence,
    openConflicts,
    conflictIds: conflictRows.map(row => String(row.id)),
  };
}
export function recoveryStrategySignature(tasks: Task[], defaultAgent?: string): string {
  const remaining = new Map(tasks.map(task => [task.id, task]));
  const labels = new Map<string, string>();
  while (remaining.size) {
    let progressed = false;
    for (const [id, task] of [...remaining.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!task.dependencies.every(dep => labels.has(dep))) continue;
      const dependencyLabels = task.dependencies.map(dep => labels.get(dep)!).sort();
      const views = task.dependencyViews
        ? task.dependencies.map(dep => task.dependencyViews?.[dep] ?? null)
        : [];
      labels.set(id, digest({
        agent: task.agent ?? defaultAgent ?? null,
        goal: task.goal.trim().replace(/\s+/g, " "),
        acceptance: task.acceptance.map(value => value.trim().replace(/\s+/g, " ")),
        input: task.input,
        writeScope: [...task.writeScope].sort(),
        readScope: [...(task.readScope ?? [])].sort(),
        dependencies: dependencyLabels,
        dependencyViews: views,
        priority: task.priority ?? null,
        estimatedDurationMs: task.estimatedDurationMs ?? null,
        contextBudget: task.contextBudget ?? null,
      }));
      remaining.delete(id); progressed = true;
    }
    invariant(progressed, "recovery strategy graph is cyclic or references unknown dependencies");
  }
  return digest([...labels.values()].sort());
}
export function installObjectives(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS swarm_objectives(
    id TEXT PRIMARY KEY, goal TEXT NOT NULL, plan TEXT NOT NULL, cfg TEXT NOT NULL,
    run TEXT UNIQUE, state TEXT NOT NULL, reason TEXT, owner TEXT, lease REAL,
    updated REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS swarm_objective_revisions(
      objective TEXT NOT NULL, revision INTEGER NOT NULL, plan TEXT NOT NULL, run TEXT NOT NULL,
      reason TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(objective,revision));
    CREATE TABLE IF NOT EXISTS swarm_recovery_attempts(
      objective TEXT NOT NULL, run TEXT NOT NULL, revision INTEGER NOT NULL,
      state TEXT NOT NULL, detail TEXT NOT NULL, new_run TEXT, retry_at REAL,
      created REAL NOT NULL, updated REAL NOT NULL, PRIMARY KEY(objective,run));
    CREATE TABLE IF NOT EXISTS swarm_objective_budgets(
      objective TEXT PRIMARY KEY, max_requests INTEGER NOT NULL, max_request_bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS swarm_objective_completions(
      objective TEXT PRIMARY KEY, run TEXT NOT NULL, attestation TEXT NOT NULL,
      created REAL NOT NULL);`);
  const recoveryColumns = new Set(store.db.prepare("PRAGMA table_info(swarm_recovery_attempts)").all().map(r => String(r.name)));
  if (!recoveryColumns.has("retry_at"))
    store.db.exec("ALTER TABLE swarm_recovery_attempts ADD COLUMN retry_at REAL");
}
export function objectiveStatus(store: Store, id: string): Json {
  installObjectives(store); identifier(id);
  const r = store.db.prepare("SELECT id,goal,run,state,reason,updated,lease FROM swarm_objectives WHERE id=?").get(id);
  invariant(r, "unknown objective");
  const revision = store.db.prepare("SELECT MAX(revision) AS n FROM swarm_objective_revisions WHERE objective=?").get(id)?.n ?? 0;
  const recovery = store.db.prepare("SELECT state,detail,new_run,retry_at,updated FROM swarm_recovery_attempts WHERE objective=? ORDER BY revision DESC LIMIT 1").get(id);
  const budget = store.db.prepare("SELECT max_requests,max_request_bytes FROM swarm_objective_budgets WHERE objective=?").get(id);
  const completion = store.db.prepare(
    "SELECT run,attestation,created FROM swarm_objective_completions WHERE objective=?"
  ).get(id);
  const usage = store.db.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(bytes),0) AS request_bytes
    FROM agent_requests WHERE run IN (
      SELECT run FROM swarm_objective_revisions WHERE objective=?
      UNION SELECT run FROM swarm_objectives WHERE id=? AND run IS NOT NULL
    )`).get(id, id) ?? { requests: 0, request_bytes: 0 };
  const evidenceGate = r.run && store.db.prepare("SELECT 1 FROM runs WHERE id=?").get(r.run)
    ? objectiveEvidenceGate(store, String(r.run)) : null;
  return { ...(r as Record<string, Json>), revision, recovery: (recovery ?? null) as Json,
    budget: budget ? { maxRequests: budget.max_requests, maxRequestBytes: budget.max_request_bytes,
      usedRequests: usage.requests, usedRequestBytes: usage.request_bytes } : null,
    evidenceGate: evidenceGate as unknown as Json,
    completion: (completion ?? null) as Json };
}

function recordObjectiveCompletion(store: Store, objective: string, row: any,
  integration: Json, gate: ObjectiveEvidenceGate, now = Date.now()): string {
  invariant(gate.status === "PASS", "objective completion requires a passing evidence gate");
  const lineage = store.db.prepare(`SELECT revision,plan,run,reason FROM swarm_objective_revisions
    WHERE objective=? ORDER BY revision`).all(objective).map(item => ({
      revision: Number(item.revision), plan: String(item.plan), run: String(item.run), reason: String(item.reason),
    }));
  const attestation = JSON.parse(canonical({
    schema: 1,
    objective,
    goalHash: digest(String(row.goal)),
    configurationHash: String(row.cfg),
    run: String(row.run),
    planHash: String(row.plan),
    lineage,
    evidenceGate: gate,
    integration,
  })) as Json;
  const hash = store.artifact(attestation);
  store.transaction(() => {
    const current = store.db.prepare(
      "SELECT run,attestation FROM swarm_objective_completions WHERE objective=?"
    ).get(objective);
    if (current) {
      invariant(current.run === row.run && current.attestation === hash,
        "objective completion attestation drift");
      return;
    }
    store.db.prepare(
      "INSERT INTO swarm_objective_completions(objective,run,attestation,created) VALUES(?,?,?,?)"
    ).run(objective, row.run, hash, now);
    store.event("objective.completed", { id: objective, run: row.run, attestation: hash }, row.run);
  });
  return hash;
}

/** Persistent, single-host objective control on the SAME Foundry scheduler.
 * It never turns a turn-end or a failed run into objective completion. Recoverable
 * work resumes in runTasks; exhausted budgets or unsafe outcomes remain visible
 * NEEDS_ATTENTION instead of silently exiting or resetting resource ceilings. */
export async function superviseSwarm(store: Store, input: ObjectiveInput, signal: AbortSignal,
  onProgress?: HealthObserver, fetcher?: typeof fetch, recoveryPlanner?: RecoveryPlanner): Promise<Json> {
  identifier(input.id); const cfg = loadSwarm(store); installObjectives(store);
  const owner = randomUUID(); const ttl = 30000;
  if (input.tasks) { validateTasks(store.contract(), input.tasks); validateSwarmTasks(cfg.spec, input.tasks); }
  if (input.goal !== undefined) invariant(input.goal.trim().length > 0 && Buffer.byteLength(input.goal) <= 16384, "invalid objective goal");
  const plan = input.tasks ? store.artifact(JSON.parse(canonical(input.tasks))) : null;
  const supervision = cfg.spec.supervision;
  const maxObjectiveRequests = supervision?.maxObjectiveRequests ??
    Math.min(Number.MAX_SAFE_INTEGER, cfg.spec.budget.maxRequests * 64);
  const maxObjectiveRequestBytes = supervision?.maxObjectiveRequestBytes ??
    Math.min(Number.MAX_SAFE_INTEGER, cfg.spec.budget.maxRequestBytes * 64);
  store.transaction(() => {
    const row = store.db.prepare("SELECT * FROM swarm_objectives WHERE id=?").get(input.id); const now = Date.now();
    if (row) {
      invariant(row.cfg === digest(cfg), "objective configuration drift");
      invariant(input.goal === undefined || row.goal === input.goal, "objective goal changed; create a new objective");
      invariant(plan === null || row.plan === plan, "objective plan changed; create a new objective");
      invariant(!row.owner || row.lease <= now, "objective already supervised");
      store.db.prepare("UPDATE swarm_objectives SET owner=?,lease=?,updated=? WHERE id=?").run(owner, now + ttl, now, input.id);
    } else {
      invariant(input.goal && plan, "new objective requires --goal and --tasks");
      store.db.prepare("INSERT INTO swarm_objectives VALUES(?,?,?,?,NULL,'RUNNING',NULL,?,?,?)")
        .run(input.id, input.goal, plan, digest(cfg), owner, now + ttl, now);
    }
    const budget = store.db.prepare("SELECT max_requests,max_request_bytes FROM swarm_objective_budgets WHERE objective=?").get(input.id);
    if (budget) invariant(budget.max_requests === maxObjectiveRequests && budget.max_request_bytes === maxObjectiveRequestBytes,
      "objective budget drift");
    else store.db.prepare("INSERT INTO swarm_objective_budgets VALUES(?,?,?)")
      .run(input.id, maxObjectiveRequests, maxObjectiveRequestBytes);
  });
  const configuredReplans = supervision?.maxReplans;
  const recoveryEnabled = configuredReplans !== 0;
  const planner = recoveryPlanner ?? (recoveryEnabled ? createApiRecoveryPlanner(store, cfg, fetcher ?? fetch) : undefined);
  const controller = new AbortController(); const stop = () => controller.abort(signal.reason ?? new Error("operator paused"));
  signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
  const assertOwner = () => {
    const row = store.db.prepare("SELECT * FROM swarm_objectives WHERE id=?").get(input.id)!;
    invariant(row.owner === owner && row.lease > Date.now(), "stale objective supervisor"); return row;
  };
  const transition = (state: string, reason: string | null = null) => store.transaction(() => {
    const row = assertOwner();
    if (row.state !== state || row.reason !== reason) {
      store.db.prepare("UPDATE swarm_objectives SET state=?,reason=?,updated=? WHERE id=?").run(state, reason, Date.now(), input.id);
      store.event("objective.state", { id: input.id, state, reason }, row.run);
    }
  });
  const pulse = setInterval(() => {
    try { store.transaction(() => { assertOwner(); store.db.prepare("UPDATE swarm_objectives SET lease=?,updated=? WHERE id=?").run(Date.now() + ttl, Date.now(), input.id); }); }
    catch (e) { controller.abort(e); }
  }, ttl / 3);
  const report = () => {
    const row = assertOwner(); if (!row.run || !onProgress) return;
    const health = runHealth(store, row.run);
    try { onProgress({ ...health, status: row.state, tasks: health.tasks.length ? health.tasks : row.reason ?
      [{ id: "objective", status: row.state, stage: "integration", activityAgeMs: null, progressAgeMs: null, checkAgeMs: null, deadline: null, wakeAt: null, reason: row.reason }] : [] }); }
    catch { store.event("observer.error", { reason: "objective observer threw" }, row.run); }
  };
  const unresolvedRemoteJobs = (run: string): number => {
    const exists = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_jobs'").get();
    if (!exists) return 0;
    return store.db.prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE run=? AND result_hash IS NULL").get(run)!.n;
  };
  const adoptPreparedRecovery = (row: any, recovery: any): boolean => {
    invariant(recovery?.state === "PREPARED" && typeof recovery.new_run === "string", "invalid prepared recovery");
    const revision = store.db.prepare("SELECT plan,run,reason FROM swarm_objective_revisions WHERE objective=? AND revision=?")
      .get(input.id, recovery.revision);
    invariant(revision && revision.run === recovery.new_run, "prepared recovery revision missing or drifted");
    const tasks = store.readArtifact(revision.plan) as unknown as Task[];
    validateTasks(store.contract(), tasks); validateSwarmTasks(cfg.spec, tasks);
    const source = store.db.prepare("SELECT recipe FROM runs WHERE id=?").get(row.run);
    invariant(source?.recipe, "recovery source run missing");
    // The run identity is durable before creation. Repeating start after a crash
    // adopts the exact same run and task graph instead of creating another run.
    new Scheduler(store).start(tasks, source.recipe, Date.now(), recovery.new_run);
    store.transaction(() => {
      const current = assertOwner(); invariant(current.run === row.run, "objective changed during recovery adoption");
      const now = Date.now();
      store.db.prepare("UPDATE swarm_objectives SET plan=?,run=?,state='RUNNING',reason=NULL,updated=? WHERE id=?")
        .run(revision.plan, recovery.new_run, now, input.id);
      store.db.prepare("UPDATE swarm_recovery_attempts SET state='PLANNED',detail=?,retry_at=NULL,updated=? WHERE objective=? AND run=?")
        .run(String(revision.reason).slice(0, 2048), now, input.id, row.run);
      store.event("objective.replanned", { id: input.id, fromRun: row.run, toRun: recovery.new_run,
        revision: recovery.revision, plan: revision.plan }, recovery.new_run);
    });
    return true;
  };
  const attemptRecovery = async (reason: string): Promise<boolean> => {
    const row = assertOwner(); if (!row.run) return false;
    const existing = store.db.prepare("SELECT * FROM swarm_recovery_attempts WHERE objective=? AND run=?").get(input.id, row.run);
    if (existing?.state === "PREPARED") return adoptPreparedRecovery(row, existing);
    if (existing?.state === "STARTED" && existing.retry_at != null && existing.retry_at > Date.now()) return false;
    const maxReplans = configuredReplans;
    if (!planner || maxReplans === 0) return false;
    if (existing && existing.state !== "STARTED") return false; // terminal planner decision is durable
    const used = store.db.prepare("SELECT COUNT(*) AS n FROM swarm_objective_revisions WHERE objective=? AND revision>0").get(input.id)!.n;
    if (!existing && maxReplans !== undefined && used >= maxReplans) return false;
    const revision = existing ? existing.revision : used + 1;
    const tasks = store.readArtifact(row.plan) as unknown as Task[];
    const failures = store.db.prepare("SELECT id,status,error FROM tasks WHERE run=? AND status<>'PASS' ORDER BY id LIMIT 200").all(row.run)
      .map(r => ({ id: String(r.id), status: String(r.status), error: r.error == null ? null : String(r.error).slice(0, 1024) }));
    if (!existing) store.transaction(() => {
      assertOwner(); const now = Date.now();
      store.db.prepare(`INSERT INTO swarm_recovery_attempts
        (objective,run,revision,state,detail,new_run,retry_at,created,updated)
        VALUES(?,?,?,?,?,NULL,NULL,?,?)`)
        .run(input.id, row.run, revision, "STARTED", reason.slice(0, 2048), now, now);
      store.event("objective.recovery.started", { id: input.id, run: row.run, revision, reason: reason.slice(0, 1024) }, row.run);
    });
    let proposal: RecoveryPlan | null = null;
    try {
      // STARTED is deliberately replayable: the planner has no execution authority
      // and no replacement run has been admitted yet. A controller crash can safely
      // repeat planning under the same bounded revision.
      proposal = await planner({ objectiveId: input.id, goal: row.goal, runId: row.run, reason, revision, tasks, failures }, controller.signal);
      controller.signal.throwIfAborted();
      if (!proposal) {
        store.db.prepare("UPDATE swarm_recovery_attempts SET state='DECLINED',detail=?,retry_at=NULL,updated=? WHERE objective=? AND run=?")
          .run("planner returned no safe recovery plan", Date.now(), input.id, row.run);
        return false;
      }
      invariant(typeof proposal.reason === "string" && proposal.reason.trim().length > 0 && Buffer.byteLength(proposal.reason) <= 4096, "invalid recovery reason");
      validateTasks(store.contract(), proposal.tasks); validateSwarmTasks(cfg.spec, proposal.tasks);
      const writeAuthority = tasks.flatMap(task => task.writeScope);
      const readAuthority = [...writeAuthority, ...tasks.flatMap(task => task.readScope ?? [])];
      for (const task of proposal.tasks) {
        for (const path of task.writeScope)
          invariant(inScope(path, writeAuthority), "recovery plan widens write authority");
        for (const path of task.readScope ?? [])
          invariant(inScope(path, readAuthority), "recovery plan widens read authority");
      }
      const proposalStrategy = recoveryStrategySignature(proposal.tasks, cfg.spec.defaultAgent);
      const priorStrategies = store.db.prepare(
        "SELECT plan FROM swarm_objective_revisions WHERE objective=? ORDER BY revision"
      ).all(input.id).map(row => recoveryStrategySignature(
        store.readArtifact(String(row.plan)) as unknown as Task[], cfg.spec.defaultAgent
      ));
      invariant(!priorStrategies.includes(proposalStrategy),
        "recovery plan repeats a previously failed execution strategy");
      const newPlan = store.artifact(JSON.parse(canonical(proposal.tasks)));
      const newRun = randomUUID();
      const source = store.db.prepare("SELECT recipe FROM runs WHERE id=?").get(row.run);
      invariant(source?.recipe, "recovery source run missing");
      // Persist the exact replacement identity and graph BEFORE creating the run.
      // Any crash from this point is reconciled through adoptPreparedRecovery().
      store.transaction(() => {
        const current = assertOwner(); invariant(current.run === row.run, "objective changed during recovery planning");
        const now = Date.now();
        store.db.prepare("INSERT INTO swarm_objective_revisions VALUES(?,?,?,?,?,?)")
          .run(input.id, revision, newPlan, newRun, proposal!.reason.slice(0, 2048), now);
        store.db.prepare("UPDATE swarm_recovery_attempts SET state='PREPARED',detail=?,new_run=?,retry_at=NULL,updated=? WHERE objective=? AND run=?")
          .run(proposal!.reason.slice(0, 2048), newRun, now, input.id, row.run);
        store.event("objective.recovery.prepared", { id: input.id, fromRun: row.run, toRun: newRun, revision, plan: newPlan }, row.run);
      });
      new Scheduler(store).start(proposal.tasks, source.recipe, Date.now(), newRun);
      return adoptPreparedRecovery(row, { state: "PREPARED", new_run: newRun, revision });
    } catch (e) {
      if (controller.signal.aborted) throw e;
      const current = store.db.prepare("SELECT state FROM swarm_recovery_attempts WHERE objective=? AND run=?").get(input.id, row.run);
      if (current?.state === "PREPARED") {
        store.event("objective.recovery.pending", { id: input.id, run: row.run, revision,
          detail: e instanceof Error ? e.message.slice(0, 1024) : "prepared recovery awaiting restart" }, row.run);
        throw e; // preserve PREPARED for deterministic adoption on process restart
      }
      const detail = e instanceof Error ? e.message.slice(0, 2048) : "recovery planner failed";
      if (e instanceof DeferredAttemptError) {
        const retryAt = Math.max(Date.now() + (supervision?.recoveryBackoffMs ?? 2000), e.wakeAt);
        store.db.prepare("UPDATE swarm_recovery_attempts SET state='STARTED',detail=?,retry_at=?,updated=? WHERE objective=? AND run=?")
          .run(detail, retryAt, Date.now(), input.id, row.run);
        store.event("objective.recovery.deferred",
          { id: input.id, run: row.run, revision, retryAt, detail }, row.run);
        return false;
      }
      store.db.prepare("UPDATE swarm_recovery_attempts SET state='FAILED',detail=?,retry_at=NULL,updated=? WHERE objective=? AND run=?")
        .run(detail, Date.now(), input.id, row.run);
      store.event("objective.recovery.failed", { id: input.id, run: row.run, revision, detail }, row.run);
      return false;
    }
  };
  try {
    let row = assertOwner();
    if (!row.run) {
      // A crash here can leave an unstarted orphan run, never duplicated execution.
      const run = new Scheduler(store).start(store.readArtifact(row.plan) as unknown as Task[]);
      store.transaction(() => {
        const current = assertOwner();
        store.db.prepare("UPDATE swarm_objectives SET run=? WHERE id=?").run(run, input.id);
        store.db.prepare("INSERT OR IGNORE INTO swarm_objective_revisions VALUES(?,?,?,?,?,?)")
          .run(input.id, 0, current.plan, run, "initial admitted plan", Date.now());
      });
    }
    transition("RUNNING"); report();
    for (;;) {
      controller.signal.throwIfAborted(); row = assertOwner();
      const runStatus = new Scheduler(store).status(row.run);
      if (runStatus === "RUNNING") {
        transition("RUNNING");
        await runSwarm(store, [], controller.signal, row.run, fetcher, health => {
          assertOwner();
          transition(health.waiting && !(health.counts.RUNNING ?? 0) ? "WAITING" : "RUNNING");
          report();
        });
        continue;
      }
      if (runStatus === "PASS") {
        // If final integration previously failed and recovery was merely
        // deferred, resume the durable recovery attempt instead of skipping
        // this branch forever because state is already NEEDS_ATTENTION.
        if (row.state === "NEEDS_ATTENTION" && typeof row.reason === "string" &&
            row.reason.startsWith("Final integration failed:")) {
          if (await attemptRecovery(row.reason)) { report(); continue; }
        } else {
          const preGate = objectiveEvidenceGate(store, row.run);
          if (preGate.status !== "PASS") {
            const reason = `Objective evidence gate blocked: ${preGate.verifiedTasks}/${preGate.taskCount} tasks have durable accepted evidence; ${preGate.openConflicts} unresolved evidence conflict(s). Resolve/adjudicate evidence before completion.`;
            transition("NEEDS_ATTENTION", reason);
          } else {
            transition("VERIFYING"); report();
            try {
              assertOwner(); const receipt = await integrateSwarm(store, row.run, controller.signal);
              assertOwner();
              // Re-check after integration so evidence added while expensive checks
              // were running cannot be bypassed by an earlier PASS snapshot.
              const finalGate = objectiveEvidenceGate(store, row.run);
              if (finalGate.status !== "PASS") {
                const reason = `Objective evidence gate blocked: ${finalGate.verifiedTasks}/${finalGate.taskCount} tasks have durable accepted evidence; ${finalGate.openConflicts} unresolved evidence conflict(s). Resolve/adjudicate evidence before completion.`;
                transition("NEEDS_ATTENTION", reason);
              } else {
                const integration = JSON.parse(canonical(receipt)) as Json;
                const attestation = recordObjectiveCompletion(store, input.id, assertOwner(), integration, finalGate);
                transition("COMPLETE"); report();
                return { status: "PASS", objective: objectiveStatus(store, input.id), integration,
                  completion: { attestation } };
              }
            } catch (e) {
              controller.signal.throwIfAborted();
              const reason = `Final integration failed: ${e instanceof Error ? e.message.slice(0, 800) : "unknown error"}. Inspect evidence; do not weaken the acceptance checks.`;
              transition("NEEDS_ATTENTION", reason);
              if (await attemptRecovery(reason)) { report(); continue; }
            }
          }
        }
      } else if (runStatus === "FAIL") {
        const unresolved = unresolvedRemoteJobs(row.run);
        const reason = unresolved
          ? `Remote outcome requires reconciliation for ${unresolved} job(s). Inspect/adopt/cancel those jobs before replanning; replacement runs are suppressed to avoid duplicate external work.`
          : "Repair attempts or resource bounds exhausted. Saved checkpoints and diagnostics remain available; a revised execution plan is required. Acceptance checks remain immutable.";
        transition("NEEDS_ATTENTION", reason);
        if (!unresolved && await attemptRecovery(reason)) { report(); continue; }
      }
      report();
      // No model polling and no repeated failed verification. An explicit integrate
      // command can repair the last mile; revalidate its receipt before completion.
      if (runStatus === "PASS" && store.getMeta(`extension.swarm.integration.${row.run}`)) {
        const gate = objectiveEvidenceGate(store, row.run);
        if (gate.status === "PASS") {
          const receipt = await integrateSwarm(store, row.run, controller.signal);
          const integration = JSON.parse(canonical(receipt)) as Json;
          const attestation = recordObjectiveCompletion(store, input.id, assertOwner(), integration, gate);
          transition("COMPLETE"); report();
          return { status: "PASS", objective: objectiveStatus(store, input.id), integration,
            completion: { attestation } };
        }
      }
      const reportDelay = supervision?.reportEveryMs ?? 30000;
      const retry = row.run ? store.db.prepare(
        "SELECT retry_at FROM swarm_recovery_attempts WHERE objective=? AND run=? AND state='STARTED'"
      ).get(input.id, row.run)?.retry_at : null;
      const retryDelay = retry == null ? reportDelay : Math.max(1, Number(retry) - Date.now());
      await delay(Math.min(reportDelay, retryDelay), undefined, { signal: controller.signal });
    }
  } catch (e) {
    if (signal.aborted) { transition("PAUSED", "Operator paused supervision; remote jobs are not cancelled."); report(); return { status: "PAUSED", objective: objectiveStatus(store, input.id) }; }
    // Lease loss or infrastructure failure must be nonzero for a process supervisor.
    throw e;
  } finally {
    clearInterval(pulse); signal.removeEventListener("abort", stop);
    store.db.prepare("UPDATE swarm_objectives SET owner=NULL,lease=NULL WHERE id=? AND owner=?").run(input.id, owner);
  }
}
