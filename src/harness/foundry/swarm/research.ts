import { SessionJournal } from "./session.ts";
import { invoke } from "../commands.ts";
import { canonical, digest, invariant } from "../kernel.ts";
import { assessResearch } from "../research.ts";
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
      let audit: unknown;
      if (spec.kind === "formal-proof") {
        const checker = cfg.researchCheckers?.[String(row.template)]; invariant(checker, "independent proof checker missing");
        // This command is separately pinned by the operator; it is not the worker/job adapter.
        audit = await invoke(checker, { schema: 1, spec, result: receipt.result.data }, cfg.spec.budget.maxToolOutputBytes,
          AbortSignal.any([signal, AbortSignal.timeout(cfg.spec.budget.toolTimeoutMs)]));
      }
      signal.throwIfAborted(); new SessionJournal(store).assertLease(c);
      const assessment = assessResearch(spec, receipt.result.data, audit);
      const assessmentHash = store.artifact(JSON.parse(canonical({ ...assessment,
        receiptHash: row.result_hash, ...(audit ? { auditHash: store.artifact(audit as any) } : {}) })));
      const previous = store.db.prepare(`SELECT assessment_hash FROM research_assessments WHERE run=? AND task=? AND template=? AND job_key=?`)
        .get(c.runId, c.task.id, row.template, row.key);
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
