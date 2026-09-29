import { DeferredAttemptError } from "../continuation.ts";
import { FatalAttemptError } from "../errors.ts";
import { canonical, identifier, invariant } from "../kernel.ts";
import { Scheduler } from "../scheduler.ts";
import type { Capsule, Json, Task } from "../types.ts";
import type { Call } from "./context.ts";
import type { PinnedSwarm, AgentProfile } from "./config.ts";
import { validateSwarmTasks } from "./config.ts";
import type { Store } from "../store.ts";

const json = (value: unknown): Json => JSON.parse(canonical(value));

/** Durable, bounded dynamic delegation. The model proposes tasks; the host
 * validates authority, lineage, depth and graph safety before admission. */
export class DynamicDelegation {
  readonly store: Store;
  readonly cfg: PinnedSwarm;
  constructor(store: Store, cfg: PinnedSwarm) {
    this.store = store; this.cfg = cfg;
    store.db.exec(`CREATE TABLE IF NOT EXISTS task_expansions(
      run TEXT NOT NULL,parent TEXT NOT NULL,proposal TEXT NOT NULL,task TEXT NOT NULL,
      spec_hash TEXT NOT NULL,created REAL NOT NULL,PRIMARY KEY(run,parent,proposal,task));
      CREATE INDEX IF NOT EXISTS task_expansions_run ON task_expansions(run,parent);
      CREATE INDEX IF NOT EXISTS task_expansions_child ON task_expansions(run,task);`);
  }
  private depth(run: string, task: string): number {
    let depth = 0; let current = task; const seen = new Set<string>();
    for (;;) {
      invariant(!seen.has(current), "delegation lineage cycle"); seen.add(current);
      const row = this.store.db.prepare("SELECT parent FROM task_expansions WHERE run=? AND task=? ORDER BY created LIMIT 1").get(run, current);
      if (!row) return depth;
      current = String(row.parent); depth++;
      invariant(depth <= 64, "delegation lineage overflow");
    }
  }
  spawn(c: Capsule, profile: AgentProfile, call: Call): Json {
    invariant(profile.tools.includes("spawn_tasks"), "delegation capability denied");
    const policy = this.cfg.spec.delegation; invariant(policy, "delegation is not configured");
    const raw = call.arguments.tasks;
    invariant(Array.isArray(raw) && raw.length > 0 && raw.length <= policy.maxChildrenPerExpansion, "invalid child task batch");
    invariant(this.depth(c.runId, c.task.id) < policy.maxDepth, "delegation depth exhausted");
    const existingChildren = this.store.db.prepare("SELECT COUNT(DISTINCT task) AS n FROM task_expansions WHERE run=? AND parent=?").get(c.runId, c.task.id)!.n;
    invariant(existingChildren + raw.length <= policy.maxChildrenPerTask, "delegation child budget exhausted");
    const tasks: Task[] = raw.map((value: any) => {
      invariant(value && typeof value === "object" && !Array.isArray(value), "invalid spawned task");
      const task: Task = {
        ...value,
        agent: value.agent ?? c.task.agent ?? this.cfg.spec.defaultAgent,
        dependencies: value.dependencies ?? [],
        input: Object.hasOwn(value, "input") ? value.input : null,
      };
      identifier(task.id);
      return json(task) as unknown as Task;
    });
    validateSwarmTasks(this.cfg.spec, tasks);
    const result = new Scheduler(this.store).expand(c.runId, c.task.id, tasks, call.id);
    return json({ proposalId: call.id, ...result, children: tasks.map(t => t.id) });
  }
  await(c: Capsule, profile: AgentProfile, call: Call): Json {
    invariant(profile.tools.includes("await_tasks"), "delegation capability denied");
    const raw = call.arguments.ids;
    invariant(Array.isArray(raw) && raw.length > 0 && raw.length <= 256 &&
      raw.every(id => typeof id === "string"), "invalid awaited child ids");
    const ids = [...new Set(raw as string[])]; invariant(ids.length === raw.length, "duplicate awaited child id");
    const items: Json[] = [];
    for (const id of ids) {
      const lineage = this.store.db.prepare("SELECT 1 FROM task_expansions WHERE run=? AND parent=? AND task=? LIMIT 1").get(c.runId, c.task.id, id);
      invariant(lineage, "may only await direct spawned children");
      const row = this.store.db.prepare("SELECT status,artifact,evidence,error FROM tasks WHERE run=? AND id=?").get(c.runId, id);
      invariant(row, "spawned child disappeared");
      if (row.status === "FAIL" || row.status === "BLOCKED") {
        throw new FatalAttemptError(`SUBAGENT_FAILED: ${id}: ${String(row.error ?? row.status).slice(0, 512)}`);
      }
      if (row.status !== "PASS") {
        throw new DeferredAttemptError("subagents", Date.now() + 250, `Waiting for spawned child ${id} (${row.status})`);
      }
      invariant(row.artifact && row.evidence, "accepted child missing evidence");
      items.push({ id, artifactHash: row.artifact, evidenceHash: row.evidence, artifact: this.store.readArtifact(row.artifact) });
    }
    return json({ complete: true, children: items });
  }
}
