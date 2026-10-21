import { canonical, digest, identifier, invariant } from "../kernel.ts";
import { fields } from "../research.ts";
import type { Capsule, Json } from "../types.ts";
import type { Store } from "../store.ts";
import type { PinnedSwarm, SwarmSpec } from "./config.ts";
import type { Call } from "./context.ts";
import type { ThreadState } from "./session.ts";

/** Project-owned allocation policy. Adapter metrics authorize compute only,
 * never scientific acceptance, task acceptance, or a new scheduler. */
export interface ExperimentPolicy {
  reuseIdentical: boolean;
  promotion?: { from: string; matchInput: string[]; metric: string[];
    direction: "min" | "max"; threshold: number };
}

export function validateExperimentPipelines(s: SwarmSpec): void {
  for (const [name, job] of Object.entries(s.jobs ?? {})) {
    const p = job.experiment; if (p === undefined) continue;
    fields(p, ["reuseIdentical"], ["promotion"]);
    invariant(typeof p.reuseIdentical === "boolean" && !job.research,
      "experiment pipeline requires a boolean reuse policy and an ordinary job template");
    const gate = p.promotion; if (gate === undefined) continue;
    fields(gate, ["from", "matchInput", "metric", "direction", "threshold"]); identifier(gate.from);
    invariant(gate.from !== name && s.jobs?.[gate.from]?.experiment,
      "experiment promotion requires another configured experiment stage");
    for (const list of [gate.matchInput, gate.metric]) {
      invariant(Array.isArray(list) && list.length > 0 && list.length <= 16,
        "experiment promotion identity/metric must be bounded and nonempty"); list.forEach(identifier);
    }
    invariant(new Set(gate.matchInput).size === gate.matchInput.length &&
      ["min", "max"].includes(gate.direction) && Number.isFinite(gate.threshold), "invalid experiment promotion rule");
    for (const a of Object.values(s.agents).filter(a => a.jobs?.includes(name)))
      invariant(a.jobs?.includes(gate.from), "experiment promotion prerequisite must be permitted to the submitting agent");
  }
  const done = new Set<string>(), visiting = new Set<string>();
  const visit = (name: string) => {
    invariant(!visiting.has(name), "cyclic experiment promotion pipeline"); if (done.has(name)) return;
    visiting.add(name); const from = s.jobs?.[name]?.experiment?.promotion?.from;
    if (from) visit(from);
    visiting.delete(name); done.add(name);
  };
  Object.keys(s.jobs ?? {}).forEach(visit);
}

export function installExperimentPipelines(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS experiment_job_calls(
    run TEXT NOT NULL, task TEXT NOT NULL, call_id TEXT NOT NULL, template TEXT NOT NULL,
    job_key TEXT NOT NULL, source_hash TEXT NOT NULL, PRIMARY KEY(run,task,call_id,template));
    CREATE TABLE IF NOT EXISTS experiment_stage_inputs(
      job_key TEXT NOT NULL, run TEXT NOT NULL, task TEXT NOT NULL, template TEXT NOT NULL,
      source_hash TEXT NOT NULL, policy_hash TEXT NOT NULL, identity_hash TEXT NOT NULL,
      PRIMARY KEY(job_key,policy_hash));
    CREATE INDEX IF NOT EXISTS experiment_stage_lookup ON experiment_stage_inputs(
      run,task,template,source_hash,policy_hash,identity_hash);`);
}

export interface ExperimentBinding { key: string; binding: string; sourceHash: string | null }

/** A call alias freezes its original source even if later edits occur before
 * reconciliation. New IDs reuse work only on the exact same source and input. */
export function experimentBinding(store: Store, cfg: PinnedSwarm, c: Capsule, call: Call): ExperimentBinding {
  const name = String(call.arguments.name), template = cfg.spec.jobs![name], input = call.arguments.input;
  const command = cfg.jobAdapters![name]; let sourceHash: string | null = null;
  const alias = template.experiment ? store.db.prepare(`SELECT job_key,source_hash FROM experiment_job_calls
    WHERE run=? AND task=? AND call_id=? AND template=?`).get(c.runId, c.task.id, call.id, name) : null;
  if (template.experiment) {
    const thread = store.db.prepare("SELECT state,fence FROM agent_threads WHERE run=? AND task=?").get(c.runId, c.task.id);
    invariant(thread && thread.fence === c.fence, "experiment requires current durable source observations");
    const state = store.readArtifact(String(thread.state)) as unknown as ThreadState;
    sourceHash = alias ? String(alias.source_hash) : digest({ base: cfg.baseCommit,
      dependencies: c.dependencies.map(d => ({ task: d.taskId, artifact: d.artifactHash })),
      patch: state.patchHash ?? digest("") });
  }
  const binding = digest({ command, template, input, base: cfg.baseCommit, ...(sourceHash ? { sourceHash } : {}) });
  const key = template.research || template.experiment?.reuseIdentical
    ? digest({ run: c.runId, task: c.task.id, name, binding })
    : digest({ run: c.runId, task: c.task.id, call: call.id, name });
  invariant(!alias || alias.job_key === key, "experiment call replay input drift");
  return { key, binding, sourceHash };
}

function identity(input: Json, names: string[]): string {
  invariant(input && typeof input === "object" && !Array.isArray(input), "experiment input must be an object");
  return digest(names.map(name => {
    invariant(Object.hasOwn(input, name) && input[name] !== null, `experiment identity missing '${name}'`);
    return [name, input[name]];
  }));
}

/** Materialize configured downstream projections at submission. Promotion
 * uses an indexed lookup instead of scanning tasks, transcripts or job history. */
export function recordExperimentInput(store: Store, cfg: PinnedSwarm, c: Capsule, call: Call, b: ExperimentBinding): void {
  if (!b.sourceHash) return;
  const name = String(call.arguments.name);
  store.db.prepare("INSERT OR IGNORE INTO experiment_job_calls VALUES(?,?,?,?,?,?)")
    .run(c.runId, c.task.id, call.id, name, b.key, b.sourceHash);
  for (const job of Object.values(cfg.spec.jobs!)) {
    const gate = job.experiment?.promotion; if (gate?.from !== name) continue;
    store.db.prepare("INSERT OR IGNORE INTO experiment_stage_inputs VALUES(?,?,?,?,?,?,?)")
      .run(b.key, c.runId, c.task.id, name, b.sourceHash, digest(gate), identity(call.arguments.input, gate.matchInput));
  }
}

/** Called inside the job-intent transaction. Existing remote identities bypass
 * new gates so a missing prerequisite cannot prevent reconciliation. */
export function experimentPromotion(store: Store, cfg: PinnedSwarm, c: Capsule, call: Call, b: ExperimentBinding): Json | null {
  const gate = cfg.spec.jobs![String(call.arguments.name)].experiment?.promotion; if (!gate) return null;
  const identityHash = identity(call.arguments.input, gate.matchInput), policyHash = digest(gate);
  const row = store.db.prepare(`SELECT j.* FROM experiment_stage_inputs i JOIN research_jobs j ON j.key=i.job_key
    WHERE i.run=? AND i.task=? AND i.template=? AND i.source_hash=? AND i.policy_hash=? AND i.identity_hash=?
    ORDER BY j.created DESC,j.rowid DESC LIMIT 1`)
    .get(c.runId, c.task.id, gate.from, b.sourceHash, policyHash, identityHash);
  const hint = `EXPERIMENT_PROMOTION_REQUIRED: run '${gate.from}' for the same source and declared input identity; its latest reconciled result must satisfy the configured metric threshold`;
  invariant(row?.status === "SUCCEEDED" && row.result_hash && row.reconciliation_hash, hint);
  const reply = store.readArtifact(String(row.result_hash)) as any;
  const reconciliation = store.readArtifact(String(row.reconciliation_hash)) as any;
  invariant(reply.key === row.key && reply.jobId === row.job_id && reply.status === "SUCCEEDED" &&
    reconciliation.key === row.key && reconciliation.jobId === row.job_id && reconciliation.status === row.status &&
    reconciliation.template === gate.from && reconciliation.inputHash === row.input_hash &&
    reconciliation.baseCommit === cfg.baseCommit && reconciliation.replyHash === row.result_hash,
    "experiment promotion receipt binding changed");
  let metric: any = reply.result;
  for (const part of gate.metric) {
    invariant(metric && typeof metric === "object" && Object.hasOwn(metric, part), hint); metric = metric[part];
  }
  invariant(typeof metric === "number" && Number.isFinite(metric) &&
    (gate.direction === "max" ? metric >= gate.threshold : metric <= gate.threshold), hint);
  return JSON.parse(canonical({ schema: 1, kind: "experiment-promotion", trust: "COMPUTE_ALLOCATION_NOT_ACCEPTANCE",
    from: gate.from, jobKey: row.key, resultHash: row.result_hash, reconciliationHash: row.reconciliation_hash,
    sourceHash: b.sourceHash, identityHash, policyHash, metric, threshold: gate.threshold, direction: gate.direction }));
}

/** Policy projection in the worker context; no extra model request. */
export function experimentPipelineContext(cfg: PinnedSwarm, names: string[] = []): Json {
  return Object.fromEntries(names.filter(name => cfg.spec.jobs?.[name]?.experiment)
    .map(name => [name, cfg.spec.jobs![name].experiment!])) as unknown as Json;
}
