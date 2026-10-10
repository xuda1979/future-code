import { canonical, digest, invariant } from "./kernel.ts";
import type { Store } from "./store.ts";
import type { Json } from "./types.ts";
import { executionProfile } from "./executionProfile.ts";

export type ReflectionSeverity = "HIGH" | "MEDIUM" | "LOW";
export interface ReflectionFinding {
  code: string;
  severity: ReflectionSeverity;
  confidence: number;
  evidence: Json;
  recommendation: string;
}
export interface ReflectionResult { hash: string; reflection: Json; sourceHash: string }

const json = (value: unknown): Json => JSON.parse(canonical(value)) as Json;
const severityRank: Record<ReflectionSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function tableExists(store: Store, name: string): boolean {
  return !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

export function installRndReflectionTables(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS rnd_run_reflections(
    objective TEXT NOT NULL, run TEXT NOT NULL, source_hash TEXT NOT NULL,
    reflection_hash TEXT NOT NULL, created REAL NOT NULL,
    PRIMARY KEY(objective,run,source_hash));
    CREATE INDEX IF NOT EXISTS rnd_run_reflections_objective
      ON rnd_run_reflections(objective,created DESC,run);
    CREATE TRIGGER IF NOT EXISTS rnd_run_reflections_immutable_update
      BEFORE UPDATE ON rnd_run_reflections BEGIN SELECT RAISE(ABORT,'append-only R&D reflection'); END;
    CREATE TRIGGER IF NOT EXISTS rnd_run_reflections_immutable_delete
      BEFORE DELETE ON rnd_run_reflections BEGIN SELECT RAISE(ABORT,'append-only R&D reflection'); END;`);
}

function nullableSum(rows: Record<string, any>[], key: string): number | null {
  if (!rows.length) return 0;
  if (rows.some(row => row[key] === null || !Number.isFinite(Number(row[key])))) return null;
  return rows.reduce((sum, row) => sum + Number(row[key]), 0);
}

function safeRatio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

function taskRows(store: Store, run: string): Record<string, any>[] {
  return store.db.prepare("SELECT id,status,artifact,evidence,error FROM tasks WHERE run=? ORDER BY id").all(run);
}

function attemptRows(store: Store, run: string): Record<string, any>[] {
  return store.db.prepare(`SELECT a.task,a.fence,a.status,a.started,a.ended,a.duration,a.tokens,a.cost,
      m.context_bytes,m.progress_count,m.failure_fingerprint
    FROM attempts a LEFT JOIN attempt_telemetry m
      ON a.run=m.run AND a.task=m.task AND a.fence=m.fence
    WHERE a.run=? ORDER BY a.task,a.fence`).all(run);
}

function requestRows(store: Store, run: string): Record<string, any>[] {
  if (!tableExists(store, "agent_requests")) return [];
  return store.db.prepare("SELECT task,provider,status,bytes,tokens FROM agent_requests WHERE run=? ORDER BY started,id").all(run);
}

function externalJobRows(store: Store, run: string): Record<string, any>[] {
  if (!tableExists(store, "research_jobs")) return [];
  return store.db.prepare("SELECT key,template,status,result_hash FROM research_jobs WHERE run=? ORDER BY key").all(run);
}

function conflictCount(store: Store, run: string): number {
  if (!tableExists(store, "fabric_conflicts")) return 0;
  return Number(store.db.prepare("SELECT COUNT(*) AS n FROM fabric_conflicts WHERE run=? AND status='OPEN'").get(run)?.n ?? 0);
}

function revisionInfo(store: Store, objective: string, run: string): { revision: number; previousRun: string | null; replans: number } {
  if (!tableExists(store, "swarm_objective_revisions")) return { revision: 0, previousRun: null, replans: 0 };
  const rows = store.db.prepare("SELECT revision,run FROM swarm_objective_revisions WHERE objective=? ORDER BY revision").all(objective);
  const index = rows.findIndex(row => String(row.run) === run);
  const revision = index >= 0 ? Number(rows[index].revision) : 0;
  return { revision, previousRun: index > 0 ? String(rows[index - 1].run) : null, replans: Math.max(0, rows.length - 1) };
}

function summaryForRun(store: Store, run: string): Record<string, any> {
  const runRow = store.db.prepare("SELECT recipe,started,ended,status FROM runs WHERE id=?").get(run);
  invariant(runRow, "reflection references unknown run");
  const tasks = taskRows(store, run);
  const attempts = attemptRows(store, run);
  const requests = requestRows(store, run);
  const jobs = externalJobRows(store, run);
  const verifiedTasks = tasks.filter(row => row.status === "PASS" && row.artifact && row.evidence).length;
  const failedAttempts = attempts.filter(row => ["FAIL", "EXPIRED"].includes(String(row.status))).length;
  const deferredAttempts = attempts.filter(row => String(row.status) === "DEFERRED").length;
  const unknownRequests = requests.filter(row => String(row.status) === "UNKNOWN").length;
  const unresolvedExternalJobs = jobs.filter(row => row.result_hash == null).length;
  const lastKnown = attempts.reduce((max, row) => Math.max(max, Number(row.ended ?? row.started ?? 0)), Number(runRow.started));
  const end = Number(runRow.ended ?? lastKnown);
  const costUsd = nullableSum(attempts, "cost");
  const attemptTokens = nullableSum(attempts, "tokens");
  const providerTokens = requests.length && requests.some(row => row.tokens === null)
    ? null : requests.reduce((sum, row) => sum + Number(row.tokens ?? 0), 0);
  const wallClockMs = Math.max(0, end - Number(runRow.started));
  const recipe = store.recipe(String(runRow.recipe));
  const maxContextBytes = attempts.reduce((max, row) => Math.max(max, Number(row.context_bytes ?? 0)), 0);
  const contextPressure = recipe.contextBytes > 0 ? maxContextBytes / recipe.contextBytes : 0;
  const contextLimits = new Map<string, number>();
  if (tableExists(store, "agent_threads")) for (const row of store.db.prepare("SELECT task,state FROM agent_threads WHERE run=?").all(run)) {
    const state = store.readArtifact(String(row.state)) as any;
    if (Number.isSafeInteger(state.contextLimit) && state.contextLimit > 0) contextLimits.set(String(row.task), state.contextLimit);
  }
  const providerContextPressure = requests.reduce((max, row) => Math.max(max,
    Number(row.bytes) / (contextLimits.get(String(row.task)) ?? recipe.contextBytes)), 0);
  const measuredExecution = executionProfile(store, run, end);
  const grouped = new Map<string, number>();
  for (const row of attempts) {
    if (!row.failure_fingerprint) continue;
    const key = `${String(row.task)}:${String(row.failure_fingerprint)}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  const maxRepeatedFailure = Math.max(0, ...grouped.values());
  const repeatedFailureTasks = new Set([...grouped.entries()].filter(([, count]) => count >= 2)
    .map(([key]) => key.slice(0, key.indexOf(":")))).size;
  return {
    runStatus: String(runRow.status), taskCount: tasks.length, verifiedTasks,
    failedTasks: tasks.filter(row => row.status === "FAIL").length,
    blockedTasks: tasks.filter(row => row.status === "BLOCKED").length,
    attempts: attempts.length, failedAttempts, deferredAttempts,
    modelRequests: requests.length, unknownRequests,
    requestBytes: requests.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0),
    attemptTokens, providerTokens, costUsd, wallClockMs,
    externalJobs: jobs.length, unresolvedExternalJobs, openConflicts: conflictCount(store, run),
    maxContextBytes, contextBudgetBytes: recipe.contextBytes, contextPressure, providerContextPressure,
    execution: measuredExecution,
    maxRepeatedFailure, repeatedFailureTasks,
    verifiedFraction: tasks.length ? verifiedTasks / tasks.length : 0,
    verifiedPerAttempt: safeRatio(verifiedTasks, attempts.length),
    verifiedPerRequest: safeRatio(verifiedTasks, requests.length),
    verifiedPerHour: wallClockMs > 0 ? verifiedTasks / (wallClockMs / 3_600_000) : null,
    costPerVerifiedTask: costUsd !== null && verifiedTasks > 0 ? costUsd / verifiedTasks : null,
  };
}

function finding(code: string, severity: ReflectionSeverity, evidence: Json, recommendation: string, confidence = 1): ReflectionFinding {
  return { code, severity, confidence, evidence, recommendation };
}

function findingsFor(summary: Record<string, any>, previous: Record<string, any> | null, replans: number): ReflectionFinding[] {
  const out: ReflectionFinding[] = [];
  if (summary.maxRepeatedFailure >= 2) out.push(finding(
    "repeated_failure_loop", summary.maxRepeatedFailure >= 3 ? "HIGH" : "MEDIUM",
    json({ maxRepeatedFailure: summary.maxRepeatedFailure, affectedTasks: summary.repeatedFailureTasks }),
    "Do not repeat the same causal strategy. Isolate the failure, change one evidence-backed hypothesis, and require a falsifying check before another expensive attempt.",
  ));
  if (summary.unknownRequests > 0) out.push(finding(
    "provider_outcome_uncertainty", "HIGH", json({ unknownRequests: summary.unknownRequests, modelRequests: summary.modelRequests }),
    "Reconcile unknown provider outcomes before attributing failure or spending additional request budget.",
  ));
  if (summary.unresolvedExternalJobs > 0) out.push(finding(
    "external_effect_uncertainty", "HIGH", json({ unresolvedExternalJobs: summary.unresolvedExternalJobs, externalJobs: summary.externalJobs }),
    "Reconcile remote jobs and preserve their artifacts before replanning; do not duplicate external compute.",
  ));
  if (summary.openConflicts > 0) out.push(finding(
    "evidence_conflict", "HIGH", json({ openConflicts: summary.openConflicts }),
    "Run a discriminating verification or experiment that resolves the contradictory evidence before claiming progress.",
  ));
  if (Math.max(summary.contextPressure, summary.providerContextPressure) >= 0.9) out.push(finding(
    "context_pressure", Math.max(summary.contextPressure, summary.providerContextPressure) >= 1 ? "HIGH" : "MEDIUM",
    json({ maxContextBytes: summary.maxContextBytes, contextBudgetBytes: summary.contextBudgetBytes,
      capsuleRatio: summary.contextPressure, providerInputRatio: summary.providerContextPressure }),
    "Split the task or narrow dependency views so the next worker receives a smaller causal context instead of another near-limit prompt.",
  ));
  const measured = summary.execution;
  const provider = measured?.provider;
  if (provider?.measuredWaits >= 4 && provider.admissionWaitMs >= 500 &&
      provider.admissionWaitMs >= (provider.responseMs ?? 0) * 0.25) out.push(finding(
    "provider_admission_pressure", "MEDIUM", json(provider),
    "The host measured permit waiting. Share quota pools consistently, reduce simultaneous provider-bound work, and keep independent tools or remote experiments productive while permits are occupied. Do not raise quotas without operator authority.",
  ));
  const phases = measured?.phaseWorkerMs;
  if (measured?.measuredAttempts >= 3 && phases?.verify >= 1000 &&
      phases.verify >= phases.execute) out.push(finding(
    "verification_dominated", "MEDIUM", json(measured),
    "Use change-aware exploratory checkpoints and reuse exact diagnostic receipts. Preserve every frozen acceptance and final integration check.",
  ));
  if (measured?.toolCalls >= 4 && phases?.toolsWithinExecute >= 1000 &&
      phases.toolsWithinExecute >= phases.execute * 0.5) out.push(finding(
    "tool_latency_dominated", "MEDIUM", json(measured),
    "Batch genuinely independent remote jobs in one turn and use durable ensure/inspect adapters. Narrow expensive diagnostics using receipts before another tool cycle; preserve idempotency and scope checks.",
  ));
  if (summary.attempts >= 3 && (summary.verifiedPerAttempt ?? 0) < 0.34) out.push(finding(
    "low_verified_yield", summary.verifiedTasks === 0 ? "HIGH" : "MEDIUM",
    json({ verifiedTasks: summary.verifiedTasks, attempts: summary.attempts, verifiedPerAttempt: summary.verifiedPerAttempt }),
    "Reduce breadth and run the cheapest high-information diagnostic or subtask first; require evidence before expanding work.",
  ));
  if (summary.modelRequests >= 4 && (summary.verifiedPerRequest ?? 0) < 0.25) out.push(finding(
    "low_request_productivity", summary.verifiedTasks === 0 ? "HIGH" : "MEDIUM",
    json({ verifiedTasks: summary.verifiedTasks, modelRequests: summary.modelRequests, verifiedPerRequest: summary.verifiedPerRequest }),
    "Stop conversational churn. Give the next agent a narrower contract with one measurable deliverable and reuse verified artifacts instead of re-explaining history.",
  ));
  if (summary.attempts > Math.max(4, summary.taskCount * 2) && summary.verifiedFraction < 1) out.push(finding(
    "attempt_overhead", "MEDIUM",
    json({ attempts: summary.attempts, taskCount: summary.taskCount, verifiedFraction: summary.verifiedFraction }),
    "Re-decompose the remaining work around independent failure modes and retire branches that are not increasing verified progress.",
  ));
  if (replans >= 2) out.push(finding(
    "recovery_churn", replans >= 4 ? "HIGH" : "MEDIUM", json({ replans }),
    "Treat repeated replanning as evidence that the decomposition or hypothesis is wrong; change the strategy class rather than renaming tasks.",
  ));
  if (previous && summary.attempts > 0 && summary.verifiedTasks <= previous.verifiedTasks) out.push(finding(
    "replan_without_verified_gain", summary.modelRequests >= previous.modelRequests ? "HIGH" : "MEDIUM",
    json({ previousVerifiedTasks: previous.verifiedTasks, currentVerifiedTasks: summary.verifiedTasks,
      previousAttempts: previous.attempts, currentAttempts: summary.attempts }),
    "The last strategy change did not increase verified progress. Preserve what was learned, falsify the prior hypothesis, and choose a materially different intervention.",
  ));
  return out.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.code.localeCompare(b.code));
}

export function reflectRun(store: Store, objective: string, run: string, reason?: string | null, now = Date.now()): ReflectionResult {
  installRndReflectionTables(store);
  const info = revisionInfo(store, objective, run);
  const summary = summaryForRun(store, run);
  const previous = info.previousRun ? summaryForRun(store, info.previousRun) : null;
  const reasonHash = reason ? digest(reason) : null;
  const source = json({
    objectiveRef: digest({ objective }), runRef: digest({ objective, run }), reasonHash,
    revision: info.revision, replans: info.replans, summary, previous,
  });
  const sourceHash = digest(source);
  const existing = store.db.prepare(`SELECT reflection_hash FROM rnd_run_reflections
    WHERE objective=? AND run=? AND source_hash=?`).get(objective, run, sourceHash);
  if (existing) return { hash: String(existing.reflection_hash), reflection: store.readArtifact(String(existing.reflection_hash)), sourceHash };
  const findings = findingsFor(summary, previous, info.replans);
  const reflection = json({
    schema: 1, type: "future-code-rnd-reflection",
    objectiveRef: digest({ objective }), runRef: digest({ objective, run }),
    reasonHash, revision: info.revision,
    productivity: summary,
    previousRun: previous ? json({
      verifiedTasks: previous.verifiedTasks, attempts: previous.attempts, modelRequests: previous.modelRequests,
      wallClockMs: previous.wallClockMs, verifiedPerAttempt: previous.verifiedPerAttempt,
      verifiedPerRequest: previous.verifiedPerRequest, costUsd: previous.costUsd,
    }) : null,
    findings: findings.map(item => json(item)),
    improvementPriorities: findings.map(item => item.code),
    sourceHash,
  });
  const hash = store.artifact(reflection);
  store.db.prepare(`INSERT INTO rnd_run_reflections(objective,run,source_hash,reflection_hash,created)
    VALUES(?,?,?,?,?)`).run(objective, run, sourceHash, hash, now);
  store.event("objective.reflection", { objective, run, reflectionHash: hash, sourceHash,
    findings: findings.map(item => item.code) }, run);
  return { hash, reflection, sourceHash };
}

export function reflectionHistory(store: Store, objective: string): { run: string; hash: string; created: number; reflection: Json }[] {
  installRndReflectionTables(store);
  return store.db.prepare(`SELECT run,reflection_hash,created FROM rnd_run_reflections
    WHERE objective=? ORDER BY created,run,source_hash`).all(objective).map(row => ({
      run: String(row.run), hash: String(row.reflection_hash), created: Number(row.created),
      reflection: store.readArtifact(String(row.reflection_hash)),
    }));
}

export function latestObjectiveReflection(store: Store, objective: string): Json | null {
  installRndReflectionTables(store);
  const row = store.db.prepare(`SELECT run,source_hash,reflection_hash,created FROM rnd_run_reflections
    WHERE objective=? ORDER BY created DESC LIMIT 1`).get(objective);
  if (!row) return null;
  const reflection: any = store.readArtifact(String(row.reflection_hash));
  return json({
    runRef: reflection.runRef, reflectionHash: String(row.reflection_hash), sourceHash: String(row.source_hash),
    created: Number(row.created), findings: Array.isArray(reflection.findings)
      ? reflection.findings.map((item: any) => ({ code: item.code, severity: item.severity })) : [],
    productivity: reflection.productivity ?? null,
  });
}

export function readLatestObjectiveReflection(store: Store, objective: string): Json {
  installRndReflectionTables(store);
  const row = store.db.prepare(`SELECT reflection_hash FROM rnd_run_reflections
    WHERE objective=? ORDER BY created DESC LIMIT 1`).get(objective);
  invariant(row, "objective has no captured reflection");
  return json({ reflectionHash: String(row.reflection_hash), reflection: store.readArtifact(String(row.reflection_hash)) });
}
