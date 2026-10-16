import { SessionJournal } from "./session.ts";
import { canonical, digest, invariant } from "../kernel.ts";
import { runResearchValidation } from "../researchValidation.ts";
import type { Store } from "../store.ts";
import type { Capsule, Check } from "../types.ts";
import type { PinnedSwarm } from "./config.ts";

export function installResearch(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS research_assessments(
    run TEXT NOT NULL, task TEXT NOT NULL, template TEXT NOT NULL, job_key TEXT NOT NULL,
    spec_hash TEXT NOT NULL, receipt_hash TEXT NOT NULL, assessment_hash TEXT NOT NULL,
    outcome TEXT NOT NULL, PRIMARY KEY(run,task,template,job_key));
    CREATE INDEX IF NOT EXISTS research_assessments_task ON research_assessments(run,task);`);
}

/** Independent final gate. Reconciled job receipts are observations, not scientific acceptance.
 * Negative and inconclusive results remain useful durable records under valid-result policy. */
export async function verifyResearch(store: Store, cfg: PinnedSwarm, c: Capsule, signal: AbortSignal): Promise<Check> {
  installResearch(store);
  try {
    const required = c.task.research ?? [];
    const hasJobs = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_jobs'").get();
    const rows = hasJobs ? store.db.prepare(`SELECT * FROM research_jobs WHERE run=? AND task=? ORDER BY template,key`)
      .all(c.runId, c.task.id) : [];
    for (const name of required) invariant(rows.some(r => r.template === name), `missing required experiment: ${name}`);
    const assessments: string[] = [];
    for (const row of rows) {
      const config = cfg.spec.jobs?.[String(row.template)]?.research;
      if (!config) continue;
      invariant(row.status === "SUCCEEDED" && row.result_hash && row.reconciliation_hash, "research job is not successfully reconciled");
      const receipt = store.readArtifact(String(row.result_hash)) as any;
      store.readArtifact(String(row.reconciliation_hash));
      invariant(receipt.key === row.key && receipt.jobId === row.job_id && receipt.status === row.status &&
        receipt.result?.exitCode === 0 && receipt.result.data, "research result receipt mismatch");
      const spec = config.spec;
      const previous = store.db.prepare(`SELECT assessment_hash FROM research_assessments WHERE run=? AND task=? AND template=? AND job_key=?`)
        .get(c.runId, c.task.id, row.template, row.key);
      const old: any = previous ? store.readArtifact(String(previous.assessment_hash)) : undefined;
      const context = { key: String(row.key), jobId: String(row.job_id),
        adapterHash: digest(cfg.jobAdapters![String(row.template)]), artifacts: receipt.result.artifacts ?? {} };
      const validation = await runResearchValidation(spec, receipt.result.data, context,
        cfg.experimentValidators?.[String(row.template)] ?? {}, signal, {
          legacyChecker: cfg.researchCheckers?.[String(row.template)], legacyTimeoutMs: cfg.spec.budget.toolTimeoutMs,
          maxOutputBytes: cfg.spec.budget.maxToolOutputBytes,
          onReport: (id, implementationHash, requestHash, report) => {
            new SessionJournal(store).assertLease(c);
            const reportHash = store.artifact(report);
            store.event("research.validation.observed", { validator: id, jobKey: String(row.key), implementationHash, requestHash, reportHash,
              trust: "OUTPUT_REQUIRES_HOST_VALIDATION" }, c.runId, c.task.id);
          },
          ...(spec.schema === 2 && old ? { cached: (old.validation ?? []).map((v: any) => ({ id: v.id,
            implementationHash: v.implementationHash, report: store.readArtifact(v.reportHash) })) } : {}),
        });
      signal.throwIfAborted(); new SessionJournal(store).assertLease(c);
      for (const evidence of validation.evidence) store.artifact(evidence);
      const assessment = validation.assessment;
      const assessmentHash = store.artifact(JSON.parse(canonical({ ...assessment, receiptHash: row.result_hash,
        ...(validation.legacyAudit ? { auditHash: store.artifact(validation.legacyAudit) } : {}) })));
      invariant(!previous || previous.assessment_hash === assessmentHash, "independent assessment changed on replay");
      if (!previous) store.transaction(() => {
        store.db.prepare(`INSERT INTO research_assessments VALUES(?,?,?,?,?,?,?,?)`)
          .run(c.runId, c.task.id, row.template, row.key, digest(spec), row.result_hash, assessmentHash, assessment.outcome);
        store.event("research.assessed", { template: String(row.template), assessmentHash, outcome: assessment.outcome }, c.runId, c.task.id);
      });
      assessments.push(assessmentHash);
      invariant(spec.acceptance === "valid-result" || assessment.outcome === "SUPPORTED", `hypothesis ${assessment.outcome.toLowerCase()}`);
    }
    return { id: "research", verdict: "PASS", detail: canonical({ required, assessments }) };
  } catch (error) {
    signal.throwIfAborted();
    return { id: "research", verdict: "FAIL", detail: String(error).slice(0, 4096) };
  }
}
