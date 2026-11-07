import { randomUUID } from "node:crypto";
import { canonical, conflicts, digest, invariant, validateTasks, validateEvidence } from "./kernel.ts";
import { runTasks } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import type { Driver, Evaluation, Protocol, Recipe, RunSummary, Task } from "./types.ts";

function validateProtocol(store: Store, p: Protocol): void {
  canonical(p); validateTasks(store.contract(), p.tasks);
  invariant(typeof p.datasetId === "string" && p.datasetId.length > 0, "dataset identity required");
  invariant(p.environmentId === store.contract().environmentId, "evaluation environment mismatch");
  invariant(Number.isSafeInteger(p.repetitions) && p.repetitions >= 2 && p.repetitions <= 100, "use 2..100 predeclared repetitions");
  invariant(["durationMs", "costUsd", "tokens", "progressDensity"].includes(p.objective), "invalid objective");
  invariant(Number.isFinite(p.minRelativeGain) && p.minRelativeGain > 0 && p.minRelativeGain < 1, "declare a positive gain threshold");
}
/** This is an engineering admission test, not a statistical significance claim. */
export function score(e: Evaluation): Pick<Evaluation, "decision" | "reasons" | "relativeGain"> {
  if (e.pairs.length !== e.protocol.repetitions) return { decision: "UNKNOWN", reasons: ["incomplete evaluation"], relativeGain: null };
  let baseline = 0; let candidate = 0;
  for (const pair of e.pairs) {
    for (const r of [pair.baseline, pair.candidate]) {
      // Dynamic children are verified implementation work. The exact admitted
      // root graph is authenticated separately before persistence/promotion.
      if (r.status !== "PASS" || r.accepted < e.protocol.tasks.length || r.failed || r.blocked) {
        return { decision: "REJECT", reasons: ["all predeclared tasks must pass in both arms; recovery is not an efficiency win"], relativeGain: null };
      }
      const n = r[e.protocol.objective];
      if (n === null || !Number.isFinite(n) || n < 0) return { decision: "UNKNOWN", reasons: ["missing or invalid complete cost measurement"], relativeGain: null };
    }
    baseline += pair.baseline[e.protocol.objective]!;
    candidate += pair.candidate[e.protocol.objective]!;
  }
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate))
    return { decision: "UNKNOWN", reasons: ["aggregate measurement overflow"], relativeGain: null };
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
  if (!Number.isFinite(relativeGain)) return { decision: "UNKNOWN", reasons: ["invalid relative gain"], relativeGain: null };
  return { decision: relativeGain >= e.protocol.minRelativeGain ? "ADMIT" : "REJECT",
    reasons: [relativeGain >= e.protocol.minRelativeGain ? "fixed quality contract and gain threshold satisfied" : "insufficient measured improvement"], relativeGain };
}
function save(store: Store, e: Evaluation, previousHash?: string): void {
  store.transaction(() => {
    if (previousHash === undefined) {
      store.db.prepare("INSERT INTO evaluations(id,json,hash) VALUES(?,?,?)").run(e.id, canonical(e), digest(e));
    } else {
      const result = store.db.prepare("UPDATE evaluations SET json=?,hash=? WHERE id=? AND hash=? AND promoted=0")
        .run(canonical(e), digest(e), e.id, previousHash);
      invariant(result.changes === 1, "evaluation changed concurrently; reload and resume instead of overwriting evidence");
    }
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
    protocolHash: digest(protocol), armRunIds: Array.from({ length: protocol.repetitions }, () => ({ baseline: randomUUID(), candidate: randomUUID() })),
    pairs: [], decision: "UNKNOWN", reasons: ["incomplete evaluation"], relativeGain: null };
  save(store, e);
  return resumeEvaluation(store, e.id, driver, signal);
}
export function loadEvaluation(store: Store, id: string): Evaluation {
  const row = store.db.prepare("SELECT json,hash FROM evaluations WHERE id=?").get(id); invariant(row, "unknown evaluation");
  const e: Evaluation = JSON.parse(row.json); invariant(e.id === id && digest(e) === row.hash, "evaluation integrity failure"); return e;
}

function validateBindings(store: Store, e: Evaluation): void {
  validateProtocol(store, e.protocol);
  invariant(e.contractHash === digest(store.contract()) && e.protocolHash === digest(e.protocol), "contract/protocol drift");
  const candidate = store.db.prepare("SELECT parent FROM recipes WHERE hash=?").get(e.candidateHash);
  invariant(candidate?.parent === e.baselineHash, "candidate lineage mismatch");
  store.recipe(e.candidateHash); store.recipe(e.baselineHash);
  invariant(e.pairs.length <= e.protocol.repetitions, "too many evaluation pairs");
  if (e.armRunIds) {
    const ids = e.armRunIds.flatMap(p => [p.baseline, p.candidate]);
    invariant(e.armRunIds.length === e.protocol.repetitions && ids.every(id => typeof id === "string" && id.length > 0) &&
      new Set(ids).size === ids.length, "invalid evaluation arm bindings");
    e.pairs.forEach((p, i) => invariant(p.baseline.id === e.armRunIds![i]!.baseline &&
      p.candidate.id === e.armRunIds![i]!.candidate, "evaluation arm binding mismatch"));
  }
}

/** Root specs stay frozen; every accepted child still needs intact evidence. */
function validateRun(store: Store, e: Evaluation, id: string, hash: string): void {
  const run = store.db.prepare("SELECT recipe,contract,status FROM runs WHERE id=?").get(id);
  invariant(run?.recipe === hash && run.contract === e.contractHash, "evaluation binding mismatch");
  invariant(run.status !== "PASS" || !store.db.prepare("SELECT 1 FROM tasks WHERE run=? AND status!='PASS' LIMIT 1").get(id),
    "terminal PASS run has unfinished tasks");
  const roots = store.db.prepare(`SELECT t.spec FROM tasks t WHERE t.run=? AND NOT EXISTS (
    SELECT 1 FROM spawn_edges s WHERE s.run=t.run AND s.child=t.id) ORDER BY t.id`)
    .all(id).map(t => JSON.parse(t.spec));
  const expected = [...e.protocol.tasks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  invariant(digest(roots) === digest(expected), "task set mismatch");
  for (const t of store.db.prepare("SELECT spec,artifact,evidence FROM tasks WHERE run=? AND status='PASS'").all(id)) {
    validateEvidence(store.contract(), hash, JSON.parse(t.spec), store.readArtifact(t.artifact), store.readArtifact(t.evidence));
  }
}

function validatePairs(store: Store, e: Evaluation, pairs = e.pairs): void {
  const seen = new Set<string>(); const scheduler = new Scheduler(store);
  for (const pair of pairs) for (const [r, hash] of [[pair.baseline, e.baselineHash], [pair.candidate, e.candidateHash]] as const) {
    invariant(!seen.has(r.id), "duplicate evaluation run"); seen.add(r.id);
    invariant(r.recipeHash === hash && r.contractHash === e.contractHash, "evaluation binding mismatch");
    invariant(digest(scheduler.summary(r.id)) === digest(r), "run evidence changed since evaluation");
    validateRun(store, e, r.id, hash);
  }
}

/** Resume the same frozen experiment, including an arm completed before a crash.
 * Scheduler fencing permits concurrent helpers; compare-and-swap prevents a
 * stale evaluator from overwriting a newer receipt. No transaction spans work. */
export async function resumeEvaluation(store: Store, id: string, driver: Driver, signal?: AbortSignal): Promise<Evaluation> {
  const e = loadEvaluation(store, id); validateBindings(store, e); validatePairs(store, e);
  invariant(store.active() === e.baselineHash, "stale evaluation baseline; refusing new evaluation work");
  invariant(driver.verifierId === store.contract().verifierId && driver.workerId === store.contract().workerId, "driver identity mismatch");
  if (e.pairs.length === e.protocol.repetitions) return e;
  invariant(e.armRunIds, "legacy incomplete evaluation has no durable arm bindings; start a new evaluation");
  const scheduler = new Scheduler(store);
  for (let i = e.pairs.length; i < e.protocol.repetitions; i++) {
    const pair = {} as { baseline: RunSummary; candidate: RunSummary };
    const order = i % 2 ? ["candidate", "baseline"] as const : ["baseline", "candidate"] as const;
    for (const arm of order) {
      if (signal?.aborted) return e;
      const runId = e.armRunIds[i]![arm]; const hash = arm === "baseline" ? e.baselineHash : e.candidateHash;
      invariant(store.active() === e.baselineHash, "stale evaluation baseline");
      if (store.db.prepare("SELECT 1 FROM runs WHERE id=?").get(runId)) validateRun(store, e, runId, hash);
      scheduler.start(e.protocol.tasks, hash, Date.now(), runId);
      pair[arm] = await runTasks(store, e.protocol.tasks, driver, { recipeHash: hash, resumeRun: runId, signal });
      if (pair[arm].status === "RUNNING") return e; // paused is not a completed measurement
    }
    const previousHash = digest(e);
    e.pairs.push(pair);
    // Check each fresh arm once; re-authenticate the whole experiment at the
    // final checkpoint and at promotion, rather than rescanning O(pairs²).
    validatePairs(store, e, e.pairs.length === e.protocol.repetitions ? e.pairs : [pair]);
    Object.assign(e, score(e)); save(store, e, previousHash);
  }
  return e;
}
/** A receipt is bound to actual durable runs, not user-supplied score JSON. */
export function promote(store: Store, id: string): string {
  return store.transaction(() => {
    const e = loadEvaluation(store, id); validateBindings(store, e);
    invariant(e.decision === "ADMIT" && score(e).decision === "ADMIT", "evaluation does not admit candidate");
    validatePairs(store, e);
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
export function suggest(store: Store, protocol?: Protocol): string | null {
  if (protocol) validateProtocol(store, protocol);
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

  // A frozen protocol's completed trials are durable negative/positive knowledge.
  // Retrying a rejected or unmeasurable configuration unchanged wastes work and
  // prevents trying the next hypothesis. Explicit evaluate remains available.
  const tested = new Set(protocol ? protocolEvaluations(store, protocol)
    .filter(({ evaluation: e }) => e.pairs.length === e.protocol.repetitions).map(({ evaluation: e }) => e.candidateHash) : []);
  const proposals: Partial<Recipe>[] = [];
  if (parallelismUseful) proposals.push({ parallelism: recipe.parallelism + 1 });
  if (priorityUseful) proposals.push({ priorityContextShare: 0.7 });
  for (const changes of proposals) {
    const hash = digest({ ...recipe, ...changes });
    const previous = store.db.prepare("SELECT parent FROM recipes WHERE hash=?").get(hash);
    if (tested.has(hash) || (previous && previous.parent !== active)) continue;
    return store.propose(changes);
  }
  return null;
}

function protocolEvaluations(store: Store, protocol: Protocol): { evaluation: Evaluation; promoted: boolean }[] {
  return store.db.prepare(`SELECT id,promoted FROM evaluations
    WHERE json_extract(json,'$.baselineHash')=? AND json_extract(json,'$.protocolHash')=? ORDER BY rowid`)
    .all(store.active(), digest(protocol)).map(row => {
      const evaluation = loadEvaluation(store, row.id); validateBindings(store, evaluation);
      return { evaluation, promoted: !!row.promoted };
    });
}

export interface EvolutionResult {
  evaluations: Evaluation[];
  skippedEvaluations: { id: string; reason: "legacy-missing-arm-bindings" }[];
  active: string;
  stopReason: "no-evidence-backed-change" | "cycle-limit" | "paused" | "unknown-evidence" | "awaiting-promotion";
}

/** Bounded autonomous policy search. Each cycle resumes existing work first,
 * learns from completed trials, and promotes only an authenticated admission.
 * This does not grant code-writing, deployment, or acceptance-edit authority. */
export async function evolve(store: Store, protocol: Protocol, driver: Driver,
  options: { maxCycles?: number; autoPromote?: boolean; signal?: AbortSignal } = {}): Promise<EvolutionResult> {
  validateProtocol(store, protocol); protocol = JSON.parse(canonical(protocol));
  const max = options.maxCycles ?? 1;
  invariant(Number.isSafeInteger(max) && max >= 1 && max <= 100, "use 1..100 bounded evolution cycles");
  const result: EvolutionResult = { evaluations: [], skippedEvaluations: [], active: store.active(), stopReason: "cycle-limit" };
  for (let i = 0; i < max; i++) {
    if (options.signal?.aborted) { result.stopReason = "paused"; break; }
    const history = protocolEvaluations(store, protocol);
    for (const { evaluation: e } of history) {
      if (!e.armRunIds && e.pairs.length < e.protocol.repetitions && !result.skippedEvaluations.some(s => s.id === e.id))
        result.skippedEvaluations.push({ id: e.id, reason: "legacy-missing-arm-bindings" });
    }
    const pending = history.find(({ evaluation: e, promoted }) => !promoted &&
      (e.pairs.length < e.protocol.repetitions ? !!e.armRunIds : e.decision === "ADMIT"));
    let e: Evaluation;
    if (pending) e = await resumeEvaluation(store, pending.evaluation.id, driver, options.signal);
    else {
      const candidate = suggest(store, protocol);
      if (!candidate) { result.stopReason = "no-evidence-backed-change"; break; }
      e = await evaluate(store, candidate, protocol, driver, options.signal);
    }
    result.evaluations.push(e);
    if (options.signal?.aborted) { result.stopReason = "paused"; break; }
    if (e.decision === "UNKNOWN") { result.stopReason = "unknown-evidence"; break; }
    if (e.decision === "ADMIT") {
      if (!options.autoPromote) { result.stopReason = "awaiting-promotion"; break; }
      result.active = promote(store, e.id);
    }
  }
  result.active = store.active(); return result;
}
