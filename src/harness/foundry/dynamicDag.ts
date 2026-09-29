import { canonical, digest, identifier, invariant, validateTasks } from "./kernel.ts";
import { accessConflicts, compilePlan } from "./productivity.ts";
import type { Store } from "./store.ts";
import type { Capsule, Json, SpawnPolicy, Task } from "./types.ts";

export interface SpawnResult {
  childIds: string[];
  complete: boolean;
  dependencies: { taskId: string; artifactHash: string; artifact: Json }[];
}

function within(path: string, scopes: readonly string[]): boolean {
  return scopes.some(scope => path === scope || path.startsWith(`${scope}/`));
}
function same(a: unknown, b: unknown): boolean {
  return canonical(a ?? null) === canonical(b ?? null);
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
  children: Task[], policy: SpawnPolicy, now = Date.now()): SpawnResult {
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
      return {
        childIds,
        complete,
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
      invariant(same(child.dependencies, parent.dependencies),
        "spawned child dependencies must match parent inputs");
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
    for (let i = 0; i < peers.length; i++) for (let j = i + 1; j < peers.length; j++) {
      invariant(!accessConflicts(peers[i], peers[j]),
        "spawned sibling access conflict; use a dependency or narrower scopes");
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
    store.event("task.expanded",
      { parent: c.task.id, requestKey, depth, children: ids }, c.runId, c.task.id);
    return { childIds: ids, complete: false, refs: [] as { id: string; hash: string }[] };
  });

  const dependencies = state.refs.map(ref => ({
    taskId: ref.id,
    artifactHash: ref.hash,
    artifact: store.readArtifact(ref.hash),
  }));
  return { childIds: state.childIds, complete: state.complete, dependencies };
}
