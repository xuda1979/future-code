import { workflowObservation } from "../workflow.ts";
import { acceptedDiscriminator } from "../adjudication.ts";
import { canonical, digest, invariant } from "../kernel.ts";
import { ResearchProgramme } from "../researchProgramme.ts";
import { selectResearchStrategy, type StrategyObservation } from "../researchStrategy.ts";
import { selectResearchFrontier } from "../researchFrontier.ts";
import { theoryGraph } from "../theory.ts";
import type { Store } from "../store.ts";
import type { Json, Task } from "../types.ts";
import type { PinnedSwarm } from "./config.ts";

/** Bounded, indexed observations for the independent workflow adviser.
 * Raw logs, private task input and unverified worker notes are excluded. */
export function researchStrategySnapshot(store: Store, cfg: PinnedSwarm, run: string, taskIds?: string[]): Json {
  const policy = cfg.spec.researchStrategy; invariant(policy, "research strategy not configured");
  const observations: StrategyObservation[] = [], unresolved: string[] = [], failed = new Set<string>(), costs: Record<string, number | null> = {};
  let used = 0, reserved = 0, unavailable: string | null = null;
  const installed = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_jobs'").get();
  const summaries = policy.candidates.map(candidate => {
    const spec = cfg.spec.jobs![candidate.template].research!.spec;
    // Tasks reserve research work when admitted, before their first run_job.
    // Indexed candidate lookups avoid parsing all unrelated swarm tasks.
    const assigned = store.db.prepare(`SELECT t.id,t.status,${installed ? `EXISTS(SELECT 1 FROM research_jobs j
      WHERE j.run=t.run AND j.task=t.id AND j.template=?)` : "0"} AS has_job
      FROM research_assignments a CROSS JOIN tasks t ON t.run=a.run AND t.id=a.task
      WHERE a.run=? AND a.template=? ORDER BY a.task LIMIT ?`)
      .all(...(installed ? [candidate.template] : []), run, candidate.template, policy.maxExperiments + 1);
    if (assigned.length > policy.maxExperiments) unavailable = "ASSIGNMENT_LIMIT_EXCEEDED";
    for (const task of assigned) {
      if (!task.has_job) reserved++;
      if (["FAIL", "BLOCKED"].includes(String(task.status))) failed.add(candidate.id);
      else if (task.status !== "PASS") unresolved.push(candidate.id);
      else if (!task.has_job) unavailable = "ACCEPTED_TASK_MISSING_REQUIRED_EXPERIMENT";
    }
    const rows = installed ? store.db.prepare("SELECT * FROM research_jobs WHERE run=? AND template=? ORDER BY key LIMIT ?")
      .all(run, candidate.template, policy.maxExperiments + 1) : [];
    used += rows.length;
    if (rows.length > policy.maxExperiments) unavailable = "OBSERVATION_LIMIT_EXCEEDED";
    const times = installed ? store.db.prepare(`SELECT created,updated FROM research_jobs WHERE template=? AND result_hash IS NOT NULL
      ORDER BY updated DESC LIMIT 8`).all(candidate.template) : [];
    const durations = times.map(r => Number(r.updated) - Number(r.created)).filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
    costs[candidate.id] = durations.length ? durations[Math.floor(durations.length / 2)] : null;
    for (const job of rows) {
      const task = store.db.prepare("SELECT status,evidence FROM tasks WHERE run=? AND id=?").get(run, job.task);
      if (["FAIL", "BLOCKED"].includes(String(task?.status))) { failed.add(candidate.id); continue; }
      if (!job.result_hash || task?.status !== "PASS") { unresolved.push(candidate.id); continue; }
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
  if (policy.frontier) {
    const theory = theoryGraph(policy, Object.fromEntries(Object.entries(cfg.spec.jobs ?? {}).filter(([, j]) => j.research).map(([name, j]) => [name, j.research!.spec])));
    const result = selectResearchFrontier(policy, observations, used + reserved, {
      pending: [...new Set(unresolved)], failed: [...failed], costs, theory });
    const batch = unavailable ? [] : result.batch;
    const decision = { next: batch[0] ?? null, batch, reason: unavailable ?? result.reason };
    const snapshot = { schema: 1, authority: "ADVICE_ONLY_RUNTIME_ENFORCES_SAFETY", strategyHash: digest(policy), used, reserved,
      committed: used + reserved, decision,
      frontier: { considered: policy.candidates.length, assigned: new Set(unresolved).size,
        maxParallel: policy.frontier.maxParallel, scoring: "UCB_INFORMATION_ALLOCATION_NOT_TRUTH_PROBABILITY",
        evidenceHash: result.evidenceHash, acceptedObservations: observations.length,
        ...(Object.keys(theory).length ? { theory: { obligations: Object.keys(theory).length,
          activeAssignments: result.activeAssignments,
          stateCounts: Object.fromEntries([...new Set(Object.values(result.proofStates))].sort().map(state =>
            [state, Object.values(result.proofStates).filter(value => value === state).length])) } } : {}),
        stateCounts: Object.fromEntries([...new Set(Object.values(result.states))].sort().map(state =>
          [state, Object.values(result.states).filter(value => value === state).length])),
        summariesOnly: true },
      // The host evaluates the complete bounded frontier, but transmits only
      // selected protocols and allocation diagnostics, never hundreds of traces.
      candidates: batch.map(id => {
        const c = summaries.find(c => c.id === id)!;
        return { id, template: c.template, line: c.line, purpose: c.purpose, specHash: c.specHash,
          question: c.question, hypothesis: c.hypothesis, hostObservedJobMs: c.hostObservedJobMs,
          ...(theory[id] ? { theory: { ...theory[id], unlocks: result.unlocks[id] } } : {}),
          checkedPrerequisites: c.after?.length ?? 0, lineEvidence: result.lines[c.line], allocationScore: result.scores[id] };
      }) };
    invariant(Buffer.byteLength(canonical(snapshot)) <= policy.maxSnapshotBytes, "research frontier snapshot exceeds byte bound");
    return JSON.parse(canonical(snapshot));
  }
  const decision = selectResearchStrategy(policy, observations, used + reserved, [...unresolved, ...failed], costs);
  const snapshot = { schema: 1, authority: "ADVICE_ONLY_RUNTIME_ENFORCES_SAFETY", strategyHash: digest(policy), used,
    decision: unavailable ? { ...decision, next: null, reason: unavailable } : decision,
    candidates: summaries, observations: observations.map(o => ({ key: o.key, candidate: o.candidate,
      specHash: o.assessment.specHash, resultHash: o.assessment.resultHash, outcome: o.assessment.outcome, ...(o.assessment.conflicted ? { conflicted: true } : {}) })),
    unresolved: [...new Set(unresolved)] };
  invariant(Buffer.byteLength(canonical(snapshot)) <= policy.maxSnapshotBytes, "research strategy snapshot exceeds byte bound");
  return JSON.parse(canonical(snapshot));
}

/** Called inside the existing child-admission transaction. Replay checks occur
 * before this gate; competing proposers cannot reserve the same search slot. */
export function assertResearchFrontierExpansion(store: Store, cfg: PinnedSwarm, run: string, children: Task[]): void {
  if (!cfg.spec.researchStrategy?.frontier) return;
  const templates = children.flatMap(child => child.research ?? []);
  if (!templates.length) return;
  const snapshot: any = researchStrategySnapshot(store, cfg, run);
  const candidates = new Map(cfg.spec.researchStrategy.candidates.map(c => [c.template, c.id]));
  const seen = new Set<string>();
  for (const template of templates) {
    const id = candidates.get(template);
    invariant(id && snapshot.decision.batch.includes(id), "research child is outside the current eligible frontier");
    invariant(!seen.has(id), "duplicate research frontier reservation"); seen.add(id);
  }
}
