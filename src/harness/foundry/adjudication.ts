import { canonical, digest, invariant, validateEvidence, validateTasks } from "./kernel.ts";
import { compilePlan } from "./productivity.ts";
import { rebuildSchedulerIndex } from "./schedulerIndex.ts";
import { registerTaskGoals, refreshRunAllocations } from "./evidenceFabric.ts";
import type { Store } from "./store.ts";
import type { Json, Task } from "./types.ts";

export interface AdjudicationRecord {
  id: string; run: string; subject: string; task: string; evidenceId: string; artifactHash: string; created: number;
}

/** Explicit HOST action: admit a read-only discriminator into the authoritative
 * task DAG, even after task execution passed. No existing task/acceptance is
 * rewritten and no prior external job is relaunched. */
export function admitAdjudicationTask(store: Store, run: string, parent: string,
  subject: string, task: Task, now = Date.now()): string {
  invariant(task.writeScope.length === 0, "adjudication task must be read-only");
  const requestKey = `adjudication:${digest(subject)}`, requestHash = digest(task);
  return store.transaction(() => {
    const execution = store.db.prepare("SELECT recipe,contract FROM runs WHERE id=?").get(run);
    invariant(execution?.contract === digest(store.contract()), "adjudication run binding mismatch");
    const parentRow = store.db.prepare("SELECT spec FROM tasks WHERE run=? AND id=?").get(run, parent);
    invariant(parentRow, "unknown adjudication parent");
    const original: Task = JSON.parse(parentRow.spec);
    const readable = [...original.writeScope, ...(original.readScope ?? [])];
    invariant((task.readScope ?? []).every(path => readable.some(scope => path === scope || path.startsWith(`${scope}/`))),
      "adjudication widens read authority");
    const replay = store.db.prepare("SELECT request_hash,children FROM spawn_requests WHERE run=? AND parent=? AND request_key=?")
      .get(run, parent, requestKey);
    if (replay) { invariant(replay.request_hash === requestHash, "adjudication replay drift"); return JSON.parse(replay.children)[0]; }
    invariant(!store.db.prepare("SELECT 1 FROM tasks WHERE run=? AND id=?").get(run, task.id), "adjudication task id collision");
    const tasks = store.db.prepare("SELECT spec FROM tasks WHERE run=? ORDER BY id").all(run).map(row => JSON.parse(row.spec));
    validateTasks(store.contract(), [...tasks, task]);
    // Spawn edges impose child-before-parent ordering. Never depend on the
    // parent itself or one of its descendants and create a hidden cycle.
    const existingEdges = store.db.prepare("SELECT parent,child FROM spawn_edges WHERE run=?").all(run);
    const children = new Map<string, string[]>();
    for (const edge of [...existingEdges, { parent, child: task.id }]) {
      const ids = children.get(String(edge.parent)) ?? []; ids.push(String(edge.child)); children.set(String(edge.parent), ids);
    }
    const runtimeGraph = [...tasks, task].map(value => ({ ...value,
      dependencies: [...new Set([...value.dependencies, ...(children.get(value.id) ?? [])])] }));
    validateTasks(store.contract(), runtimeGraph);
    compilePlan(runtimeGraph, store.recipe(String(execution.recipe)), store.contract().limits.contextBytes);
    const depth = Number(store.db.prepare("SELECT depth FROM spawn_edges WHERE run=? AND child=?").get(run, parent)?.depth ?? 0) + 1;
    store.db.prepare("INSERT INTO tasks(run,id,spec,status) VALUES(?,?,?,'READY')").run(run, task.id, canonical(task));
    store.db.prepare("INSERT INTO spawn_edges VALUES(?,?,?,?,?,?)").run(run, parent, task.id, requestKey, depth, now);
    store.db.prepare("INSERT INTO spawn_requests VALUES(?,?,?,?,?,?,?)")
      .run(run, parent, requestKey, requestHash, canonical([task.id]), depth, now);
    store.db.prepare("UPDATE runs SET status='RUNNING',ended=NULL,graph_version=graph_version+1 WHERE id=?").run(run);
    rebuildSchedulerIndex(store, run, store.recipe(String(execution.recipe)), now);
    registerTaskGoals(store, run, [task], parent, undefined, now); refreshRunAllocations(store, run, now);
    store.event("fabric.adjudication.admitted", { subject, task: task.id, parent, requestHash }, run, task.id);
    return task.id;
  });
}
/** Read an accepted discriminator, not an LLM verdict or a free-form fabric row. */
export function acceptedDiscriminator(store: Store, run: string, evidenceId: string): {
  task: Task; artifact: any; artifactHash: string; evidenceHash: string; checks: { id: string; verdict: string }[];
} {
  const evidence = store.db.prepare("SELECT * FROM fabric_evidence WHERE id=?").get(evidenceId);
  invariant(evidence?.run === run && evidence.source === "foundry-independent-verifier" &&
    evidence.kind === "independent-verification" && evidence.verdict === "PASS" && evidence.strength === 1,
    "adjudication requires independent machine evidence");
  const task = store.db.prepare("SELECT spec,status,artifact,evidence FROM tasks WHERE run=? AND id=?").get(run, evidence.task);
  const execution = store.db.prepare("SELECT recipe,contract FROM runs WHERE id=?").get(run);
  invariant(task?.status === "PASS" && task.artifact === evidence.artifact_hash &&
    task.evidence === evidence.evidence_hash && execution?.contract === digest(store.contract()),
    "adjudication acceptance binding mismatch");
  const artifact = store.readArtifact(task.artifact);
  const receipt: any = store.readArtifact(task.evidence);
  validateEvidence(store.contract(), execution.recipe, JSON.parse(task.spec), artifact, receipt);
  return { task: JSON.parse(task.spec), artifact, artifactHash: task.artifact, evidenceHash: task.evidence,
    checks: receipt.verification.checks };
}

export function recordAdjudication(store: Store, run: string, subject: string,
  evidenceId: string, discriminator: ReturnType<typeof acceptedDiscriminator>, now: number): string {
  const id = digest({ run, subject, evidenceId, artifactHash: discriminator.artifactHash });
  store.db.prepare("INSERT OR IGNORE INTO fabric_adjudications VALUES(?,?,?,?,?,?,?)")
    .run(id, run, subject, discriminator.task.id, evidenceId, discriminator.artifactHash, now);
  store.event("fabric.adjudication.accepted", JSON.parse(canonical({ id, subject, evidenceId })), run);
  return id;
}
