import { acceptedDiscriminator } from "./adjudication.ts";
import { canonical, digest, identifier, invariant } from "./kernel.ts";
import { fields, hash, type ResearchAssessment, type ResearchSpec } from "./research.ts";
import type { Store } from "./store.ts";
import type { Capsule, Json } from "./types.ts";

export interface KnowledgeRef { id: string; version: string }
export interface ProgrammePolicy { id: string; maxFindingsPerTask: number; maxContextBytes: number }
export interface ResearchFinding {
  schema: 1;
  programme: string;
  id: string;
  version: string;
  spec: ResearchSpec;
  assessmentHash: string;
  assessment: ResearchAssessment;
  dependencies: KnowledgeRef[];
  origin: { run: string; task: string; artifactHash: string; evidenceHash: string; contractHash: string };
}
export function validateKnowledgeRefs(refs: KnowledgeRef[]): void {
  invariant(Array.isArray(refs) && refs.length <= 32 && new Set(refs.map(r => r.id)).size === refs.length,
    "invalid knowledge references");
  for (const ref of refs) { fields(ref, ["id", "version"]); identifier(ref.id); hash(ref.version); }
}
const json = (value: unknown): Json => JSON.parse(canonical(value));

/** Durable programme knowledge, separate from the authoritative task DAG.
 * Explicit exact-version imports are context, never a replacement for task acceptance. */
export class ResearchProgramme {
  readonly store: Store; readonly policy: ProgrammePolicy;
  constructor(store: Store, policy: ProgrammePolicy) {
    this.store = store; this.policy = policy;
    identifier(policy.id);
    store.db.exec(`CREATE TABLE IF NOT EXISTS research_knowledge(
      programme TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, record_hash TEXT NOT NULL,
      state TEXT NOT NULL, source_key TEXT NOT NULL, PRIMARY KEY(programme,id,version), UNIQUE(programme,source_key));
      CREATE TABLE IF NOT EXISTS research_knowledge_heads(
        programme TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(programme,id));
      CREATE TABLE IF NOT EXISTS research_knowledge_dependencies(
        programme TEXT NOT NULL, child TEXT NOT NULL, parent TEXT NOT NULL, PRIMARY KEY(programme,child,parent));
      CREATE INDEX IF NOT EXISTS research_knowledge_parent ON research_knowledge_dependencies(programme,parent);
      CREATE INDEX IF NOT EXISTS research_knowledge_version ON research_knowledge(programme,version);
      CREATE TABLE IF NOT EXISTS research_knowledge_conflicts(
        programme TEXT NOT NULL, id TEXT NOT NULL, left_version TEXT NOT NULL, right_version TEXT NOT NULL,
        PRIMARY KEY(programme,id,left_version,right_version));`);
  }
  private row(ref: KnowledgeRef): any {
    validateKnowledgeRefs([ref]);
    const row = this.store.db.prepare("SELECT * FROM research_knowledge WHERE programme=? AND id=? AND version=?")
      .get(this.policy.id, ref.id, ref.version);
    invariant(row, "unknown programme finding/version"); return row;
  }
  /** Historical records are inspectable, but only an active exact head can enter a new task. */
  read(ref: KnowledgeRef, historical = false): ResearchFinding {
    const row = this.row(ref);
    if (!historical) {
      const head = this.store.db.prepare("SELECT version FROM research_knowledge_heads WHERE programme=? AND id=?").get(this.policy.id, ref.id);
      invariant(head?.version === ref.version && row.state === "ACTIVE", `knowledge is ${String(row.state).toLowerCase()} or superseded`);
    }
    const record = this.store.readArtifact(String(row.record_hash)) as unknown as ResearchFinding;
    const { version, ...body } = record;
    invariant(version === ref.version && digest(body) === version && record.id === ref.id && record.programme === this.policy.id,
      "knowledge content binding mismatch");
    const source = this.store.db.prepare("SELECT status,artifact,evidence FROM tasks WHERE run=? AND id=?").get(record.origin.run, record.origin.task);
    invariant(source?.status === "PASS" && source.artifact === record.origin.artifactHash && source.evidence === record.origin.evidenceHash &&
      record.origin.contractHash === digest(this.store.contract()), "knowledge source acceptance changed");
    invariant(digest(this.store.readArtifact(record.assessmentHash)) === digest(record.assessment), "knowledge assessment changed");
    this.store.readArtifact(record.origin.evidenceHash); this.store.readArtifact(record.origin.artifactHash);
    return record;
  }
  context(refs: KnowledgeRef[], options: { theoryStatementsOnly?: boolean } = {}): Json {
    validateKnowledgeRefs(refs);
    invariant(refs.length <= this.policy.maxFindingsPerTask, "knowledge import count exceeds policy");
    const assumptionSets: Record<string, string[]> = {};
    const findings = refs.map(ref => this.read(ref)).map(f => {
      if (!options.theoryStatementsOnly || f.spec.schema !== 2 || !f.spec.theory) return f;
      const assumptionsHash = digest(f.spec.assumptions); assumptionSets[assumptionsHash] = f.spec.assumptions;
      return { id: f.id, version: f.version, projection: "EXACT_CHECKED_THEORETICAL_STATEMENT", recordHash: digest(f),
        statement: f.spec.theory.statement, assumptionsHash, specHash: f.assessment.specHash,
        assessmentHash: f.assessmentHash, theory: { status: f.assessment.theory!.status, targetHash: f.assessment.theory!.targetHash },
        dependencies: f.dependencies, origin: f.origin };
    });
    const result = json({ programme: this.policy.id, trust: "VERIFIED_OBSERVATIONS_WITH_ASSUMPTIONS", findings,
      ...(Object.keys(assumptionSets).length ? { assumptionSets } : {}) });
    invariant(Buffer.byteLength(canonical(result)) <= this.policy.maxContextBytes, "knowledge context exceeds policy; use narrower findings");
    return result;
  }
  /** Must run inside Scheduler.finish's acceptance transaction. Publication and PASS commit together. */
  accepted(c: Capsule, artifactHash: string, evidenceHash: string, names: Record<string, string>): void {
    const source = this.store.db.prepare("SELECT status,fence,artifact,evidence FROM tasks WHERE run=? AND id=?").get(c.runId, c.task.id);
    invariant(source?.status === "PASS" && source.fence === c.fence && source.artifact === artifactHash && source.evidence === evidenceHash,
      "programme export requires exact accepted source");
    const independent = this.store.db.prepare(`SELECT id FROM fabric_evidence WHERE run=? AND task=? AND evidence_hash=?
      AND source='foundry-independent-verifier' AND kind='independent-verification'`).get(c.runId, c.task.id, evidenceHash);
    invariant(independent, "programme export missing independent verification");
    const discriminator = acceptedDiscriminator(this.store, c.runId, String(independent.id));
    const researchCheck: any = discriminator.checks.find(check => check.id === "research" && check.verdict === "PASS");
    const rows = this.store.db.prepare(`SELECT * FROM research_assessments WHERE run=? AND task=? ORDER BY template,job_key LIMIT ?`)
      .all(c.runId, c.task.id, this.policy.maxFindingsPerTask + 1);
    invariant(rows.length <= this.policy.maxFindingsPerTask, "programme publication count exceeds policy");
    if (!rows.length) return;
    invariant(researchCheck, "programme findings require scientific verification");
    const authorized: string[] = JSON.parse(researchCheck.detail).assessments;
    for (const row of rows) {
      invariant(authorized.includes(String(row.assessment_hash)), "assessment not bound to accepted verification");
      const config: any = this.store.getMeta<any>("extension.swarm").spec.jobs[String(row.template)].research;
      const id = names[String(row.template)] ?? String(row.template); identifier(id);
      const dependencies = [...(c.task.knowledge ?? [])];
      // A theorem exported from same-run deductions must carry their exact
      // programme versions too, so later retraction invalidates its dependents.
      if (config.spec.schema === 2 && config.spec.theory) for (const premise of config.spec.theory.premises) {
        const name = names[premise.template] ?? premise.template;
        const head = this.store.db.prepare("SELECT version FROM research_knowledge_heads WHERE programme=? AND id=?").get(this.policy.id, name);
        invariant(head, "theoretical premise has no programme finding");
        const ref = { id: name, version: String(head.version) }, finding = this.read(ref);
        invariant(finding.assessment.specHash === premise.specHash && finding.assessment.theory?.status === "ESTABLISHED" &&
          finding.assessment.outcome === "SUPPORTED", "theoretical programme premise is not an exact checked deduction");
        const existing = dependencies.find(d => d.id === name);
        invariant(!existing || existing.version === ref.version, "theoretical programme premise version drift");
        if (!existing) dependencies.push(ref);
      }
      validateKnowledgeRefs(dependencies);
      invariant(!dependencies.some(ref => ref.id === id), "finding cannot replace its own imported dependency");
      const sourceKey = digest({ run: c.runId, task: c.task.id, template: row.template, job: row.job_key });
      const previous = this.store.db.prepare("SELECT version FROM research_knowledge WHERE programme=? AND source_key=?").get(this.policy.id, sourceKey);
      if (previous) continue;
      dependencies.forEach(ref => this.read(ref));
      const assessment = this.store.readArtifact(String(row.assessment_hash)) as unknown as ResearchAssessment;
      invariant(assessment.specHash === digest(config.spec), "finding specification changed");
      const body = { schema: 1 as const, programme: this.policy.id, id, spec: config.spec as ResearchSpec,
        assessmentHash: String(row.assessment_hash), assessment, dependencies,
        origin: { run: c.runId, task: c.task.id, artifactHash, evidenceHash, contractHash: digest(this.store.contract()) } };
      const version = digest(body), record = { ...body, version };
      const head = this.store.db.prepare(`SELECT k.* FROM research_knowledge_heads h JOIN research_knowledge k
        ON k.programme=h.programme AND k.id=h.id AND k.version=h.version WHERE h.programme=? AND h.id=?`).get(this.policy.id, id);
      let state = assessment.conflicted ? "CONFLICTED" : "ACTIVE";
      if (head) {
        const old = this.read({ id, version: String(head.version) }, true);
        const contradictory = old.assessment.specHash === assessment.specHash &&
          new Set([old.assessment.outcome, assessment.outcome]).has("SUPPORTED") &&
          new Set([old.assessment.outcome, assessment.outcome]).has("REFUTED");
        this.invalidate(String(head.version));
        if (contradictory || head.state === "CONFLICTED") {
          state = "CONFLICTED";
          this.store.db.prepare("UPDATE research_knowledge SET state='CONFLICTED' WHERE programme=? AND version=?").run(this.policy.id, head.version);
          this.store.db.prepare("INSERT OR IGNORE INTO research_knowledge_conflicts VALUES(?,?,?,?)").run(this.policy.id, id, head.version, version);
        }
        if (head.state === "RETRACTED" && old.assessment.specHash === assessment.specHash) state = "RETRACTED";
      }
      // Superseding a head can invalidate transitive dependencies of this proposal.
      dependencies.forEach(ref => this.read(ref));
      const recordHash = this.store.artifact(json(record));
      this.store.db.prepare("INSERT INTO research_knowledge VALUES(?,?,?,?,?,?)").run(this.policy.id, id, version, recordHash, state, sourceKey);
      this.store.db.prepare("INSERT INTO research_knowledge_heads VALUES(?,?,?) ON CONFLICT(programme,id) DO UPDATE SET version=excluded.version")
        .run(this.policy.id, id, version);
      for (const parent of dependencies) this.store.db.prepare("INSERT INTO research_knowledge_dependencies VALUES(?,?,?)").run(this.policy.id, version, parent.version);
      this.store.event("research.knowledge.published", { programme: this.policy.id, id, version, recordHash, state }, c.runId, c.task.id);
    }
  }
  private invalidate(version: string): void {
    this.store.db.prepare(`WITH RECURSIVE affected(version) AS (SELECT ? UNION
      SELECT d.child FROM research_knowledge_dependencies d JOIN affected a ON d.parent=a.version WHERE d.programme=?)
      UPDATE research_knowledge SET state='STALE' WHERE programme=? AND state='ACTIVE' AND version IN (SELECT version FROM affected)`)
      .run(version, this.policy.id, this.policy.id);
  }
  /** Explicit host/operator revocation; immutable contents and historical receipts are retained. */
  retract(ref: KnowledgeRef, reason: string): void {
    invariant(typeof reason === "string" && reason.trim().length > 0 && reason.length <= 4096, "retraction reason required");
    this.store.transaction(() => {
      this.row(ref); this.invalidate(ref.version);
      this.store.db.prepare("UPDATE research_knowledge SET state='RETRACTED' WHERE programme=? AND id=? AND version=?").run(this.policy.id, ref.id, ref.version);
      this.store.event("research.knowledge.retracted", { programme: this.policy.id, ...ref, reason });
    });
  }
  list(after = "", limit = 20): Json {
    invariant(typeof after === "string" && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, "invalid knowledge page");
    const rows = this.store.db.prepare(`SELECT h.id,h.version,k.state,k.record_hash AS recordHash FROM research_knowledge_heads h
      JOIN research_knowledge k ON k.programme=h.programme AND k.id=h.id AND k.version=h.version
      WHERE h.programme=? AND h.id>? ORDER BY h.id LIMIT ?`).all(this.policy.id, after, limit + 1);
    return json({ programme: this.policy.id, findings: rows.slice(0, limit), hasMore: rows.length > limit,
      nextAfter: rows.length ? rows[Math.min(rows.length, limit) - 1].id : after });
  }
}
