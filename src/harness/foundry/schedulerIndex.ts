import { canonical, digest, invariant } from "./kernel.ts";
import { compilePlan } from "./productivity.ts";
import type { Store } from "./store.ts";
import type { Recipe, Task } from "./types.ts";

export interface SchedulerIndexStats {
  indexedTasks: number; edges: number; runnable: number; dependencyBlocked: number;
  delayed: number; rebuilds: number; builtAt: number; sourceHash: string;
}

function source(store: Store, runId: string) {
  const rows = store.db.prepare("SELECT id,spec,status FROM tasks WHERE run=? ORDER BY id").all(runId);
  invariant(rows.length > 0, "cannot index an empty or unknown run");
  const tasks = rows.map(row => JSON.parse(row.spec) as Task);
  const status = new Map(rows.map(row => [String(row.id), String(row.status)]));
  const spawnRows = store.db.prepare(
    "SELECT parent,child,request_key,depth FROM spawn_edges WHERE run=? ORDER BY parent,child"
  ).all(runId);
  const spawned = new Map<string, string[]>();
  for (const edge of spawnRows) {
    const parent = String(edge.parent); const child = String(edge.child);
    const list = spawned.get(parent) ?? []; list.push(child); spawned.set(parent, list);
  }
  const runtime = tasks.map(task => {
    const extra = spawned.get(task.id) ?? [];
    return extra.length ? { ...task, dependencies: [...new Set([...task.dependencies, ...extra])] } : task;
  });
  const edges: { prerequisite: string; dependent: string; kind: "static" | "spawn" }[] = [];
  for (const task of tasks) for (const dependency of task.dependencies)
    edges.push({ prerequisite: dependency, dependent: task.id, kind: "static" });
  for (const edge of spawnRows)
    edges.push({ prerequisite: String(edge.child), dependent: String(edge.parent), kind: "spawn" });
  const sourceHash = digest({
    tasks: rows.map(row => ({ id: String(row.id), spec: JSON.parse(row.spec) })),
    spawnEdges: spawnRows.map(edge => ({
      parent: String(edge.parent), child: String(edge.child),
      requestKey: String(edge.request_key), depth: Number(edge.depth),
    })),
  });
  return { status, runtime, edges, sourceHash };
}

export function rebuildSchedulerIndex(store: Store, runId: string, recipe: Recipe,
  now = Date.now()): void {
  const { status, runtime, edges, sourceHash } = source(store, runId);
  const plan = compilePlan(runtime, recipe, store.contract().limits.contextBytes);
  const previous = store.db.prepare("SELECT rebuilds FROM scheduler_index_meta WHERE run=?").get(runId);
  store.db.prepare("DELETE FROM scheduler_edges WHERE run=?").run(runId);
  store.db.prepare("DELETE FROM scheduler_nodes WHERE run=?").run(runId);
  const edgeInsert = store.db.prepare(
    "INSERT INTO scheduler_edges(run,prerequisite,dependent,kind) VALUES(?,?,?,?)"
  );
  for (const edge of edges) edgeInsert.run(runId, edge.prerequisite, edge.dependent, edge.kind);
  const prerequisites = new Map<string, string[]>();
  for (const edge of edges) {
    const list = prerequisites.get(edge.dependent) ?? [];
    if (!list.includes(edge.prerequisite)) list.push(edge.prerequisite);
    prerequisites.set(edge.dependent, list);
  }
  const nodeInsert = store.db.prepare(
    "INSERT INTO scheduler_nodes(run,task,remaining,priority,rank,budget) VALUES(?,?,?,?,?,?)"
  );
  for (const task of runtime) {
    const remaining = (prerequisites.get(task.id) ?? []).filter(id => status.get(id) !== "PASS").length;
    nodeInsert.run(runId, task.id, remaining, task.priority ?? 0,
      plan.ranks.get(task.id) ?? 0, plan.budgets.get(task.id)!);
  }
  store.db.prepare(`INSERT INTO scheduler_index_meta(run,task_count,edge_count,rebuilds,built_at,source_hash)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(run) DO UPDATE SET task_count=excluded.task_count,edge_count=excluded.edge_count,
      rebuilds=excluded.rebuilds,built_at=excluded.built_at,source_hash=excluded.source_hash`)
    .run(runId, runtime.length, edges.length, (previous?.rebuilds ?? 0) + 1, now, sourceHash);
  store.event("scheduler.index.rebuilt",
    { tasks: runtime.length, edges: edges.length, rebuild: (previous?.rebuilds ?? 0) + 1, sourceHash },
    runId);
}

export function schedulerIndexCurrent(store: Store, runId: string): boolean {
  const meta = store.db.prepare("SELECT source_hash FROM scheduler_index_meta WHERE run=?").get(runId);
  if (!meta?.source_hash) return false;
  return String(meta.source_hash) === source(store, runId).sourceHash;
}

export function ensureSchedulerIndex(store: Store, runId: string, recipe: Recipe, now = Date.now()): void {
  const meta = store.db.prepare("SELECT source_hash FROM scheduler_index_meta WHERE run=?").get(runId);
  if (!meta?.source_hash) {
    rebuildSchedulerIndex(store, runId, recipe, now); return;
  }
  const actual = source(store, runId).sourceHash;
  if (String(meta.source_hash) !== actual) {
    store.event("scheduler.index.drift", { expected: String(meta.source_hash), actual }, runId);
    rebuildSchedulerIndex(store, runId, recipe, now);
  }
}

export function releaseDependents(store: Store, runId: string, prerequisite: string): void {
  store.db.prepare(`UPDATE scheduler_nodes SET remaining=CASE WHEN remaining>0 THEN remaining-1 ELSE 0 END
    WHERE run=? AND task IN (SELECT dependent FROM scheduler_edges WHERE run=? AND prerequisite=?)`)
    .run(runId, runId, prerequisite);
}

export function blockDependents(store: Store, runId: string, prerequisite: string,
  reason = "dependency failed"): void {
  const queue = [prerequisite]; const seen = new Set<string>();
  while (queue.length) {
    const failed = queue.shift()!; if (seen.has(failed)) continue; seen.add(failed);
    for (const edge of store.db.prepare(
      "SELECT dependent,kind FROM scheduler_edges WHERE run=? AND prerequisite=?"
    ).all(runId, failed)) {
      const id = String(edge.dependent);
      const row = store.db.prepare("SELECT status FROM tasks WHERE run=? AND id=?").get(runId, id);
      if (!row || row.status !== "READY") {
        if (row?.status === "RUNNING") store.event("task.dependency_failed_while_running",
          { prerequisite: failed, kind: edge.kind }, runId, id);
        continue;
      }
      const detail = edge.kind === "spawn" ? "spawned child failed" : reason;
      store.db.prepare("UPDATE tasks SET status='BLOCKED',error=? WHERE run=? AND id=?")
        .run(detail, runId, id);
      store.event("task.blocked", { reason: detail, prerequisite: failed }, runId, id);
      queue.push(id);
    }
  }
}

export function schedulerNode(store: Store, runId: string, task: string):
  { remaining: number; priority: number; rank: number; budget: number } | null {
  const row = store.db.prepare(
    "SELECT remaining,priority,rank,budget FROM scheduler_nodes WHERE run=? AND task=?"
  ).get(runId, task);
  return row ? { remaining: Number(row.remaining), priority: Number(row.priority),
    rank: Number(row.rank), budget: Number(row.budget) } : null;
}

export function readyCandidates(store: Store, runId: string, now: number, limit: number):
  { id: string; spec: string; fence: number; priority: number; rank: number; budget: number }[] {
  invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 4096, "invalid candidate window");
  return store.db.prepare(`SELECT t.id,t.spec,t.fence,n.priority,n.rank,n.budget
    FROM scheduler_nodes n JOIN tasks t ON t.run=n.run AND t.id=n.task
    LEFT JOIN task_waits w ON w.run=t.run AND w.task=t.id
    WHERE n.run=? AND n.remaining=0 AND t.status='READY' AND (w.wake IS NULL OR w.wake<=?)
    ORDER BY n.priority DESC,n.rank DESC,t.id LIMIT ?`).all(runId, now, limit)
    .map(row => ({ id: String(row.id), spec: String(row.spec), fence: Number(row.fence),
      priority: Number(row.priority), rank: Number(row.rank), budget: Number(row.budget) }));
}

export function schedulerIndexStats(store: Store, runId: string, now = Date.now()): SchedulerIndexStats | null {
  const meta = store.db.prepare(
    "SELECT task_count,edge_count,rebuilds,built_at,source_hash FROM scheduler_index_meta WHERE run=?"
  ).get(runId);
  if (!meta) return null;
  const runnable = store.db.prepare(`SELECT COUNT(*) AS n FROM scheduler_nodes n
    JOIN tasks t ON t.run=n.run AND t.id=n.task
    LEFT JOIN task_waits w ON w.run=t.run AND w.task=t.id
    WHERE n.run=? AND n.remaining=0 AND t.status='READY' AND (w.wake IS NULL OR w.wake<=?)`)
    .get(runId, now)!.n;
  const dependencyBlocked = store.db.prepare(`SELECT COUNT(*) AS n FROM scheduler_nodes n
    JOIN tasks t ON t.run=n.run AND t.id=n.task
    WHERE n.run=? AND n.remaining>0 AND t.status='READY'`).get(runId)!.n;
  const delayed = store.db.prepare(`SELECT COUNT(*) AS n FROM task_waits w
    JOIN tasks t ON t.run=w.run AND t.id=w.task
    WHERE w.run=? AND t.status='READY' AND w.wake>?`).get(runId, now)!.n;
  return { indexedTasks: Number(meta.task_count), edges: Number(meta.edge_count),
    runnable: Number(runnable), dependencyBlocked: Number(dependencyBlocked), delayed: Number(delayed),
    rebuilds: Number(meta.rebuilds), builtAt: Number(meta.built_at), sourceHash: String(meta.source_hash ?? "") };
}
