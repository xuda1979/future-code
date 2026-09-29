import { canonical, digest, identifier, invariant, validateTasks } from "./kernel.ts";
import { accessConflicts, compilePlan } from "./productivity.ts";
import { rebuildSchedulerIndex } from "./schedulerIndex.ts";
import type { Store } from "./store.ts";
import type { Capsule, Json, Measurement, SpawnPolicy, Task } from "./types.ts";

export interface SpawnResult {
  childIds: string[];
  complete: boolean;
  parentDeferred?: boolean;
  dependencies: { taskId: string; artifactHash: string; artifact: Json }[];
}
export interface SpawnYield {
  reason: string;
  wakeAt: number;
  measurement: Measurement;
}

function within(path: string, scopes: readonly string[]): boolean {
  return scopes.some(scope => path === scope || path.startsWith(`${scope}/`));
}
function same(a: unknown, b: unknown): boolean {
  return canonical(a ?? null) === canonical(b ?? null);
}
function dependencyOrders(a: Task, b: Task, byId: Map<string, Task>): boolean {
  const reaches = (from: Task, target: string): boolean => {
    const todo = [...from.dependencies]; const seen = new Set<string>();
    for (let i = 0; i < todo.length; i++) {
      const id = todo[i]!; if (id === target) return true;
      if (seen.has(id)) continue; seen.add(id);
      const dependency = byId.get(id); if (dependency) todo.push(...dependency.dependencies);
    }
    return false;
  };
  return reaches(a, b.id) || reaches(b, a.id);
}

function validatePolicy(store: Store, policy: SpawnPolicy): void {
  const limit = store.contract().limits.tasks;
  invariant(Number.isSafeInteger(policy.maxChildrenPerTask) && policy.maxChildrenPerTask > 0 &&
    policy.maxChildrenPerTask <= 32, "invalid dynamic child limit");
  invariant(Number.isSafeInteger(policy.maxDepth) && policy.maxDepth > 0 && policy.maxDepth <= 32,
    "invalid dynamic depth limit");
  invariant(Number.isSafeInteger(policy.maxSpawnedTasks) && policy.maxSpawnedTasks > 0 &&
    policy.maxSpawnedTasks <= limit, "invalid dynamic task limit");
}

/** Admit one provider-requested child batch without giving the provider scheduler authority.
 * The parent task specification stays immutable so durable model-thread bindings survive
 * deferral/restart. Runtime edges are host-owned and independently verified. */
export function spawnTasks(store: Store, c: Capsule, requestKey: string, requestHash: string,
  children: Task[], policy: SpawnPolicy, now = Date.now(), yieldParent?: SpawnYield): SpawnResult {
  validatePolicy(store, policy);
  invariant(typeof requestKey === "string" && requestKey.length > 0 && requestKey.length <= 256,
    "invalid spawn request key");
  invariant(/^[a-f0-9]{64}$/.test(requestHash), "invalid spawn request hash");

  const state = store.transaction(() => {
    const run = store.db.prepare("SELECT recipe,contract,status FROM runs WHERE id=?").get(c.runId);
    const parentRow = store.db.prepare("SELECT spec,status,fence,deadline FROM tasks WHERE run=? AND id=?")
      .get(c.runId, c.task.id);
    invariant(run?.status === "RUNNING" && run.recipe === c.recipeHash && run.contract === c.contractHash &&
      parentRow?.status === "RUNNING" && parentRow.fence === c.fence && parentRow.deadline > now,
      "stale spawn authority");
    const parent = JSON.parse(parentRow.spec) as Task;
    invariant(digest(parent) === digest(c.task), "spawn parent binding drift");
    const deferParent = () => {
      if (!yieldParent) return false;
      invariant(Number.isSafeInteger(yieldParent.wakeAt) && yieldParent.wakeAt >= 0, "invalid spawn wake time");
      invariant(typeof yieldParent.reason === "string" && yieldParent.reason.length > 0, "invalid spawn deferral reason");
      const a = store.db.prepare("SELECT started,status FROM attempts WHERE run=? AND task=? AND fence=?")
        .get(c.runId, c.task.id, c.fence);
      invariant(a?.status === "RUNNING", "spawn parent attempt is not running");
      const wake = Math.max(now, yieldParent.wakeAt);
      store.db.prepare(`UPDATE attempts SET status='DEFERRED',ended=?,duration=?,tokens=?,cost=?
        WHERE run=? AND task=? AND fence=? AND status='RUNNING'`)
        .run(now, Math.max(0, now - a.started), yieldParent.measurement.tokens,
          yieldParent.measurement.costUsd, c.runId, c.task.id, c.fence);
      store.db.prepare("UPDATE tasks SET status='READY',owner=NULL,deadline=NULL,error=? WHERE run=? AND id=? AND fence=?")
        .run(yieldParent.reason.slice(0, 1024), c.runId, c.task.id, c.fence);
      store.db.prepare(`INSERT INTO task_waits(run,task,wake,kind,reason) VALUES(?,?,?,?,?)
        ON CONFLICT(run,task) DO UPDATE SET wake=excluded.wake,kind=excluded.kind,reason=excluded.reason`)
        .run(c.runId, c.task.id, wake, "spawn", yieldParent.reason.slice(0, 1024));
      store.event("task.deferred", { fence: c.fence, wakeAt: wake, kind: "spawn",
        reason: yieldParent.reason.slice(0, 1024), atomicWithSpawn: true }, c.runId, c.task.id);
      return true;
    };

    const existing = store.db.prepare(
      "SELECT request_hash,children FROM spawn_requests WHERE run=? AND parent=? AND request_key=?"
    ).get(c.runId, c.task.id, requestKey);
    if (existing) {
      invariant(existing.request_hash === requestHash, "spawn request drift");
      const childIds = JSON.parse(existing.children) as string[];
      invariant(Array.isArray(childIds) && childIds.every(id => typeof id === "string"),
        "corrupt spawn request");
      const rows = childIds.map(id =>
        store.db.prepare("SELECT status,artifact FROM tasks WHERE run=? AND id=?").get(c.runId, id));
      const complete = rows.every(row => row?.status === "PASS" && typeof row.artifact === "string");
      const parentDeferred = !complete ? deferParent() : false;
      return {
        childIds,
        complete,
        parentDeferred,
        refs: complete ? rows.map((row, i) => ({ id: childIds[i], hash: row!.artifact as string })) : [],
      };
    }

    invariant(Array.isArray(children) && children.length > 0 &&
      children.length <= policy.maxChildrenPerTask, "spawn child batch exceeds limit");
    const parentEdge = store.db.prepare("SELECT depth FROM spawn_edges WHERE run=? AND child=?")
      .get(c.runId, c.task.id);
    const depth = (parentEdge?.depth ?? 0) + 1;
    invariant(depth <= policy.maxDepth, "spawn depth exceeds limit");

    const priorEdges = store.db.prepare(
      "SELECT child FROM spawn_edges WHERE run=? AND parent=? ORDER BY child"
    ).all(c.runId, c.task.id);
    invariant(priorEdges.length + children.length <= policy.maxChildrenPerTask,
      "parent dynamic child limit exceeded");
    const totalSpawned = store.db.prepare("SELECT COUNT(*) AS n FROM spawn_edges WHERE run=?")
      .get(c.runId)!.n as number;
    invariant(totalSpawned + children.length <= policy.maxSpawnedTasks,
      "run dynamic task limit exceeded");
    const totalTasks = store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE run=?")
      .get(c.runId)!.n as number;
    invariant(totalTasks + children.length <= store.contract().limits.tasks,
      "contract task limit exceeded");

    const readable = [...parent.writeScope, ...(parent.readScope ?? [])];
    const childIds = new Set<string>();
    for (const child of children) {
      identifier(child.id);
      invariant(child.id.startsWith(`${parent.id}.`) && child.id.length > parent.id.length + 1,
        "spawned child id must be parent-namespaced");
      invariant(!childIds.has(child.id), "duplicate spawned child id");
      childIds.add(child.id);
      invariant(!store.db.prepare("SELECT 1 FROM tasks WHERE run=? AND id=?")
        .get(c.runId, child.id), "spawned child id already exists");
    }
    for (const child of children) {
      const inherited = child.dependencies.filter(id => parent.dependencies.includes(id));
      const siblingDependencies = child.dependencies.filter(id => !parent.dependencies.includes(id));
      invariant(same(inherited, parent.dependencies),
        "spawned child must preserve parent dependencies");
      invariant(siblingDependencies.every(id => childIds.has(id) && id !== child.id),
        "spawned child dependency must name a sibling in this batch");
      invariant(same(child.dependencyViews, parent.dependencyViews),
        "spawned child dependency views must match parent inputs");
      for (const path of child.writeScope)
        invariant(within(path, parent.writeScope),
          "spawned child write scope exceeds parent authority");
      for (const path of child.readScope ?? [])
        invariant(within(path, readable),
          "spawned child read scope exceeds parent authority");
    }

    const priorTasks = priorEdges.map(edge => {
      const row = store.db.prepare("SELECT spec FROM tasks WHERE run=? AND id=?")
        .get(c.runId, edge.child);
      invariant(row?.spec, "missing prior spawned child");
      return JSON.parse(row.spec) as Task;
    });
    const peers = [...priorTasks, ...children];
    const peerById = new Map(peers.map(task => [task.id, task]));
    for (let i = 0; i < peers.length; i++) for (let j = i + 1; j < peers.length; j++) {
      invariant(!accessConflicts(peers[i], peers[j]) || dependencyOrders(peers[i], peers[j], peerById),
        "spawned sibling access conflict; order conflicting work with dependsOn or use narrower scopes");
    }

    const graph: Task[] = store.db.prepare("SELECT spec FROM tasks WHERE run=?")
      .all(c.runId).map(row => JSON.parse(row.spec));
    graph.push(...children);
    validateTasks(store.contract(), graph);
    compilePlan(graph, store.recipe(c.recipeHash), store.contract().limits.contextBytes);

    const insert = store.db.prepare("INSERT INTO tasks(run,id,spec,status) VALUES(?,?,?,'READY')");
    for (const child of children) insert.run(c.runId, child.id, canonical(child));
    const ids = children.map(child => child.id);
    store.db.prepare("INSERT INTO spawn_requests VALUES(?,?,?,?,?,?,?)")
      .run(c.runId, c.task.id, requestKey, requestHash, canonical(ids), depth, now);
    const edgeInsert = store.db.prepare("INSERT INTO spawn_edges VALUES(?,?,?,?,?,?)");
    for (const child of children)
      edgeInsert.run(c.runId, c.task.id, child.id, requestKey, depth, now);
    store.db.prepare("UPDATE runs SET graph_version=graph_version+1 WHERE id=?").run(c.runId);
    // Dynamic expansion is the uncommon structural operation. Pay O(V+E) here
    // once so subsequent claims remain bounded to ready/running work.
    rebuildSchedulerIndex(store, c.runId, store.recipe(c.recipeHash), now);
    store.event("task.expanded",
      { parent: c.task.id, requestKey, depth, children: ids }, c.runId, c.task.id);
    const parentDeferred = deferParent();
    return { childIds: ids, complete: false, parentDeferred,
      refs: [] as { id: string; hash: string }[] };
  });

  const dependencies = state.refs.map(ref => ({
    taskId: ref.id,
    artifactHash: ref.hash,
    artifact: store.readArtifact(ref.hash),
  }));
  return { childIds: state.childIds, complete: state.complete,
    parentDeferred: state.parentDeferred, dependencies };
}
