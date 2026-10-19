import { acceptedDiscriminator } from "../adjudication.ts";
import { canonical, digest, invariant } from "../kernel.ts";
import { ResearchProgramme, type KnowledgeRef, type ResearchFinding } from "../researchProgramme.ts";
import { theoryTargetHash, type CheckedTheoryPremise } from "../theory.ts";
import type { ExperimentSpec, ResearchAssessment } from "../research.ts";
import type { Store } from "../store.ts";
import type { Capsule, Task } from "../types.ts";
import type { PinnedSwarm } from "./config.ts";

/** Resolve only exact independently accepted deductions. Indexed template
 * lookups and memoized closure avoid scans of unrelated swarm tasks. This runs
 * before new external work, at verification, and inside atomic acceptance. */
export function theoryPremises(store: Store, cfg: PinnedSwarm, run: string, task: Task, spec: ExperimentSpec): CheckedTheoryPremise[] {
  if (!spec.theory?.premises.length) return [];
  const installed = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_assessments'").get();
  const programme = cfg.spec.researchProgramme ? new ResearchProgramme(store, cfg.spec.researchProgramme) : null;
  const checked = new Map<string, CheckedTheoryPremise[]>(), visiting = new Set<string>();
  const findings = new Map<string, ResearchFinding>(), acceptedSources = new Map<string, ReturnType<typeof acceptedDiscriminator>>();
  const readFinding = (ref: KnowledgeRef) => {
    invariant(programme, "theoretical import requires a programme");
    const key = `${ref.id}:${ref.version}`;
    if (!findings.has(key)) findings.set(key, programme.read(ref));
    return findings.get(key)!;
  };
  const resolve = (owner: Task, s: ExperimentSpec): CheckedTheoryPremise[] => {
    const key = digest({ task: owner.id, spec: digest(s) });
    if (checked.has(key)) return checked.get(key)!;
    invariant(!visiting.has(key) && checked.size + visiting.size < 256, "unbounded or cyclic theoretical evidence closure");
    visiting.add(key);
    const imported = (owner.knowledge ?? []).map(ref => ({ ref, finding: readFinding(ref) }));
    const summaries = s.theory!.premises.map(p => {
      const premise = cfg.spec.jobs![p.template].research!.spec as ExperimentSpec;
      invariant(premise.schema === 2 && premise.theory && digest(premise) === p.specHash, "theoretical premise protocol changed");
      const sources: { assessment: ResearchAssessment; source: any; owner?: Task }[] = [];
      if (installed) {
        const rows = store.db.prepare(`SELECT a.task,a.job_key,a.assessment_hash,t.evidence FROM research_assessments a
          JOIN tasks t ON t.run=a.run AND t.id=a.task WHERE a.run=? AND a.template=? AND a.spec_hash=?
          AND t.status='PASS' ORDER BY a.task,a.job_key LIMIT 257`).all(run, p.template, p.specHash);
        invariant(rows.length <= 256, "theoretical premise evidence limit exceeded");
        for (const row of rows) {
          let findingRef;
          if (programme) {
            const sourceKey = digest({ run, task: String(row.task), template: p.template, job: String(row.job_key) });
            const published = store.db.prepare("SELECT id,version,state FROM research_knowledge WHERE programme=? AND source_key=?")
              .get(programme.policy.id, sourceKey);
            invariant(published, "theoretical premise lacks programme publication");
            invariant(!["RETRACTED", "CONFLICTED"].includes(String(published.state)), "theoretical premise is retracted or conflicted");
            if (published.state === "STALE") continue;
            findingRef = { id: String(published.id), version: String(published.version) }; readFinding(findingRef);
          }
          const evidence = store.db.prepare(`SELECT id FROM fabric_evidence WHERE run=? AND task=? AND evidence_hash=?
            AND source='foundry-independent-verifier' AND kind='independent-verification'`).get(run, row.task, row.evidence);
          invariant(evidence, "theoretical premise lacks independent acceptance");
          const evidenceId = String(evidence.id);
          if (!acceptedSources.has(evidenceId)) acceptedSources.set(evidenceId, acceptedDiscriminator(store, run, evidenceId));
          const accepted = acceptedSources.get(evidenceId)!;
          const check: any = accepted.checks.find(c => c.id === "research" && c.verdict === "PASS");
          invariant(check && JSON.parse(check.detail).assessments.includes(row.assessment_hash), "theoretical premise assessment is not accepted evidence");
          // A prerequisite's explicit programme imports must still be current.
          (accepted.task.knowledge ?? []).forEach(readFinding);
          sources.push({ assessment: store.readArtifact(String(row.assessment_hash)) as unknown as ResearchAssessment,
            owner: accepted.task, source: { run, task: String(row.task), assessmentHash: String(row.assessment_hash), evidenceHash: accepted.evidenceHash,
              ...(findingRef ? { finding: findingRef } : {}) } });
        }
      }
      for (const { ref, finding } of imported) {
        if (finding.assessment.specHash === p.specHash) sources.push({ assessment: finding.assessment,
          source: { ...finding.origin, assessmentHash: finding.assessmentHash, finding: ref } });
      }
      invariant(sources.every(r => r.assessment.specHash === p.specHash && !r.assessment.conflicted &&
        r.assessment.outcome !== "REFUTED"), `theoretical premise contradicted: ${p.template}`);
      const established = sources.find(r => r.assessment.outcome === "SUPPORTED" && r.assessment.theory?.status === "ESTABLISHED" &&
        r.assessment.theory.targetHash === theoryTargetHash(premise));
      invariant(established, `theoretical premise is not established: ${p.template}`);
      if (established.owner) resolve(established.owner, premise);
      return { template: p.template, specHash: p.specHash, targetHash: theoryTargetHash(premise),
        statement: premise.theory!.statement, assumptions: premise.assumptions, source: established.source };
    });
    visiting.delete(key); checked.set(key, summaries); return summaries;
  };
  return resolve(task, spec);
}

/** Advisory task context must not prevent reconciliation of an existing job
 * after a premise is revoked. New submissions and final acceptance fail closed. */
export function theoryTaskContext(store: Store, cfg: PinnedSwarm, c: Capsule, maxBytes: number): unknown {
  const assumptionSets: Record<string, string[]> = {};
  const items = (c.task.research ?? []).flatMap(name => {
    const spec = cfg.spec.jobs![name].research!.spec;
    if (spec.schema !== 2 || !spec.theory) return [];
    try { return [{ template: name, ready: true, targetHash: theoryTargetHash(spec),
      premises: theoryPremises(store, cfg, c.runId, c.task, spec).map(({ assumptions, ...premise }) => {
        const assumptionsHash = digest(assumptions); assumptionSets[assumptionsHash] = assumptions;
        return { ...premise, assumptionsHash };
      }) }]; }
    catch { return [{ template: name, ready: false, targetHash: theoryTargetHash(spec),
      reason: "EXACT_CHECKED_PREMISES_UNAVAILABLE", premises: [] }]; }
  });
  if (!items.length) return undefined;
  const context = { trust: "CHECKED_DEDUCTIONS_UNDER_DECLARED_ASSUMPTIONS", items,
    ...(Object.keys(assumptionSets).length ? { assumptionSets } : {}) };
  invariant(Buffer.byteLength(canonical(context)) <= maxBytes, "theoretical context exceeds budget; narrow the task");
  return context;
}

export function assertTheoryAcceptance(store: Store, cfg: PinnedSwarm, c: Capsule): void {
  const installed = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_assessments'").get();
  if (!installed) return;
  for (const row of store.db.prepare("SELECT DISTINCT template FROM research_assessments WHERE run=? AND task=?").all(c.runId, c.task.id)) {
    const spec = cfg.spec.jobs![String(row.template)].research!.spec;
    if (spec.schema === 2 && spec.theory) theoryPremises(store, cfg, c.runId, c.task, spec);
  }
}
