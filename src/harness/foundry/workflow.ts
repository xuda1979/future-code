import { canonical, digest, invariant } from "./kernel.ts";
import { expandUnstartedTaskInTransaction } from "./dynamicDag.ts";
import { decideProposal, submitProposal, type Admission } from "./proposals.ts";
import type { Store } from "./store.ts";
import type { Json, SpawnPolicy, Task } from "./types.ts";

export const WORKFLOW_OPERATIONS = ["expand_task", "set_task_timeout", "set_parallelism"] as const;
export type WorkflowOperation =
  | { op: "expand_task"; taskId: string; children: Json[] }
  | { op: "set_task_timeout"; taskId: string; timeoutMs: number }
  | { op: "set_parallelism"; parallelism: number };
export interface WorkflowProposal {
  schema: 1;
  expectedGraphVersion: number;
  expectedPolicyVersion: number;
  expectedStateVersion: number;
  reason: string;
  operations: WorkflowOperation[];
}
export interface WorkflowBounds {
  maxReviews: number;
  maxOperations: number;
  maxTaskTimeoutMs: number;
  allowedOperations: (typeof WORKFLOW_OPERATIONS[number])[];
  spawn?: SpawnPolicy;
}
export interface WorkflowReceipt extends Admission {
  changed: boolean;
  graphVersion: number;
  policyVersion: number;
  stateHash: string;
  snapshotHash: string | null;
  childIds: string[];
}
export interface WorkflowAuthority {
  /** Supplied from the host's saved input, never copied from the model reply. */
  observed?: { graphVersion: number; policyVersion: number; stateVersion: number };
  assertCurrent?: () => void;
}

export function installWorkflowTables(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS workflow_run_policy(
      run TEXT PRIMARY KEY, revision INTEGER NOT NULL, parallelism INTEGER);
    CREATE TABLE IF NOT EXISTS workflow_task_policy(
      run TEXT NOT NULL, task TEXT NOT NULL, timeout_ms INTEGER NOT NULL, PRIMARY KEY(run,task));
    CREATE TABLE IF NOT EXISTS workflow_commits(
      run TEXT NOT NULL, request_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
      receipt_hash TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(run,request_key));
    CREATE INDEX IF NOT EXISTS events_workflow_state ON events(run,kind,seq);`);
  for (const op of ["UPDATE", "DELETE"]) store.db.exec(`
    CREATE TRIGGER IF NOT EXISTS workflow_commits_immutable_${op.toLowerCase()}
      BEFORE ${op} ON workflow_commits BEGIN SELECT RAISE(ABORT,'append-only workflow commits'); END;`);
}

/** Only host state transitions trigger another review; model/tool chatter and
 * policy request accounting cannot cause a self-sustaining review loop. */
export function workflowStateVersion(store: Store, run: string): number {
  let version = 0;
  for (const kind of ["run.started", "run.finished", "task.claimed", "task.accepted", "task.failed",
    "task.deferred", "lease.expired", "task.expanded", "workflow.changed"]) {
    const row = store.db.prepare("SELECT seq FROM events WHERE run=? AND kind=? ORDER BY seq DESC LIMIT 1").get(run, kind);
    version = Math.max(version, Number(row?.seq ?? 0));
  }
  return version;
}

export function workflowVersions(store: Store, run: string) {
  const row = store.db.prepare("SELECT graph_version,status,recipe FROM runs WHERE id=?").get(run);
  invariant(row, "unknown workflow run");
  const policy = store.db.prepare("SELECT revision,parallelism FROM workflow_run_policy WHERE run=?").get(run);
  return { graphVersion: Number(row.graph_version), policyVersion: Number(policy?.revision ?? 0),
    stateVersion: workflowStateVersion(store, run), status: String(row.status),
    parallelism: Number(policy?.parallelism ?? store.recipe(String(row.recipe)).parallelism) };
}

/** Read a bounded page of unfinished work and evidence pointers, never worker
 * transcripts, raw evidence, credentials or the whole historical task graph. */
export function workflowObservation(store: Store, run: string,
  options: { limit?: number; maxBytes?: number; after?: string } = {}): Json {
  const limit = options.limit ?? 24, maxBytes = options.maxBytes ?? 16384, after = options.after ?? "";
  invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 128, "invalid workflow page limit");
  invariant(Number.isSafeInteger(maxBytes) && maxBytes >= 2048 && maxBytes <= 131072, "invalid workflow byte limit");
  invariant(typeof after === "string" && after.length <= 128, "invalid workflow cursor");
  const versions = workflowVersions(store, run);
  const recipe = store.recipe(String(store.db.prepare("SELECT recipe FROM runs WHERE id=?").get(run)!.recipe));
  const counts: Record<string, number> = {};
  for (const row of store.db.prepare("SELECT status,COUNT(*) AS n FROM tasks WHERE run=? GROUP BY status").all(run))
    counts[String(row.status)] = Number(row.n);
  const page: Record<string, Json> = { schema: 1, run, ...versions, counts,
    ceilings: { parallelism: recipe.parallelism, taskTimeoutMs: store.contract().limits.timeoutMs,
      tasks: store.contract().limits.tasks, inFlightContextBytes: recipe.maxInFlightContextBytes ?? null },
    tasks: [], nextAfter: null, omittedTasks: 0 };
  const rows = store.db.prepare(`SELECT t.id,t.spec,t.status,t.fence,t.deadline,t.error,t.artifact,t.evidence,
      p.timeout_ms,e.parent FROM tasks t
    LEFT JOIN workflow_task_policy p ON p.run=t.run AND p.task=t.id
    LEFT JOIN spawn_edges e ON e.run=t.run AND e.child=t.id
    WHERE t.run=? AND t.status<>'PASS' AND t.id>? ORDER BY t.id LIMIT ?`).all(run, after, limit + 1);
  const tasks = page.tasks as Json[];
  for (const row of rows.slice(0, limit)) {
    const task = JSON.parse(row.spec) as Task;
    const node = { id: task.id, status: String(row.status), fence: Number(row.fence),
      goalPreview: task.goal.slice(0, 512), goalComplete: task.goal.length <= 512,
      dependencies: task.dependencies.slice(0, 16), dependenciesComplete: task.dependencies.length <= 16,
      writeScope: task.writeScope.slice(0, 16), readScope: (task.readScope ?? []).slice(0, 16),
      scopesComplete: task.writeScope.length <= 16 && (task.readScope?.length ?? 0) <= 16,
      agent: task.agent ?? null, parent: row.parent ?? null, deadline: row.deadline ?? null,
      timeoutMs: Number(row.timeout_ms ?? recipe.timeoutMs),
      errorPreview: typeof row.error === "string" ? row.error.slice(0, 256) : null,
      artifactHash: row.artifact ?? null, evidenceHash: row.evidence ?? null };
    tasks.push(node);
    page.nextAfter = task.id;
    // Leave room for the final omission counter/cursor without trimming any
    // executable task, goal or dependency capsule.
    if (Buffer.byteLength(canonical(page)) > maxBytes - 128) {
      tasks.pop();
      if (tasks.length) break;
      // Even one very wide scope/goal must remain visible in pagination. Its
      // executable specification stays intact outside this bounded preview.
      tasks.push({ id: task.id, status: String(row.status), fence: Number(row.fence), detailsOmitted: true });
    }
  }
  page.omittedTasks = Object.entries(counts).reduce((n, [status, count]) => n + (status === "PASS" ? 0 : count), 0) - tasks.length;
  page.nextAfter = rows.length > tasks.length ? (tasks.length ? (tasks.at(-1) as any).id : rows[0]?.id ?? null) : null;
  invariant(Buffer.byteLength(canonical(page)) <= maxBytes, "workflow observation exceeds byte limit");
  return page;
}

function shape(value: any, fields: string[]): void {
  invariant(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)),
    "invalid workflow operation fields");
}

function graphSnapshot(store: Store, run: string): string {
  const versions = workflowVersions(store, run);
  return store.artifact(JSON.parse(canonical({ schema: 1, run, ...versions,
    tasks: store.db.prepare("SELECT id,spec FROM tasks WHERE run=? ORDER BY id").all(run)
      .map(row => ({ id: row.id, spec: JSON.parse(row.spec) })),
    edges: store.db.prepare("SELECT parent,child,depth,request_key FROM spawn_edges WHERE run=? ORDER BY child").all(run),
    timeouts: store.db.prepare("SELECT task,timeout_ms FROM workflow_task_policy WHERE run=? ORDER BY task").all(run),
  })));
}

/** The host supplies the role, limits, child decoder and idempotency key. The
 * model supplies only data. An entire patch either commits or leaves no effects. */
export function applyWorkflowProposal(store: Store, run: string, requestKey: string, payload: Json,
  bounds: WorkflowBounds, decodeChildren: (parent: Task, children: Json[]) => Task[], now = Date.now(),
  authority: WorkflowAuthority = {}): WorkflowReceipt {
  invariant(typeof requestKey === "string" && requestKey.length > 0 && requestKey.length <= 128, "invalid workflow request key");
  invariant(Buffer.byteLength(canonical(payload)) <= 131072, "workflow proposal exceeds byte limit");
  return store.transaction(() => {
    authority.assertCurrent?.();
    const hash = digest(payload);
    const prior = store.db.prepare("SELECT payload_hash,receipt_hash FROM workflow_commits WHERE run=? AND request_key=?").get(run, requestKey);
    if (prior) {
      invariant(prior.payload_hash === hash, "workflow request drift");
      return store.readArtifact(String(prior.receipt_hash)) as unknown as WorkflowReceipt;
    }
    const proposal = submitProposal(store, "POLICY", payload, run, `workflow:${requestKey}`);
    let changed = false, snapshotHash: string | null = null;
    const childIds: string[] = [];
    const admission = decideProposal(store, proposal, value => {
      store.db.exec("SAVEPOINT workflow_patch");
      try {
        shape(value, ["schema", "expectedGraphVersion", "expectedPolicyVersion", "expectedStateVersion", "reason", "operations"]);
        const p = value as unknown as WorkflowProposal;
        const versions = workflowVersions(store, run);
        if (authority.observed) invariant(p.expectedGraphVersion === authority.observed.graphVersion &&
          p.expectedPolicyVersion === authority.observed.policyVersion && p.expectedStateVersion === authority.observed.stateVersion,
          "workflow proposal does not match its host-observed input");
        invariant(versions.status === "RUNNING", "workflow run is not active");
        invariant(p.schema === 1 && p.expectedGraphVersion === versions.graphVersion &&
          p.expectedPolicyVersion === versions.policyVersion && p.expectedStateVersion === versions.stateVersion,
          "stale workflow snapshot");
        invariant(typeof p.reason === "string" && !!p.reason.trim() && Buffer.byteLength(p.reason) <= 2048,
          "invalid workflow reason");
        invariant(Array.isArray(p.operations) && p.operations.length <= bounds.maxOperations, "workflow operation limit exceeded");
        const used = Number(store.db.prepare("SELECT COUNT(*) AS n FROM workflow_commits WHERE run=?").get(run)!.n);
        invariant(used < bounds.maxReviews, "workflow review limit exceeded");
        const recipeHash = String(store.db.prepare("SELECT recipe FROM runs WHERE id=?").get(run)!.recipe);
        const recipe = store.recipe(recipeHash);
        const seen = new Set<string>();
        for (const op of p.operations) {
          invariant(op && bounds.allowedOperations.includes(op.op), "workflow operation is not permitted");
          const key = `${op.op}:${"taskId" in op ? op.taskId : "run"}`;
          invariant(!seen.has(key), "duplicate workflow operation"); seen.add(key);
          if (op.op === "set_parallelism") {
            shape(op, ["op", "parallelism"]);
            invariant(Number.isSafeInteger(op.parallelism) && op.parallelism > 0 && op.parallelism <= recipe.parallelism,
              "workflow parallelism exceeds admitted ceiling");
            store.db.prepare(`INSERT INTO workflow_run_policy VALUES(?,0,?)
              ON CONFLICT(run) DO UPDATE SET parallelism=excluded.parallelism`).run(run, op.parallelism);
          } else if (op.op === "set_task_timeout") {
            shape(op, ["op", "taskId", "timeoutMs"]);
            const task = store.db.prepare("SELECT status FROM tasks WHERE run=? AND id=?").get(run, op.taskId);
            invariant(task?.status === "READY", "timeout changes require a READY task; active leases are immutable");
            invariant(Number.isSafeInteger(op.timeoutMs) && op.timeoutMs > 0 &&
              op.timeoutMs <= Math.min(bounds.maxTaskTimeoutMs, store.contract().limits.timeoutMs),
              "workflow timeout exceeds host ceiling");
            store.db.prepare(`INSERT INTO workflow_task_policy VALUES(?,?,?)
              ON CONFLICT(run,task) DO UPDATE SET timeout_ms=excluded.timeout_ms`).run(run, op.taskId, op.timeoutMs);
          } else {
            shape(op, ["op", "taskId", "children"]);
            invariant(bounds.spawn, "workflow spawning is not configured");
            const row = store.db.prepare("SELECT spec FROM tasks WHERE run=? AND id=?").get(run, op.taskId);
            invariant(row, "unknown workflow parent");
            const children = decodeChildren(JSON.parse(row.spec), op.children);
            childIds.push(...expandUnstartedTaskInTransaction(store, run, op.taskId, `policy:${requestKey}`, hash, children, bounds.spawn, now));
          }
        }
        changed = p.operations.length > 0;
        if (changed) {
          store.db.prepare(`INSERT INTO workflow_run_policy VALUES(?,1,NULL)
            ON CONFLICT(run) DO UPDATE SET revision=revision+1`).run(run);
          snapshotHash = graphSnapshot(store, run);
          store.event("workflow.changed", { proposalId: proposal.id, requestKey,
            previousGraphVersion: versions.graphVersion, previousPolicyVersion: versions.policyVersion,
            snapshotHash, childIds }, run);
        }
      } catch (error) {
        store.db.exec("ROLLBACK TO workflow_patch");
        changed = false; snapshotHash = null; childIds.length = 0;
        throw error;
      } finally { store.db.exec("RELEASE workflow_patch"); }
    }, now);
    const versions = workflowVersions(store, run);
    const receipt: WorkflowReceipt = { ...admission, changed,
      graphVersion: versions.graphVersion, policyVersion: versions.policyVersion,
      stateHash: digest(versions), snapshotHash, childIds };
    const receiptHash = store.artifact(JSON.parse(canonical(receipt)));
    store.db.prepare("INSERT INTO workflow_commits VALUES(?,?,?,?,?)").run(run, requestKey, hash, receiptHash, now);
    store.event("workflow.proposal.receipt", { requestKey, receiptHash, verdict: admission.verdict }, run);
    return receipt;
  });
}
