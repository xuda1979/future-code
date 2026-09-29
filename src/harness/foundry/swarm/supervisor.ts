import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { canonical, digest, identifier, invariant, validateTasks } from "../kernel.ts";
import { runHealth, type HealthObserver } from "../health.ts";
import { Scheduler } from "../scheduler.ts";
import type { Store } from "../store.ts";
import type { Json, Task } from "../types.ts";
import { integrateSwarm, loadSwarm, runSwarm } from "./host.ts";
import { validateSwarmTasks } from "./config.ts";
import { createApiRecoveryPlanner } from "./recovery.ts";

export interface ObjectiveInput { id: string; goal?: string; tasks?: Task[] }
export interface RecoveryContext {
  objectiveId: string; goal: string; runId: string; reason: string; revision: number;
  tasks: Task[]; failures: { id: string; status: string; error: string | null }[];
}
export interface RecoveryPlan { reason: string; tasks: Task[] }
export type RecoveryPlanner = (context: RecoveryContext, signal: AbortSignal) => Promise<RecoveryPlan | null>;
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
      state TEXT NOT NULL, detail TEXT NOT NULL, new_run TEXT, created REAL NOT NULL,
      updated REAL NOT NULL, PRIMARY KEY(objective,run));`);
}
export function objectiveStatus(store: Store, id: string): Json {
  installObjectives(store); identifier(id);
  const r = store.db.prepare("SELECT id,goal,run,state,reason,updated,lease FROM swarm_objectives WHERE id=?").get(id);
  invariant(r, "unknown objective");
  const revision = store.db.prepare("SELECT MAX(revision) AS n FROM swarm_objective_revisions WHERE objective=?").get(id)?.n ?? 0;
  const recovery = store.db.prepare("SELECT state,detail,new_run,updated FROM swarm_recovery_attempts WHERE objective=? ORDER BY revision DESC LIMIT 1").get(id);
  return { ...(r as Record<string, Json>), revision, recovery: (recovery ?? null) as Json };
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
  });
  const configuredReplans = cfg.spec.supervision?.maxReplans ?? 0;
  const planner = recoveryPlanner ?? (configuredReplans > 0 ? createApiRecoveryPlanner(store, cfg, fetcher ?? fetch) : undefined);
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
      store.db.prepare("UPDATE swarm_recovery_attempts SET state='PLANNED',detail=?,updated=? WHERE objective=? AND run=?")
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
    const maxReplans = configuredReplans;
    if (!planner || maxReplans <= 0) return false;
    if (existing && existing.state !== "STARTED") return false; // terminal planner decision is durable
    const used = store.db.prepare("SELECT COUNT(*) AS n FROM swarm_objective_revisions WHERE objective=? AND revision>0").get(input.id)!.n;
    if (!existing && used >= maxReplans) return false;
    const revision = existing ? existing.revision : used + 1;
    const tasks = store.readArtifact(row.plan) as unknown as Task[];
    const failures = store.db.prepare("SELECT id,status,error FROM tasks WHERE run=? AND status<>'PASS' ORDER BY id LIMIT 200").all(row.run)
      .map(r => ({ id: String(r.id), status: String(r.status), error: r.error == null ? null : String(r.error).slice(0, 1024) }));
    if (!existing) store.transaction(() => {
      assertOwner(); const now = Date.now();
      store.db.prepare("INSERT INTO swarm_recovery_attempts VALUES(?,?,?,?,?,NULL,?,?)")
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
        store.db.prepare("UPDATE swarm_recovery_attempts SET state='DECLINED',detail=?,updated=? WHERE objective=? AND run=?")
          .run("planner returned no safe recovery plan", Date.now(), input.id, row.run);
        return false;
      }
      invariant(typeof proposal.reason === "string" && proposal.reason.trim().length > 0 && Buffer.byteLength(proposal.reason) <= 4096, "invalid recovery reason");
      validateTasks(store.contract(), proposal.tasks); validateSwarmTasks(cfg.spec, proposal.tasks);
      invariant(digest(proposal.tasks) !== digest(tasks), "recovery plan must materially change execution structure");
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
        store.db.prepare("UPDATE swarm_recovery_attempts SET state='PREPARED',detail=?,new_run=?,updated=? WHERE objective=? AND run=?")
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
      store.db.prepare("UPDATE swarm_recovery_attempts SET state='FAILED',detail=?,updated=? WHERE objective=? AND run=?")
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
      if (runStatus === "PASS" && row.state !== "NEEDS_ATTENTION") {
        transition("VERIFYING"); report();
        try {
          assertOwner(); const receipt = await integrateSwarm(store, row.run, controller.signal);
          assertOwner(); transition("COMPLETE"); report();
          return { status: "PASS", objective: objectiveStatus(store, input.id), integration: JSON.parse(canonical(receipt)) };
        } catch (e) {
          controller.signal.throwIfAborted();
          const reason = `Final integration failed: ${e instanceof Error ? e.message.slice(0, 800) : "unknown error"}. Inspect evidence; do not weaken the acceptance checks.`;
          transition("NEEDS_ATTENTION", reason);
          if (await attemptRecovery(reason)) { report(); continue; }
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
        await integrateSwarm(store, row.run, controller.signal); transition("COMPLETE"); report();
        return { status: "PASS", objective: objectiveStatus(store, input.id) };
      }
      await delay(cfg.spec.supervision?.reportEveryMs ?? 30000, undefined, { signal: controller.signal });
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
