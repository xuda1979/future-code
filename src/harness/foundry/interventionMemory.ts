import { canonical, digest, invariant } from "./kernel.ts";
import type { Store } from "./store.ts";
import type { Json, Task } from "./types.ts";

export type InterventionOutcome = "IMPROVED" | "NO_CLEAR_GAIN" | "REGRESSED" | "UNKNOWN";

const json = (value: unknown): Json => JSON.parse(canonical(value)) as Json;

export function installInterventionMemoryTables(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS rnd_intervention_effects(
    id TEXT PRIMARY KEY, objective TEXT NOT NULL, source_run TEXT NOT NULL, target_run TEXT NOT NULL,
    reflection_hash TEXT NOT NULL, finding TEXT NOT NULL, intervention_hash TEXT NOT NULL,
    intervention_classes TEXT NOT NULL, outcome TEXT NOT NULL, evidence_hash TEXT NOT NULL,
    domain TEXT NOT NULL, created REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS rnd_intervention_effects_lookup
      ON rnd_intervention_effects(domain,finding,intervention_hash,outcome);
    CREATE INDEX IF NOT EXISTS rnd_intervention_effects_objective
      ON rnd_intervention_effects(objective,created,source_run);
    CREATE TRIGGER IF NOT EXISTS rnd_intervention_effects_immutable_update
      BEFORE UPDATE ON rnd_intervention_effects BEGIN SELECT RAISE(ABORT,'append-only intervention evidence'); END;
    CREATE TRIGGER IF NOT EXISTS rnd_intervention_effects_immutable_delete
      BEFORE DELETE ON rnd_intervention_effects BEGIN SELECT RAISE(ABORT,'append-only intervention evidence'); END;`);
}

function graphDepth(tasks: Task[]): number {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const memo = new Map<string, number>();
  const visit = (id: string, stack = new Set<string>()): number => {
    const known = memo.get(id); if (known !== undefined) return known;
    invariant(!stack.has(id), "intervention graph is cyclic");
    const task = byId.get(id); invariant(task, "intervention graph references unknown dependency");
    const next = new Set(stack); next.add(id);
    const depth = 1 + Math.max(0, ...task.dependencies.map(dep => visit(dep, next)));
    memo.set(id, depth); return depth;
  };
  return Math.max(0, ...tasks.map(task => visit(task.id)));
}

function meanDefined(values: (number | undefined)[]): number | null {
  const xs = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function scopeCount(tasks: Task[], kind: "write" | "read"): number {
  return tasks.reduce((sum, task) => sum + (kind === "write" ? task.writeScope.length : (task.readScope ?? []).length), 0);
}

function shape(tasks: Task[], defaultAgent?: string): Record<string, any> {
  const agents = [...new Set(tasks.map(task => task.agent ?? defaultAgent ?? "default"))].sort();
  return {
    taskCount: tasks.length,
    rootCount: tasks.filter(task => task.dependencies.length === 0).length,
    dependencyEdges: tasks.reduce((sum, task) => sum + task.dependencies.length, 0),
    depth: graphDepth(tasks),
    agentMixHash: digest(agents),
    agentKinds: agents.length,
    avgContextBudget: meanDefined(tasks.map(task => task.contextBudget)),
    avgEstimatedDurationMs: meanDefined(tasks.map(task => task.estimatedDurationMs)),
    writeScopeCount: scopeCount(tasks, "write"),
    readScopeCount: scopeCount(tasks, "read"),
    acceptanceCount: tasks.reduce((sum, task) => sum + task.acceptance.length, 0),
  };
}

function directional(before: number | null, after: number | null, down: string, up: string, out: string[]): void {
  if (before === null || after === null || before === after) return;
  out.push(after < before ? down : up);
}

export function classifyIntervention(sourceTasks: Task[], targetTasks: Task[], defaultAgent?: string): Json {
  const before = shape(sourceTasks, defaultAgent);
  const after = shape(targetTasks, defaultAgent);
  const classes: string[] = [];
  directional(before.taskCount, after.taskCount, "reduce_task_count", "increase_task_count", classes);
  directional(before.rootCount, after.rootCount, "reduce_parallel_roots", "increase_parallel_roots", classes);
  directional(before.dependencyEdges, after.dependencyEdges, "reduce_dependency_edges", "increase_dependency_edges", classes);
  directional(before.depth, after.depth, "reduce_graph_depth", "increase_graph_depth", classes);
  directional(before.avgContextBudget, after.avgContextBudget, "reduce_context_budget", "increase_context_budget", classes);
  directional(before.avgEstimatedDurationMs, after.avgEstimatedDurationMs, "reduce_duration_budget", "increase_duration_budget", classes);
  directional(before.writeScopeCount, after.writeScopeCount, "narrow_write_scope", "widen_write_scope", classes);
  directional(before.readScopeCount, after.readScopeCount, "narrow_read_scope", "widen_read_scope", classes);
  directional(before.acceptanceCount, after.acceptanceCount, "reduce_acceptance_surface", "increase_acceptance_surface", classes);
  if (before.agentMixHash !== after.agentMixHash) classes.push("change_agent_mix");
  if (!classes.length) classes.push("semantic_plan_change");
  classes.sort();
  const descriptor = json({ classes, before, after });
  return json({ ...(descriptor as any), interventionHash: digest({ classes }) });
}

function reflectionForRun(store: Store, objective: string, run: string): { hash: string; value: any } | null {
  const row = store.db.prepare(`SELECT reflection_hash FROM rnd_run_reflections
    WHERE objective=? AND run=? ORDER BY created DESC LIMIT 1`).get(objective, run);
  if (!row) return null;
  return { hash: String(row.reflection_hash), value: store.readArtifact(String(row.reflection_hash)) as any };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function delta(after: unknown, before: unknown): number | null {
  const a = numberOrNull(after), b = numberOrNull(before);
  return a === null || b === null ? null : a - b;
}

function classifyOutcome(source: any, target: any): { outcome: InterventionOutcome; evidence: Json } {
  const sf = numberOrNull(source.verifiedFraction) ?? 0;
  const tf = numberOrNull(target.verifiedFraction) ?? 0;
  const fractionDelta = tf - sf;
  const attemptDelta = delta(target.verifiedPerAttempt, source.verifiedPerAttempt);
  const requestDelta = delta(target.verifiedPerRequest, source.verifiedPerRequest);
  const sourcePass = source.runStatus === "PASS";
  const targetPass = target.runStatus === "PASS";
  let outcome: InterventionOutcome;
  if (!["PASS", "FAIL"].includes(String(target.runStatus))) outcome = "UNKNOWN";
  else if ((!sourcePass && targetPass) || fractionDelta >= 0.20 ||
      (fractionDelta >= 0 && ((attemptDelta ?? 0) >= 0.20 || (requestDelta ?? 0) >= 0.20))) outcome = "IMPROVED";
  else if (fractionDelta <= -0.20 || (sourcePass && !targetPass)) outcome = "REGRESSED";
  else outcome = "NO_CLEAR_GAIN";
  return { outcome, evidence: json({
    sourceStatus: source.runStatus, targetStatus: target.runStatus,
    sourceVerifiedFraction: sf, targetVerifiedFraction: tf, verifiedFractionDelta: fractionDelta,
    verifiedPerAttemptDelta: attemptDelta, verifiedPerRequestDelta: requestDelta,
    wallClockDeltaMs: delta(target.wallClockMs, source.wallClockMs),
    costDeltaUsd: delta(target.costUsd, source.costUsd),
    sourceAttempts: source.attempts, targetAttempts: target.attempts,
    sourceModelRequests: source.modelRequests, targetModelRequests: target.modelRequests,
  }) };
}

export function evaluateInterventionOutcomes(store: Store, objective: string, now = Date.now()): number {
  installInterventionMemoryTables(store);
  const domain = store.getMeta<string>("extension.evidenceDomain") ?? "software-engineering";
  const recoveries = store.db.prepare(`SELECT r.run AS source_run,r.new_run,r.reflection_hash,r.addressed_findings,
      v0.plan AS source_plan,v1.plan AS target_plan
    FROM swarm_recovery_attempts r
    JOIN swarm_objective_revisions v0 ON v0.objective=r.objective AND v0.run=r.run
    JOIN swarm_objective_revisions v1 ON v1.objective=r.objective AND v1.run=r.new_run
    WHERE r.objective=? AND r.new_run IS NOT NULL AND r.reflection_hash IS NOT NULL
      AND r.addressed_findings IS NOT NULL ORDER BY r.revision`).all(objective);
  let inserted = 0;
  for (const row of recoveries) {
    const sourceReflection = reflectionForRun(store, objective, String(row.source_run));
    const targetReflection = reflectionForRun(store, objective, String(row.new_run));
    if (!sourceReflection || !targetReflection) continue;
    const sourceTasks = store.readArtifact(String(row.source_plan)) as unknown as Task[];
    const targetTasks = store.readArtifact(String(row.target_plan)) as unknown as Task[];
    const intervention: any = classifyIntervention(sourceTasks, targetTasks);
    const comparison = classifyOutcome(sourceReflection.value.productivity, targetReflection.value.productivity);
    const evidence = json({
      sourceReflectionHash: sourceReflection.hash, targetReflectionHash: targetReflection.hash,
      interventionHash: intervention.interventionHash, interventionClasses: intervention.classes,
      comparison: comparison.evidence,
    });
    const evidenceHash = store.artifact(evidence);
    const findings = JSON.parse(String(row.addressed_findings)) as unknown;
    invariant(Array.isArray(findings) && findings.every(code => typeof code === "string"),
      "invalid addressed findings in intervention lineage");
    for (const finding of [...new Set(findings as string[])].sort()) {
      const id = digest({ objective, sourceRun: row.source_run, targetRun: row.new_run, finding,
        interventionHash: intervention.interventionHash, sourceReflection: sourceReflection.hash,
        targetReflection: targetReflection.hash });
      const result = store.db.prepare(`INSERT OR IGNORE INTO rnd_intervention_effects
        (id,objective,source_run,target_run,reflection_hash,finding,intervention_hash,intervention_classes,outcome,evidence_hash,domain,created)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, objective, row.source_run, row.new_run,
          sourceReflection.hash, finding, intervention.interventionHash, canonical(intervention.classes),
          comparison.outcome, evidenceHash, domain, now);
      if (Number(result?.changes ?? 0) > 0) inserted++;
    }
  }
  if (inserted) store.event("objective.interventions.evaluated", { objective, inserted });
  return inserted;
}

export function interventionMemoryForFindings(store: Store, findings: string[], limitPerFinding = 5): Json {
  installInterventionMemoryTables(store);
  invariant(Number.isSafeInteger(limitPerFinding) && limitPerFinding > 0 && limitPerFinding <= 20, "invalid intervention memory limit");
  const domain = store.getMeta<string>("extension.evidenceDomain") ?? "software-engineering";
  const out: Record<string, Json[]> = {};
  for (const finding of [...new Set(findings)].sort()) {
    const rows = store.db.prepare(`SELECT intervention_hash,intervention_classes,
      COUNT(*) AS samples,
      SUM(CASE WHEN outcome='IMPROVED' THEN 1 ELSE 0 END) AS improved,
      SUM(CASE WHEN outcome='NO_CLEAR_GAIN' THEN 1 ELSE 0 END) AS neutral,
      SUM(CASE WHEN outcome='REGRESSED' THEN 1 ELSE 0 END) AS regressed,
      SUM(CASE WHEN outcome='UNKNOWN' THEN 1 ELSE 0 END) AS unknown
      FROM rnd_intervention_effects WHERE domain=? AND finding=?
      GROUP BY intervention_hash,intervention_classes
      ORDER BY samples DESC,improved DESC,regressed ASC,intervention_hash LIMIT ?`)
      .all(domain, finding, limitPerFinding);
    out[finding] = rows.map(row => {
      const samples = Number(row.samples);
      return json({
        interventionHash: String(row.intervention_hash),
        classes: JSON.parse(String(row.intervention_classes)),
        samples, improved: Number(row.improved), neutral: Number(row.neutral),
        regressed: Number(row.regressed), unknown: Number(row.unknown),
        evidenceLevel: samples >= 3 ? "SUPPORTED" : "OBSERVED",
      });
    });
  }
  return json({ domain, findings: out,
    caution: "Historical intervention outcomes are observational evidence, not causal proof. Small samples remain OBSERVED." });
}

export function interventionHistory(store: Store, objective: string): Json[] {
  installInterventionMemoryTables(store);
  return store.db.prepare(`SELECT source_run,target_run,finding,intervention_hash,intervention_classes,outcome,evidence_hash,domain,created
    FROM rnd_intervention_effects WHERE objective=? ORDER BY created,source_run,finding`).all(objective).map(row => json({
      sourceRunRef: digest({ objective, run: String(row.source_run) }),
      targetRunRef: digest({ objective, run: String(row.target_run) }),
      finding: String(row.finding), interventionHash: String(row.intervention_hash),
      classes: JSON.parse(String(row.intervention_classes)), outcome: String(row.outcome),
      evidenceHash: String(row.evidence_hash), domain: String(row.domain), created: Number(row.created),
  }));
}
