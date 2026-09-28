import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { canonical, digest, identifier, invariant, validateTasks } from "../kernel.ts";
import { runHealth, type HealthObserver } from "../health.ts";
import { Scheduler } from "../scheduler.ts";
import type { Store } from "../store.ts";
import type { Json, Task } from "../types.ts";
import { integrateSwarm, loadSwarm, runSwarm } from "./host.ts";
import { validateSwarmTasks } from "./config.ts";

export interface ObjectiveInput { id: string; goal?: string; tasks?: Task[] }
export function installObjectives(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS swarm_objectives(
    id TEXT PRIMARY KEY, goal TEXT NOT NULL, plan TEXT NOT NULL, cfg TEXT NOT NULL,
    run TEXT UNIQUE, state TEXT NOT NULL, reason TEXT, owner TEXT, lease REAL,
    updated REAL NOT NULL);`);
}
export function objectiveStatus(store: Store, id: string): Json {
  installObjectives(store); identifier(id);
  const r = store.db.prepare("SELECT id,goal,run,state,reason,updated,lease FROM swarm_objectives WHERE id=?").get(id);
  invariant(r, "unknown objective"); return r as Json;
}

/** Persistent, single-host objective control on the SAME Foundry scheduler.
 * It never turns a turn-end or a failed run into objective completion. Recoverable
 * work resumes in runTasks; exhausted budgets or unsafe outcomes remain visible
 * NEEDS_ATTENTION instead of silently exiting or resetting resource ceilings. */
export async function superviseSwarm(store: Store, input: ObjectiveInput, signal: AbortSignal,
  onProgress?: HealthObserver, fetcher?: typeof fetch): Promise<Json> {
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
  try {
    let row = assertOwner();
    if (!row.run) {
      // A crash here can leave an unstarted orphan run, never duplicated execution.
      const run = new Scheduler(store).start(store.readArtifact(row.plan) as unknown as Task[]);
      store.transaction(() => { assertOwner(); store.db.prepare("UPDATE swarm_objectives SET run=? WHERE id=?").run(run, input.id); });
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
          transition("NEEDS_ATTENTION", `Final integration failed: ${e instanceof Error ? e.message.slice(0, 800) : "unknown error"}. Inspect evidence; do not weaken the acceptance checks.`);
        }
      } else if (runStatus === "FAIL") {
        transition("NEEDS_ATTENTION", "Repair attempts or resource bounds exhausted. Saved checkpoints and diagnostics remain available; a revised authorized plan/configuration is required. No blind retries or budget reset.");
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
