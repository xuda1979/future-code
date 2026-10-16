import { workflowObservation } from "../workflow.ts";
import { acceptedDiscriminator } from "../adjudication.ts";
import { canonical, digest, invariant } from "../kernel.ts";
import { ResearchProgramme } from "../researchProgramme.ts";
import { selectResearchStrategy, type StrategyObservation } from "../researchStrategy.ts";
import type { Store } from "../store.ts";
import type { Json } from "../types.ts";
import type { PinnedSwarm } from "./config.ts";

/** Bounded, indexed observations for the independent workflow adviser.
 * Raw logs, private task input and unverified worker notes are excluded. */
export function researchStrategySnapshot(store: Store, cfg: PinnedSwarm, run: string, taskIds?: string[]): Json {
  const policy = cfg.spec.researchStrategy; invariant(policy, "research strategy not configured");
  const observations: StrategyObservation[] = [], unresolved: string[] = [], costs: Record<string, number | null> = {};
  let used = 0, unavailable: string | null = null;
  const installed = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_jobs'").get();
  const summaries = policy.candidates.map(candidate => {
    const spec = cfg.spec.jobs![candidate.template].research!.spec;
    const rows = installed ? store.db.prepare("SELECT * FROM research_jobs WHERE run=? AND template=? ORDER BY key LIMIT ?")
      .all(run, candidate.template, policy.maxExperiments + 1) : [];
    used += rows.length;
    if (rows.length > policy.maxExperiments) unavailable = "OBSERVATION_LIMIT_EXCEEDED";
    const times = installed ? store.db.prepare(`SELECT created,updated FROM research_jobs WHERE template=? AND result_hash IS NOT NULL
      ORDER BY updated DESC LIMIT 8`).all(candidate.template) : [];
    const durations = times.map(r => Number(r.updated) - Number(r.created)).filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
    costs[candidate.id] = durations.length ? durations[Math.floor(durations.length / 2)] : null;
    for (const job of rows) {
      if (!job.result_hash) { unresolved.push(candidate.id); continue; }
      const task = store.db.prepare("SELECT status,evidence FROM tasks WHERE run=? AND id=?").get(run, job.task);
      if (task?.status !== "PASS") { unresolved.push(candidate.id); continue; }
      const record = store.db.prepare("SELECT assessment_hash FROM research_assessments WHERE run=? AND task=? AND template=? AND job_key=?")
        .get(run, job.task, candidate.template, job.key);
      if (!record) { unavailable = "SCIENTIFIC_ASSESSMENT_MISSING"; continue; }
      const evidence = store.db.prepare(`SELECT id FROM fabric_evidence WHERE run=? AND task=? AND evidence_hash=?
        AND source='foundry-independent-verifier' AND kind='independent-verification'`).get(run, job.task, task.evidence);
      invariant(evidence, "strategy source lacks independent acceptance");
      const accepted = acceptedDiscriminator(store, run, String(evidence.id));
      const check: any = accepted.checks.find(c => c.id === "research" && c.verdict === "PASS");
      invariant(check && JSON.parse(check.detail).assessments.includes(record.assessment_hash), "strategy assessment is not accepted evidence");
      const assessment: any = store.readArtifact(String(record.assessment_hash));
      invariant(assessment.specHash === digest(spec), "strategy experiment identity changed");
      observations.push({ key: String(job.key), candidate: candidate.id, assessment });
    }
    return { ...candidate, specHash: digest(spec), question: spec.question.slice(0, 256), hypothesis: spec.hypothesis.slice(0, 256),
      hostObservedJobMs: costs[candidate.id] };
  });
  const visible = taskIds ?? ((workflowObservation(store, run, { limit: cfg.spec.supervision!.workflowPolicy!.maxSnapshotTasks,
    maxBytes: cfg.spec.supervision!.workflowPolicy!.maxSnapshotBytes }) as any).tasks.map((t: any) => t.id) as string[]);
  invariant(visible.length <= 128, "strategy task page exceeds bound");
  const imported = new Set<string>();
  if (cfg.spec.researchProgramme) for (const task of visible) {
    const row = store.db.prepare("SELECT spec FROM tasks WHERE run=? AND id=?").get(run, task);
    invariant(row, "strategy task page contains unknown task");
    for (const ref of JSON.parse(String(row.spec)).knowledge ?? []) {
      if (imported.has(ref.version)) continue; imported.add(ref.version);
      if (imported.size > 32) { unavailable = "KNOWLEDGE_OBSERVATION_LIMIT_EXCEEDED"; break; }
      const candidate = policy.candidates.find(c => (cfg.spec.jobs![c.template].research!.provides ?? c.template) === ref.id);
      if (!candidate) continue;
      try {
        const finding = new ResearchProgramme(store, cfg.spec.researchProgramme).read(ref);
        invariant(finding.assessment.specHash === digest(cfg.spec.jobs![candidate.template].research!.spec), "strategy imported protocol differs");
        observations.push({ key: ref.version, candidate: candidate.id, assessment: finding.assessment });
      } catch { unavailable = "IMPORTED_FINDING_UNAVAILABLE"; }
    }
  }
  const decision = selectResearchStrategy(policy, observations, used, unresolved, costs);
  const snapshot = { schema: 1, authority: "ADVICE_ONLY_RUNTIME_ENFORCES_SAFETY", strategyHash: digest(policy), used,
    decision: unavailable ? { ...decision, next: null, reason: unavailable } : decision,
    candidates: summaries, observations: observations.map(o => ({ key: o.key, candidate: o.candidate,
      specHash: o.assessment.specHash, resultHash: o.assessment.resultHash, outcome: o.assessment.outcome })),
    unresolved: [...new Set(unresolved)] };
  invariant(Buffer.byteLength(canonical(snapshot)) <= policy.maxSnapshotBytes, "research strategy snapshot exceeds byte bound");
  return JSON.parse(canonical(snapshot));
}
