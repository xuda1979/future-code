import { canonical, digest, invariant } from "./kernel.ts";
import type { Store } from "./store.ts";
import type { Json, Task } from "./types.ts";

export interface RecoveryFeatures {
  schema: 1; domain: string; verifierId: string; environmentId: string; modelProfileHash: string;
  taskScale: string; dependencyScale: string; contextPressure: string; verifiedFraction: string;
  repeatedFailure: boolean; unknownProvider: boolean; unresolvedJobs: boolean; parallelism: number;
}
export function installContextualPolicyTables(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS rnd_intervention_contexts(
    effect_id TEXT PRIMARY KEY, context_hash TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS rnd_intervention_context_lookup ON rnd_intervention_contexts(context_hash,effect_id);
    CREATE TRIGGER IF NOT EXISTS rnd_intervention_contexts_immutable_update BEFORE UPDATE ON rnd_intervention_contexts
      BEGIN SELECT RAISE(ABORT,'append-only policy context'); END;
    CREATE TRIGGER IF NOT EXISTS rnd_intervention_contexts_immutable_delete BEFORE DELETE ON rnd_intervention_contexts
      BEGIN SELECT RAISE(ABORT,'append-only policy context'); END;`);
}
const bucket = (n: number): string => n <= 1 ? "1" : n <= 4 ? "2-4" : n <= 16 ? "5-16" : "17+";

/** Host-measured features. No model confidence, prose, paths or secret values. */
export function recoveryFeatures(store: Store, run: string, tasks: Task[], reflection: Json): RecoveryFeatures {
  const contract = store.contract();
  const row = store.db.prepare("SELECT recipe FROM runs WHERE id=?").get(run); invariant(row, "unknown policy run");
  const cfg: any = store.getMeta("extension.swarm");
  const profiles = Object.entries(cfg?.spec?.agents ?? {}).map(([id, profile]: [string, any]) => ({
    id, protocol: profile.protocol, model: profile.model, systemHash: digest(profile.system),
    tools: profile.tools, checks: profile.checks,
  }));
  const p: any = (reflection as any).productivity ?? {};
  return {
    schema: 1, domain: store.getMeta<string>("extension.evidenceDomain") ?? "software-engineering",
    verifierId: contract.verifierId, environmentId: contract.environmentId,
    modelProfileHash: digest(profiles), taskScale: bucket(tasks.length),
    dependencyScale: bucket(tasks.reduce((sum, task) => sum + task.dependencies.length, 0)),
    contextPressure: p.contextPressure >= 0.9 ? "high" : "normal",
    verifiedFraction: p.verifiedFraction >= 1 ? "complete" : p.verifiedFraction > 0 ? "partial" : "zero",
    repeatedFailure: p.maxRepeatedFailure >= 2, unknownProvider: p.unknownRequests > 0,
    unresolvedJobs: p.unresolvedExternalJobs > 0, parallelism: store.recipe(String(row.recipe)).parallelism,
  };
}

export function recordInterventionContext(store: Store, effectId: string, features: RecoveryFeatures): void {
  installContextualPolicyTables(store);
  store.db.prepare("INSERT OR IGNORE INTO rnd_intervention_contexts VALUES(?,?,?)")
    .run(effectId, digest(features), canonical(features));
}

function wilson(successes: number, n: number): { lower: number; upper: number } {
  if (!n) return { lower: 0, upper: 1 };
  const z2 = 1.96 ** 2, p = successes / n;
  const center = p + z2 / (2 * n), width = 1.96 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  const den = 1 + z2 / n;
  return { lower: (center - width) / den, upper: (center + width) / den };
}

/** Conservative contextual policy recommendations, NEVER admission authority.
 * Exact environment/verifier/model and feature strata avoid unrelated pooling.
 * Domain-wide memory is still supplied separately as weak observational context. */
export function contextualInterventionPolicy(store: Store, findings: string[], context: RecoveryFeatures,
  limitPerFinding = 5): Json {
  installContextualPolicyTables(store);
  invariant(Number.isSafeInteger(limitPerFinding) && limitPerFinding > 0 && limitPerFinding <= 20, "invalid policy limit");
  const grouped: Record<string, Json[]> = {};
  const contextHash = digest(context);
  for (const finding of [...new Set(findings)].sort()) {
    const rows = store.db.prepare(`WITH samples AS (
      SELECT e.*,ROW_NUMBER() OVER(PARTITION BY e.source_run,e.target_run,e.finding,e.intervention_hash ORDER BY e.created DESC,e.id DESC) AS ordinal
      FROM rnd_intervention_effects e JOIN rnd_intervention_contexts c ON c.effect_id=e.id
      WHERE c.context_hash=? AND e.domain=? AND e.finding=?
    ) SELECT intervention_hash,intervention_classes,COUNT(*) AS samples,
      SUM(CASE WHEN outcome='IMPROVED' THEN 1 ELSE 0 END) AS improved,
      SUM(CASE WHEN outcome='REGRESSED' THEN 1 ELSE 0 END) AS regressed,
      SUM(CASE WHEN outcome='NO_CLEAR_GAIN' THEN 1 ELSE 0 END) AS neutral,
      SUM(CASE WHEN outcome='UNKNOWN' THEN 1 ELSE 0 END) AS unknown
      FROM samples WHERE ordinal=1 GROUP BY intervention_hash,intervention_classes
      ORDER BY samples DESC,intervention_hash LIMIT 100`).all(contextHash, context.domain, finding);
    const candidates = rows.map(row => {
      const classes = JSON.parse(String(row.intervention_classes)) as string[];
      const known = Number(row.samples) - Number(row.unknown);
      const positive = wilson(Number(row.improved), known), negative = wilson(Number(row.regressed), known);
      const score = positive.lower - negative.upper;
      const comparable = !classes.includes("reduce_acceptance_surface");
      const recommendation = !comparable || known < 3 || Number(row.unknown) > 0 ? "ABSTAIN" :
        score > 0 ? "CONSIDER" : negative.lower > positive.upper ? "AVOID" : "ABSTAIN";
      return { interventionHash: String(row.intervention_hash), classes, samples: Number(row.samples), knownSamples: known,
        improved: Number(row.improved), regressed: Number(row.regressed), neutral: Number(row.neutral), unknown: Number(row.unknown),
        score, improvementInterval95: positive, regressionInterval95: negative, comparable,
        recommendation, evidenceLevel: known >= 3 && comparable ? "SUPPORTED" : "OBSERVED" };
    }).sort((a, b) => b.score - a.score || b.knownSamples - a.knownSamples || a.interventionHash.localeCompare(b.interventionHash));
    grouped[finding] = candidates.slice(0, limitPerFinding) as unknown as Json[];
  }
  return JSON.parse(canonical({ schema: 1, context, contextHash, findings: grouped, authority: "ADVISORY_ONLY",
    caution: "Stratified observational outcomes and Wilson intervals are not causal evidence. Abstain on sparse, unknown or weaker-acceptance samples; frozen host checks still decide admission." }));
}
