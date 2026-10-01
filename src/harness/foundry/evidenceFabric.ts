import { canonical, digest, invariant } from "./kernel.ts";
import type { Store } from "./store.ts";
import type { Json, Measurement, Task } from "./types.ts";

export type EvidenceVerdict = "PASS" | "FAIL" | "UNKNOWN";
export type GoalStatus = "OPEN" | "VERIFIED" | "REJECTED" | "CONFLICTED";
export interface DomainPack {
  schema: 1;
  name: string;
  goalKinds: string[];
  evidenceKinds: string[];
  validators: string[];
  adjudicators: string[];
  success: { minimumStrength: number; requireMachineEvidence?: boolean };
}
export interface EvidenceRecord {
  id: string;
  run: string;
  goal: string;
  task: string | null;
  kind: string;
  verdict: EvidenceVerdict;
  strength: number;
  artifactHash: string | null;
  evidenceHash: string | null;
  source: string;
  created: number;
}
export interface AllocationRecord {
  task: string;
  criticality: number;
  uncertainty: number;
  evidenceStrength: number;
  experienceYield: number;
  novelty: number;
  repeatedFailure: number;
  resourceSpent: number;
  score: number;
  updated: number;
}

const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const textShape = (value: string): string => value.toLowerCase()
  .replace(/[0-9a-f]{8,}/g, "#")
  .replace(/\b\d+(?:\.\d+)?\b/g, "#")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 768);
const scopeShape = (paths: string[]) => paths.map(path => ({
  depth: path.split("/").length,
  extension: path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "",
})).sort((a, b) => a.depth - b.depth || a.extension.localeCompare(b.extension));

export function installEvidenceFabricTables(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS fabric_domain_packs(
      name TEXT PRIMARY KEY, hash TEXT NOT NULL, json TEXT NOT NULL, created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS fabric_goals(
      run TEXT NOT NULL, id TEXT NOT NULL, task TEXT, parent TEXT, domain TEXT NOT NULL,
      goal TEXT NOT NULL, spec_hash TEXT NOT NULL, acceptance_hash TEXT NOT NULL,
      status TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL,
      PRIMARY KEY(run,id));
    CREATE INDEX IF NOT EXISTS fabric_goals_task ON fabric_goals(run,task);
    CREATE TABLE IF NOT EXISTS fabric_goal_edges(
      run TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL,
      created REAL NOT NULL, PRIMARY KEY(run,source,target,kind));
    CREATE TABLE IF NOT EXISTS fabric_evidence(
      id TEXT PRIMARY KEY, run TEXT NOT NULL, goal TEXT NOT NULL, task TEXT, kind TEXT NOT NULL,
      verdict TEXT NOT NULL, strength REAL NOT NULL, artifact_hash TEXT, evidence_hash TEXT,
      source TEXT NOT NULL, created REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS fabric_evidence_goal ON fabric_evidence(run,goal,created);
    CREATE TABLE IF NOT EXISTS fabric_conflicts(
      id TEXT PRIMARY KEY, run TEXT NOT NULL, goal TEXT NOT NULL,
      left_evidence TEXT NOT NULL, right_evidence TEXT NOT NULL,
      status TEXT NOT NULL, adjudication_task TEXT, resolution_evidence TEXT,
      created REAL NOT NULL, resolved REAL);
    CREATE INDEX IF NOT EXISTS fabric_conflicts_goal ON fabric_conflicts(run,goal,status);
    CREATE TABLE IF NOT EXISTS fabric_experience(
      id TEXT PRIMARY KEY, run TEXT NOT NULL, task TEXT NOT NULL, domain TEXT NOT NULL,
      signature TEXT NOT NULL, topology TEXT NOT NULL, outcome TEXT NOT NULL,
      duration REAL NOT NULL, tokens REAL, cost REAL, strategy_hash TEXT NOT NULL,
      evidence_strength REAL NOT NULL, created REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS fabric_experience_signature
      ON fabric_experience(signature,domain,created DESC);
    CREATE TABLE IF NOT EXISTS fabric_allocations(
      run TEXT NOT NULL, task TEXT NOT NULL,
      criticality REAL NOT NULL, uncertainty REAL NOT NULL, evidence_strength REAL NOT NULL,
      experience_yield REAL NOT NULL, novelty REAL NOT NULL, repeated_failure REAL NOT NULL,
      resource_spent REAL NOT NULL, score REAL NOT NULL, updated REAL NOT NULL,
      PRIMARY KEY(run,task));
    CREATE INDEX IF NOT EXISTS fabric_allocations_score
      ON fabric_allocations(run,score DESC,task);
  `);
}

export function validateDomainPack(pack: DomainPack): void {
  canonical(pack);
  invariant(pack.schema === 1 && /^[a-z][a-z0-9-]{1,63}$/.test(pack.name), "invalid domain pack identity");
  for (const [label, values] of Object.entries({
    goalKinds: pack.goalKinds, evidenceKinds: pack.evidenceKinds,
    validators: pack.validators, adjudicators: pack.adjudicators,
  })) invariant(Array.isArray(values) && values.length > 0 &&
    values.every(value => typeof value === "string" && value.trim().length > 0) &&
    new Set(values).size === values.length, `invalid domain pack ${label}`);
  invariant(Number.isFinite(pack.success.minimumStrength) &&
    pack.success.minimumStrength > 0 && pack.success.minimumStrength <= 1,
    "invalid domain pack evidence threshold");
  invariant(pack.success.requireMachineEvidence === undefined ||
    typeof pack.success.requireMachineEvidence === "boolean", "invalid domain pack machine-evidence policy");
}

export function registerDomainPack(store: Store, pack: DomainPack, now = Date.now()): string {
  validateDomainPack(pack);
  const hash = digest(pack);
  const existing = store.db.prepare("SELECT hash FROM fabric_domain_packs WHERE name=?").get(pack.name);
  invariant(!existing || existing.hash === hash,
    "domain pack identity already exists with a different contract; version the pack name");
  store.db.prepare("INSERT OR IGNORE INTO fabric_domain_packs(name,hash,json,created) VALUES(?,?,?,?)")
    .run(pack.name, hash, canonical(pack), now);
  store.event("fabric.domain.registered", { name: pack.name, hash });
  return hash;
}

export const builtinDomainPacks = (): DomainPack[] => [
  {
    schema: 1, name: "software-engineering",
    goalKinds: ["feature", "bug-fix", "refactor", "integration"],
    evidenceKinds: ["independent-verification", "static-analysis", "test", "benchmark"],
    validators: ["pinned-check", "integration-check"],
    adjudicators: ["minimal-reproduction", "differential-test"],
    success: { minimumStrength: 1, requireMachineEvidence: true },
  },
  {
    schema: 1, name: "ml-research",
    goalKinds: ["hypothesis", "experiment", "ablation", "evaluation"],
    evidenceKinds: ["experiment-result", "frozen-evaluation", "replication", "negative-result"],
    validators: ["artifact-identity", "measurement-contract", "replication"],
    adjudicators: ["discriminating-ablation", "heldout-evaluation"],
    success: { minimumStrength: 0.9, requireMachineEvidence: true },
  },
  {
    schema: 1, name: "scientific-computing",
    goalKinds: ["hypothesis", "simulation", "derivation", "replication"],
    evidenceKinds: ["simulation-result", "counterexample", "replication", "formal-check"],
    validators: ["reproduction-script", "numeric-consistency", "independent-check"],
    adjudicators: ["minimal-counterexample", "discriminating-experiment"],
    success: { minimumStrength: 0.9, requireMachineEvidence: true },
  },
];

function activeDomain(store: Store): string {
  return store.getMeta<string>("extension.evidenceDomain") ?? "software-engineering";
}

export function taskExperienceSignature(task: Task, domain = "software-engineering"): string {
  return digest({
    domain,
    goal: textShape(task.goal),
    acceptance: [...task.acceptance].map(textShape).sort(),
    dependencyCount: task.dependencies.length,
    writeScope: scopeShape(task.writeScope),
    readScope: scopeShape(task.readScope ?? []),
    agent: task.agent ?? null,
  });
}

function taskTopology(task: Task): string {
  return digest({
    dependencies: task.dependencies.length,
    writeScopes: scopeShape(task.writeScope),
    readScopes: scopeShape(task.readScope ?? []),
    hasContextOverride: task.contextBudget !== undefined,
    hasDurationEstimate: task.estimatedDurationMs !== undefined,
  });
}

export function registerTaskGoals(store: Store, run: string, tasks: Task[],
  parent: string | null = null, domain = activeDomain(store), now = Date.now()): void {
  for (const task of tasks) {
    const specHash = digest(task); const acceptanceHash = digest(task.acceptance);
    const existing = store.db.prepare(
      "SELECT spec_hash,acceptance_hash,parent,domain FROM fabric_goals WHERE run=? AND id=?"
    ).get(run, task.id);
    if (existing) {
      invariant(existing.spec_hash === specHash && existing.acceptance_hash === acceptanceHash,
        "fabric goal binding drift");
      invariant((existing.parent ?? null) === parent || parent === null,
        "fabric goal parent drift");
      continue;
    }
    store.db.prepare(`INSERT INTO fabric_goals
      (run,id,task,parent,domain,goal,spec_hash,acceptance_hash,status,created,updated)
      VALUES(?,?,?,?,?,?,?,?, 'OPEN',?,?)`)
      .run(run, task.id, task.id, parent, domain, task.goal, specHash, acceptanceHash, now, now);
    for (const dependency of task.dependencies) store.db.prepare(
      "INSERT OR IGNORE INTO fabric_goal_edges(run,source,target,kind,created) VALUES(?,?,?,'dependency',?)"
    ).run(run, dependency, task.id, now);
    if (parent) store.db.prepare(
      "INSERT OR IGNORE INTO fabric_goal_edges(run,source,target,kind,created) VALUES(?,?,?,'decomposition',?)"
    ).run(run, parent, task.id, now);
  }
}

export function ensureRunFabric(store: Store, run: string, now = Date.now()): void {
  if (store.db.prepare("SELECT 1 FROM fabric_goals WHERE run=? LIMIT 1").get(run)) return;
  const rows = store.db.prepare("SELECT id,spec FROM tasks WHERE run=? ORDER BY id").all(run);
  invariant(rows.length > 0, "cannot project unknown run into evidence fabric");
  const parents = new Map(store.db.prepare(
    "SELECT child,parent FROM spawn_edges WHERE run=?"
  ).all(run).map(row => [String(row.child), String(row.parent)]));
  for (const row of rows) {
    const task = JSON.parse(row.spec) as Task;
    registerTaskGoals(store, run, [task], parents.get(task.id) ?? null, activeDomain(store), now);
  }
  refreshRunAllocations(store, run, now);
  store.event("fabric.run.projected", { tasks: rows.length }, run);
}

function opposite(verdict: EvidenceVerdict): EvidenceVerdict | null {
  if (verdict === "PASS") return "FAIL";
  if (verdict === "FAIL") return "PASS";
  return null;
}

export function recordEvidence(store: Store, input: {
  run: string; goal: string; task?: string | null; kind: string; verdict: EvidenceVerdict;
  strength: number; artifactHash?: string | null; evidenceHash?: string | null; source: string;
}, now = Date.now()): string {
  invariant(typeof input.kind === "string" && input.kind.length > 0 && input.kind.length <= 128, "invalid evidence kind");
  invariant(["PASS", "FAIL", "UNKNOWN"].includes(input.verdict), "invalid evidence verdict");
  invariant(Number.isFinite(input.strength) && input.strength >= 0 && input.strength <= 1, "invalid evidence strength");
  invariant(typeof input.source === "string" && input.source.length > 0 && input.source.length <= 256, "invalid evidence source");
  const goal = store.db.prepare("SELECT id FROM fabric_goals WHERE run=? AND id=?").get(input.run, input.goal);
  invariant(goal, "unknown fabric goal");
  const id = digest({ ...input, task: input.task ?? null, artifactHash: input.artifactHash ?? null,
    evidenceHash: input.evidenceHash ?? null, created: now });
  store.db.prepare(`INSERT OR IGNORE INTO fabric_evidence
    (id,run,goal,task,kind,verdict,strength,artifact_hash,evidence_hash,source,created)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.run, input.goal, input.task ?? null, input.kind,
      input.verdict, input.strength, input.artifactHash ?? null, input.evidenceHash ?? null, input.source, now);
  store.event("fabric.evidence.recorded",
    { id, goal: input.goal, kind: input.kind, verdict: input.verdict, strength: input.strength, source: input.source },
    input.run, input.task ?? null);

  const otherVerdict = opposite(input.verdict);
  if (otherVerdict && input.strength >= 0.75) {
    const other = store.db.prepare(`SELECT id FROM fabric_evidence
      WHERE run=? AND goal=? AND verdict=? AND strength>=0.75 AND id<>?
      ORDER BY strength DESC,created DESC LIMIT 1`).get(input.run, input.goal, otherVerdict, id);
    if (other) {
      const pair = [String(other.id), id].sort();
      const conflictId = digest({ run: input.run, goal: input.goal, evidence: pair });
      store.db.prepare(`INSERT OR IGNORE INTO fabric_conflicts
        (id,run,goal,left_evidence,right_evidence,status,created)
        VALUES(?,?,?,?,?,'OPEN',?)`).run(conflictId, input.run, input.goal, pair[0], pair[1], now);
      store.db.prepare("UPDATE fabric_goals SET status='CONFLICTED',updated=? WHERE run=? AND id=?")
        .run(now, input.run, input.goal);
      store.event("fabric.conflict.opened",
        { conflictId, goal: input.goal, evidence: pair }, input.run, input.task ?? null);
    }
  }
  return id;
}

function evidenceStrength(store: Store, run: string, task: Task): number {
  const dependencyEdges = store.db.prepare(
    "SELECT prerequisite FROM scheduler_edges WHERE run=? AND dependent=?"
  ).all(run, task.id).map(row => String(row.prerequisite));
  if (dependencyEdges.length) {
    const passed = dependencyEdges.filter(id =>
      store.db.prepare("SELECT status FROM tasks WHERE run=? AND id=?").get(run, id)?.status === "PASS").length;
    return clamp(passed / dependencyEdges.length);
  }
  const direct = store.db.prepare(
    "SELECT MAX(strength) AS s FROM fabric_evidence WHERE run=? AND goal=? AND verdict='PASS'"
  ).get(run, task.id)?.s;
  return direct == null ? 0 : clamp(Number(direct));
}

function runRecipe(store: Store, run: string) {
  const hash = store.db.prepare("SELECT recipe FROM runs WHERE id=?").get(run)?.recipe;
  invariant(typeof hash === "string", "unknown fabric run");
  return store.recipe(hash);
}

function latestFailureStats(store: Store, run: string, task: string): { novelty: number; repeated: number } {
  const rows = store.db.prepare(`SELECT m.failure_fingerprint AS fingerprint
    FROM attempts a LEFT JOIN attempt_telemetry m
      ON a.run=m.run AND a.task=m.task AND a.fence=m.fence
    WHERE a.run=? AND a.task=? AND a.status='FAIL'
    ORDER BY a.fence DESC LIMIT 16`).all(run, task);
  if (!rows.length || !rows[0].fingerprint) return { novelty: 1, repeated: 0 };
  const latest = String(rows[0].fingerprint);
  const seen = rows.filter(row => row.fingerprint === latest).length;
  let consecutive = 0;
  for (const row of rows) { if (row.fingerprint !== latest) break; consecutive++; }
  return {
    novelty: clamp(1 / Math.max(1, seen)),
    repeated: clamp(Math.max(0, consecutive - 1) / Math.max(1, runRecipe(store, run).attempts - 1)),
  };
}

function historicalYield(store: Store, task: Task, domain = activeDomain(store)): number {
  const signature = taskExperienceSignature(task, domain);
  const row = store.db.prepare(`SELECT COUNT(*) AS n,
    SUM(CASE WHEN outcome='PASS' THEN 1 ELSE 0 END) AS passed
    FROM fabric_experience WHERE signature=? AND domain=?`).get(signature, domain);
  const n = Number(row?.n ?? 0);
  return n ? clamp(Number(row?.passed ?? 0) / n) : 0;
}

export function refreshTaskAllocation(store: Store, run: string, taskId: string,
  now = Date.now()): AllocationRecord | null {
  const row = store.db.prepare("SELECT spec,status FROM tasks WHERE run=? AND id=?").get(run, taskId);
  const node = store.db.prepare("SELECT rank FROM scheduler_nodes WHERE run=? AND task=?").get(run, taskId);
  if (!row || !node) return null;
  const task = JSON.parse(row.spec) as Task;
  const maxRank = Number(store.db.prepare("SELECT MAX(rank) AS n FROM scheduler_nodes WHERE run=?").get(run)?.n ?? 0);
  const criticality = maxRank > 0 ? clamp(Number(node.rank) / maxRank) : 0;
  const evidence = evidenceStrength(store, run, task);
  const uncertainty = clamp(1 - evidence);
  const experience = historicalYield(store, task);
  const failure = latestFailureStats(store, run, taskId);
  const nonDeferred = Number(store.db.prepare(
    "SELECT COUNT(*) AS n FROM attempts WHERE run=? AND task=? AND status<>'DEFERRED'"
  ).get(run, taskId)?.n ?? 0);
  const resourceSpent = clamp(nonDeferred / Math.max(1, runRecipe(store, run).attempts));
  const score = 3 * criticality + 0.6 * uncertainty + 2 * experience + 0.8 * failure.novelty +
    1.5 * evidence - 3 * failure.repeated - 2 * resourceSpent;
  const record: AllocationRecord = {
    task: taskId, criticality, uncertainty, evidenceStrength: evidence,
    experienceYield: experience, novelty: failure.novelty,
    repeatedFailure: failure.repeated, resourceSpent, score, updated: now,
  };
  store.db.prepare(`INSERT INTO fabric_allocations
    (run,task,criticality,uncertainty,evidence_strength,experience_yield,novelty,repeated_failure,resource_spent,score,updated)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run,task) DO UPDATE SET
      criticality=excluded.criticality,uncertainty=excluded.uncertainty,
      evidence_strength=excluded.evidence_strength,experience_yield=excluded.experience_yield,
      novelty=excluded.novelty,repeated_failure=excluded.repeated_failure,
      resource_spent=excluded.resource_spent,score=excluded.score,updated=excluded.updated`)
    .run(run, taskId, criticality, uncertainty, evidence, experience, failure.novelty,
      failure.repeated, resourceSpent, score, now);
  return record;
}

export function refreshRunAllocations(store: Store, run: string, now = Date.now()): void {
  const tasks = store.db.prepare("SELECT task FROM scheduler_nodes WHERE run=? ORDER BY task").all(run);
  for (const row of tasks) refreshTaskAllocation(store, run, String(row.task), now);
}

function recordExperience(store: Store, run: string, task: Task, outcome: "PASS" | "FAIL",
  evidence: number, now: number): void {
  const attempts = store.db.prepare(
    "SELECT fence,duration,tokens,cost,status FROM attempts WHERE run=? AND task=? ORDER BY fence"
  ).all(run, task.id);
  const duration = attempts.reduce((sum, row) => sum + Number(row.duration ?? 0), 0);
  const tokens = attempts.length && attempts.every(row => row.tokens !== null)
    ? attempts.reduce((sum, row) => sum + Number(row.tokens), 0) : null;
  const cost = attempts.length && attempts.every(row => row.cost !== null)
    ? attempts.reduce((sum, row) => sum + Number(row.cost), 0) : null;
  const failures = store.db.prepare(`SELECT m.failure_fingerprint AS fingerprint
    FROM attempts a LEFT JOIN attempt_telemetry m
      ON a.run=m.run AND a.task=m.task AND a.fence=m.fence
    WHERE a.run=? AND a.task=? AND m.failure_fingerprint IS NOT NULL ORDER BY a.fence`).all(run, task.id)
    .map(row => String(row.fingerprint));
  const spawned = store.db.prepare("SELECT child FROM spawn_edges WHERE run=? AND parent=? ORDER BY child")
    .all(run, task.id).map(row => String(row.child));
  const strategyHash = digest({
    agent: task.agent ?? null, spawned: spawned.length, failures,
    dependencies: task.dependencies.length, scopes: scopeShape(task.writeScope),
  });
  const id = digest({ run, task: task.id, outcome, strategyHash });
  const domain = activeDomain(store);
  store.db.prepare(`INSERT OR IGNORE INTO fabric_experience
    (id,run,task,domain,signature,topology,outcome,duration,tokens,cost,strategy_hash,evidence_strength,created)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, run, task.id, domain,
      taskExperienceSignature(task, domain), taskTopology(task), outcome, duration, tokens, cost,
      strategyHash, evidence, now);
}

export function recordTaskAccepted(store: Store, run: string, task: Task,
  artifactHash: string, evidenceHash: string, _measurement: Measurement, now = Date.now()): string {
  const evidenceId = recordEvidence(store, {
    run, goal: task.id, task: task.id, kind: "independent-verification",
    verdict: "PASS", strength: 1, artifactHash, evidenceHash, source: "foundry-independent-verifier",
  }, now);
  store.db.prepare("UPDATE fabric_goals SET status='VERIFIED',updated=? WHERE run=? AND id=?")
    .run(now, run, task.id);
  recordExperience(store, run, task, "PASS", 1, now);
  refreshTaskAllocation(store, run, task.id, now);
  const dependents = store.db.prepare(
    "SELECT dependent FROM scheduler_edges WHERE run=? AND prerequisite=?"
  ).all(run, task.id);
  for (const dependent of dependents) refreshTaskAllocation(store, run, String(dependent.dependent), now);
  return evidenceId;
}

export function recordTaskFailure(store: Store, run: string, task: Task,
  terminal: boolean, fingerprint: string, now = Date.now()): string {
  const evidenceId = recordEvidence(store, {
    run, goal: task.id, task: task.id, kind: "attempt-failure",
    verdict: "FAIL", strength: terminal ? 0.6 : 0.25, source: `runtime:${fingerprint.slice(0, 32)}`,
  }, now);
  if (terminal) {
    store.db.prepare("UPDATE fabric_goals SET status='REJECTED',updated=? WHERE run=? AND id=?")
      .run(now, run, task.id);
    recordExperience(store, run, task, "FAIL", 0, now);
  }
  refreshTaskAllocation(store, run, task.id, now);
  return evidenceId;
}

export function resolveConflict(store: Store, conflictId: string, resolutionEvidence: string,
  now = Date.now()): void {
  const conflict = store.db.prepare(
    "SELECT run,goal,status FROM fabric_conflicts WHERE id=?"
  ).get(conflictId);
  invariant(conflict && conflict.status === "OPEN", "unknown or resolved evidence conflict");
  const evidence = store.db.prepare(
    "SELECT run,goal,verdict FROM fabric_evidence WHERE id=?"
  ).get(resolutionEvidence);
  invariant(evidence && evidence.run === conflict.run && evidence.goal === conflict.goal,
    "conflict resolution evidence binding mismatch");
  store.db.prepare(`UPDATE fabric_conflicts SET status='RESOLVED',
    resolution_evidence=?,resolved=? WHERE id=?`).run(resolutionEvidence, now, conflictId);
  const open = Number(store.db.prepare(
    "SELECT COUNT(*) AS n FROM fabric_conflicts WHERE run=? AND goal=? AND status='OPEN'"
  ).get(conflict.run, conflict.goal)?.n ?? 0);
  if (!open) store.db.prepare("UPDATE fabric_goals SET status=?,updated=? WHERE run=? AND id=?")
    .run(evidence.verdict === "PASS" ? "VERIFIED" : evidence.verdict === "FAIL" ? "REJECTED" : "OPEN",
      now, conflict.run, conflict.goal);
  store.event("fabric.conflict.resolved",
    { conflictId, goal: conflict.goal, resolutionEvidence }, conflict.run);
}

export function adjudicationTask(store: Store, conflictId: string,
  writeScope: string[] = [], readScope: string[] = [], agent?: string): Task {
  const conflict = store.db.prepare(
    "SELECT run,goal,left_evidence,right_evidence,status FROM fabric_conflicts WHERE id=?"
  ).get(conflictId);
  invariant(conflict && conflict.status === "OPEN", "unknown or resolved evidence conflict");
  const evidence = [conflict.left_evidence, conflict.right_evidence].map((id: string) => {
    const row = store.db.prepare(`SELECT id,task,kind,verdict,strength,artifact_hash,evidence_hash,source
      FROM fabric_evidence WHERE id=?`).get(id);
    invariant(row, "missing conflict evidence"); return row;
  });
  const dependencies = [...new Set(evidence.map(row => row.task).filter((id): id is string =>
    typeof id === "string" && !!store.db.prepare("SELECT 1 FROM tasks WHERE run=? AND id=?")
      .get(conflict.run, id)))];
  const task: Task = {
    id: `adjudicate-${String(conflictId).slice(0, 12)}`,
    goal: `Resolve contradictory evidence for goal ${conflict.goal} by constructing the smallest machine-checkable discriminator.`,
    acceptance: [
      "identify the concrete cause of the contradiction or preserve it as unresolved",
      "produce a machine-checkable test, counterexample, or discriminating experiment",
      "bind the conclusion to the exact conflicting evidence identifiers",
    ],
    dependencies, writeScope, readScope,
    input: JSON.parse(canonical({ conflictId, goal: conflict.goal, evidence })),
    ...(agent ? { agent } : {}),
  };
  store.db.prepare("UPDATE fabric_conflicts SET adjudication_task=? WHERE id=?")
    .run(task.id, conflictId);
  return task;
}

export function experienceMatches(store: Store, task: Task, limit = 5): Json[] {
  invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 50, "invalid experience match limit");
  const domain = activeDomain(store);
  const signature = taskExperienceSignature(task, domain);
  return store.db.prepare(`SELECT run,task,outcome,duration,tokens,cost,strategy_hash,evidence_strength,created
    FROM fabric_experience WHERE signature=? AND domain=?
    ORDER BY created DESC LIMIT ?`).all(signature, domain, limit).map(row => ({
      run: row.run, task: row.task, outcome: row.outcome, durationMs: Number(row.duration),
      tokens: row.tokens === null ? null : Number(row.tokens),
      costUsd: row.cost === null ? null : Number(row.cost),
      strategyHash: row.strategy_hash, evidenceStrength: Number(row.evidence_strength),
      created: Number(row.created),
    })) as Json[];
}

export function fabricStatus(store: Store, run: string): {
  goals: number; evidence: number; openConflicts: number; experiences: number;
  topAllocations: { task: string; score: number }[];
} {
  const count = (table: string, extra = "") => Number(store.db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE run=? ${extra}`
  ).get(run)?.n ?? 0);
  const top = store.db.prepare(`SELECT a.task,a.score FROM fabric_allocations a
    JOIN tasks t ON t.run=a.run AND t.id=a.task
    WHERE a.run=? AND t.status='READY' ORDER BY a.score DESC,a.task LIMIT 5`).all(run);
  return {
    goals: count("fabric_goals"),
    evidence: count("fabric_evidence"),
    openConflicts: count("fabric_conflicts", "AND status='OPEN'"),
    experiences: count("fabric_experience"),
    topAllocations: top.map(row => ({ task: String(row.task), score: Number(row.score) })),
  };
}
