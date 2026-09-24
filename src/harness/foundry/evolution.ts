import { randomUUID } from "node:crypto";
import { canonical, conflicts, digest, invariant, validateTasks, validateEvidence } from "./kernel.ts";
import { runTasks } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import type { Driver, Evaluation, Protocol, Task } from "./types.ts";

function validateProtocol(store: Store, p: Protocol): void {
  canonical(p); validateTasks(store.contract(), p.tasks);
  invariant(typeof p.datasetId === "string" && p.datasetId.length > 0, "dataset identity required");
  invariant(p.environmentId === store.contract().environmentId, "evaluation environment mismatch");
  invariant(Number.isSafeInteger(p.repetitions) && p.repetitions >= 2 && p.repetitions <= 100, "use 2..100 predeclared repetitions");
  invariant(["durationMs", "costUsd", "tokens", "progressDensity"].includes(p.objective), "invalid objective");
  invariant(Number.isFinite(p.minRelativeGain) && p.minRelativeGain > 0 && p.minRelativeGain < 1, "declare a positive gain threshold");
}
/** This is an engineering admission test, not a statistical significance claim. */
/** This is an engineering admission test, not a statistical significance claim. */
export function score(e: Evaluation): Pick<Evaluation, "decision" | "reasons" | "relativeGain"> {
  if (e.pairs.length !== e.protocol.repetitions) return { decision: "UNKNOWN", reasons: ["incomplete evaluation"], relativeGain: null };
  let baseline = 0; let candidate = 0;
  for (const pair of e.pairs) {
    for (const r of [pair.baseline, pair.candidate]) {
      if (r.status !== "PASS" || r.accepted !== e.protocol.tasks.length || r.failed || r.blocked) {
        return { decision: "REJECT", reasons: ["all predeclared tasks must pass in both arms; recovery is not an efficiency win"], relativeGain: null };
      }
      const n = r[e.protocol.objective];
      if (n === null || !Number.isFinite(n) || n < 0) return { decision: "UNKNOWN", reasons: ["missing or invalid complete cost measurement"], relativeGain: null };
    }
    baseline += pair.baseline[e.protocol.objective]!;
    candidate += pair.candidate[e.protocol.objective]!;
  }
  // For "lower is better" metrics (durationMs, tokens, costUsd): gain = 1 - candidate/baseline.
  // For "higher is better" metrics (progressDensity): gain = candidate/baseline - 1.
  let relativeGain: number;
  if (e.protocol.objective === "progressDensity") {
    if (baseline <= 0) return { decision: "UNKNOWN", reasons: ["baseline progressDensity is zero; relative improvement undefined"], relativeGain: null };
    relativeGain = candidate / baseline - 1;
  } else {
    if (baseline <= 0) return { decision: "UNKNOWN", reasons: ["baseline cost is zero; relative improvement undefined"], relativeGain: null };
    relativeGain = 1 - candidate / baseline;
  }
  return { decision: relativeGain >= e.protocol.minRelativeGain ? "ADMIT" : "REJECT",
    reasons: [relativeGain >= e.protocol.minRelativeGain ? "fixed quality contract and gain threshold satisfied" : "insufficient measured improvement"], relativeGain };
}
function save(store: Store, e: Evaluation): void {
  store.transaction(() => {
    store.db.prepare("INSERT INTO evaluations(id,json,hash) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,hash=excluded.hash WHERE evaluations.promoted=0").run(e.id, canonical(e), digest(e));
    store.event("evaluation.updated", { id: e.id, completedPairs: e.pairs.length, decision: e.decision });
  });
}
/** Freeze protocol before any work, alternate arm order, and count every retry. */
export async function evaluate(store: Store, candidateHash: string, protocol: Protocol, driver: Driver, signal?: AbortSignal): Promise<Evaluation> {
  validateProtocol(store, protocol); protocol = JSON.parse(canonical(protocol));
  const baselineHash = store.active(); store.recipe(candidateHash);
  const candidate = store.db.prepare("SELECT parent FROM recipes WHERE hash=?").get(candidateHash)!;
  invariant(candidate.parent === baselineHash, "candidate is not a child of active baseline");
  const e: Evaluation = { id: randomUUID(), baselineHash, candidateHash, contractHash: digest(store.contract()), protocol,
    protocolHash: digest(protocol), pairs: [], decision: "UNKNOWN", reasons: ["incomplete evaluation"], relativeGain: null };
  save(store, e);
  for (let i = 0; i < protocol.repetitions; i++) {
    if (signal?.aborted) break;
    const order = i % 2 ? [candidateHash, baselineHash] : [baselineHash, candidateHash];
    const first = await runTasks(store, protocol.tasks, driver, { recipeHash: order[0], signal });
    if (signal?.aborted) break;
    const second = await runTasks(store, protocol.tasks, driver, { recipeHash: order[1], signal });
    e.pairs.push(i % 2 ? { baseline: second, candidate: first } : { baseline: first, candidate: second });
    Object.assign(e, score(e)); save(store, e);
  }
  return e;
}
export function loadEvaluation(store: Store, id: string): Evaluation {
  const row = store.db.prepare("SELECT json,hash FROM evaluations WHERE id=?").get(id); invariant(row, "unknown evaluation");
  const e: Evaluation = JSON.parse(row.json); invariant(e.id === id && digest(e) === row.hash, "evaluation integrity failure"); return e;
}
/** A receipt is bound to actual durable runs, not user-supplied score JSON. */
export function promote(store: Store, id: string): string {
  return store.transaction(() => {
    const e = loadEvaluation(store, id); validateProtocol(store, e.protocol);
    invariant(e.contractHash === digest(store.contract()) && e.protocolHash === digest(e.protocol), "contract/protocol drift");
    invariant(e.decision === "ADMIT" && score(e).decision === "ADMIT", "evaluation does not admit candidate");
    const candidate = store.db.prepare("SELECT parent FROM recipes WHERE hash=?").get(e.candidateHash);
    invariant(candidate?.parent === e.baselineHash, "candidate lineage mismatch");
    store.recipe(e.candidateHash); store.recipe(e.baselineHash);
    const seen = new Set<string>(); const scheduler = new Scheduler(store);
    for (const pair of e.pairs) {
      for (const [r, hash] of [[pair.baseline, e.baselineHash], [pair.candidate, e.candidateHash]] as const) {
        invariant(!seen.has(r.id), "duplicate evaluation run"); seen.add(r.id);
        invariant(r.recipeHash === hash && r.contractHash === e.contractHash, "evaluation binding mismatch");
        invariant(digest(scheduler.summary(r.id)) === digest(r), "run evidence changed since evaluation");
        const actual = store.db.prepare("SELECT spec FROM tasks WHERE run=? ORDER BY id").all(r.id).map(t => JSON.parse(t.spec));
        const expected = [...e.protocol.tasks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        invariant(digest(actual) === digest(expected), "task set mismatch");
        // Missing or corrupted accepted artifacts invalidate the promotion.
        for (const t of store.db.prepare("SELECT spec,artifact,evidence FROM tasks WHERE run=?").all(r.id)) {
          validateEvidence(store.contract(), hash, JSON.parse(t.spec), store.readArtifact(t.artifact), store.readArtifact(t.evidence));
        }
      }
    }
    const receipt = store.db.prepare("SELECT promoted FROM evaluations WHERE id=?").get(id)!;
    if (receipt.promoted && store.active() === e.candidateHash) return e.candidateHash;
    invariant(!receipt.promoted && store.active() === e.baselineHash, "stale or already-consumed promotion receipt");
    store.db.prepare("UPDATE recipes SET admitted=1 WHERE hash=?").run(e.candidateHash);
    store.setMeta("active", e.candidateHash);
    store.db.prepare("UPDATE evaluations SET promoted=1 WHERE id=?").run(id);
    store.event("candidate.promoted", { evaluationId: id, from: e.baselineHash, to: e.candidateHash }); return e.candidateHash;
  });
}
export function rollback(store: Store, target: string): void {
  store.transaction(() => {
    store.recipe(target);
    invariant(store.db.prepare("SELECT admitted FROM recipes WHERE hash=?").get(target)?.admitted === 1, "cannot roll back to an unadmitted candidate");
    const from = store.active(); store.setMeta("active", target); store.event("harness.rollback", { from, to: target });
  });
}
/** One conservative proposal from actual workload structure; never changes gates.
 *  Proposes either increased parallelism (when there are more independent ready
 *  tasks than current parallelism) or priority-based context allocation (when
 *  tasks have varied priorities and would benefit from asymmetric context). */
export function suggest(store: Store): string | null {
  const active = store.active(); const recipe = store.recipe(active); const contract = store.contract();
  const rows = store.db.prepare("SELECT id FROM runs WHERE recipe=? AND status='PASS' ORDER BY started DESC LIMIT 3").all(active);
  if (rows.length < 3) return null;

  // Check if more parallelism would help: are there more independent ready tasks
  // than current parallelism?
  const parallelismUseful = recipe.parallelism < contract.limits.parallelism && rows.some(r => {
    const tasks: Task[] = store.db.prepare("SELECT spec FROM tasks WHERE run=?").all(r.id).map(t => JSON.parse(t.spec));
    const roots = tasks.filter(t => !t.dependencies.length);
    const independent: Task[] = [];
    for (const t of roots) if (independent.every(x => !conflicts(t.writeScope, x.writeScope))) independent.push(t);
    return independent.length > recipe.parallelism;
  });

  // Check if priority-based context allocation would help: are there tasks
  // with varied priorities and the recipe doesn't already use priority sharing?
  const priorityUseful = (recipe.priorityContextShare ?? 0) === 0 && rows.some(r => {
    const tasks: Task[] = store.db.prepare("SELECT spec FROM tasks WHERE run=?").all(r.id).map(t => JSON.parse(t.spec));
    const priorities = tasks.map(t => t.priority ?? 0);
    return Math.max(...priorities) > Math.min(...priorities);
  });

  // Prefer parallelism if both would help; otherwise try priority context.
  if (parallelismUseful) return store.propose({ parallelism: recipe.parallelism + 1 });
  if (priorityUseful) return store.propose({ priorityContextShare: 0.7 });
  return null;
}
