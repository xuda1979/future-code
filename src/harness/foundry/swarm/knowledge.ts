import { canonical, digest, identifier, invariant, positive } from "../kernel.ts";
import { currentClaim } from "../claims.ts";
import { acceptedDiscriminator } from "../adjudication.ts";
import { ResearchProgramme } from "../researchProgramme.ts";
import type { Store } from "../store.ts";
import type { Capsule, Json } from "../types.ts";
import type { PinnedSwarm } from "./config.ts";
import type { MemoryEntry } from "./memory.ts";

export const KNOWLEDGE_PHASES = ["any", "research", "design", "implementation", "debugging", "validation"] as const;
export type KnowledgePhase = typeof KNOWLEDGE_PHASES[number];
export interface KnowledgeText {
  trigger: string;
  lesson: string;
  /** Conditions belong to the assertion, not just retrieval metadata. */
  conditions: string;
  phase: KnowledgePhase;
  tags: string[];
}
export interface KnowledgePack {
  schema: 1;
  id: string;
  /** Attribution/URI only. Import never fetches a URL or executes source text. */
  source: string;
  entries: (KnowledgeText & { id: string; kind: "reference" | "procedure" | "constraint" })[];
}
export interface KnowledgePolicy {
  namespace: string;
  maxCardsPerTask: number;
  maxContextBytes: number;
  packs?: KnowledgePack[];
}
export interface ExperienceInput extends KnowledgeText {
  id: string;
  kind: "hypothesis" | "procedure" | "constraint";
  receipts: string[];
  /** Must name this task's exact canonical({lesson,conditions}) claim. */
  claimId?: string;
  contradicts?: string[];
}
export interface KnowledgeQuery { query?: string; phase?: KnowledgePhase; after?: number; limit?: number }
interface Origin { run: string; task: string; baseCommit: string; environment: string; patchHash: string }
interface Card extends KnowledgeText {
  schema: 1;
  project: string;
  kind: "seed" | "experience" | "failure" | "transition" | "finding";
  sourceKey: string;
  origin?: Origin;
  evidence: Record<string, any>;
}
const json = (value: unknown): Json => JSON.parse(canonical(value));
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const fields = (v: object, required: string[], optional: string[] = []) => {
  invariant(v && typeof v === "object" && !Array.isArray(v), "invalid knowledge object");
  invariant(required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => [...required, ...optional].includes(k)),
    "unexpected or missing knowledge field");
};
const textFields = ["trigger", "lesson", "conditions", "phase", "tags"];
function text(v: KnowledgeText): void {
  for (const k of ["trigger", "lesson", "conditions"] as const)
    invariant(typeof v[k] === "string" && !!v[k].trim() && Buffer.byteLength(v[k]) <= (k === "lesson" ? 2048 : 512), "knowledge text exceeds byte bound");
  invariant(KNOWLEDGE_PHASES.includes(v.phase), "invalid knowledge phase");
  invariant(Array.isArray(v.tags) && v.tags.length > 0 && v.tags.length <= 12 && new Set(v.tags).size === v.tags.length &&
    v.tags.every(t => typeof t === "string" && /^[\p{L}\p{N}_.\/-]{1,64}$/u.test(t)), "invalid knowledge tags");
}
export function validateKnowledgePack(pack: KnowledgePack): void {
  fields(pack, ["schema", "id", "source", "entries"]); identifier(pack.id);
  invariant(pack.schema === 1 && typeof pack.source === "string" && !!pack.source.trim() && Buffer.byteLength(pack.source) <= 512,
    "invalid knowledge pack source");
  invariant(Array.isArray(pack.entries) && pack.entries.length > 0 && pack.entries.length <= 128 &&
    new Set(pack.entries.map(e => e.id)).size === pack.entries.length, "invalid knowledge pack entries");
  for (const e of pack.entries) {
    fields(e, ["id", "kind", ...textFields]); identifier(e.id); text(e);
    invariant(["reference", "procedure", "constraint"].includes(e.kind), "invalid knowledge seed kind");
  }
  invariant(Buffer.byteLength(canonical(pack)) <= 262144, "knowledge pack exceeds byte bound");
}
export function validateKnowledgePolicy(policy: KnowledgePolicy, contextBytes: number): void {
  fields(policy, ["namespace", "maxCardsPerTask", "maxContextBytes"], ["packs"]); identifier(policy.namespace);
  positive(policy.maxCardsPerTask, 32, "knowledge cards per task");
  positive(policy.maxContextBytes, Math.min(8192, Math.floor(contextBytes / 4)), "knowledge context bytes");
  invariant(policy.maxContextBytes >= 1024, "knowledge context needs at least 1024 bytes");
  if (policy.packs !== undefined) {
    invariant(Array.isArray(policy.packs) && policy.packs.length <= 8, "too many knowledge packs");
    policy.packs.forEach(validateKnowledgePack);
  }
}
/** Literal term index, not an embedding model or a semantic truth detector. */
export function knowledgeTerms(value: string): string[] {
  const words = value.toLowerCase().match(/[\p{L}\p{N}_./-]{2,64}/gu) ?? [];
  return [...new Set(words)].slice(0, 32);
}
const pick = (v: KnowledgeText): KnowledgeText => ({ trigger: v.trigger, lesson: v.lesson, conditions: v.conditions,
  phase: v.phase, tags: v.tags });
export const KNOWLEDGE_NOTICE = "[future-code:project-knowledge-v1]";

/** Optional project-shared learning plane. No new scheduler, background LLM,
 * hidden network request, arbitrary execution, or acceptance authority. */
export class ProjectKnowledge {
  readonly store: Store; readonly cfg: PinnedSwarm; readonly policy: KnowledgePolicy;
  readonly project: string; readonly environment: string;
  readonly programme: ResearchProgramme | null;
  constructor(store: Store, cfg: PinnedSwarm) {
    invariant(cfg.spec.projectKnowledge, "project knowledge not configured");
    this.store = store; this.cfg = cfg; this.policy = cfg.spec.projectKnowledge;
    validateKnowledgePolicy(this.policy, cfg.spec.recipe.contextBytes);
    this.project = digest({ namespace: this.policy.namespace, project: cfg.spec.project });
    this.environment = digest({ checks: cfg.checks, jobs: cfg.jobAdapters ?? {}, validators: cfg.experimentValidators ?? {} });
    this.programme = cfg.spec.researchProgramme ? new ResearchProgramme(store, cfg.spec.researchProgramme) : null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS project_knowledge_cards(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, id TEXT NOT NULL,
      source_key TEXT NOT NULL, kind TEXT NOT NULL, phase TEXT NOT NULL, run TEXT, task TEXT,
      UNIQUE(project,id), UNIQUE(project,source_key));
      CREATE INDEX IF NOT EXISTS project_knowledge_task ON project_knowledge_cards(project,run,task,kind,seq);
      CREATE INDEX IF NOT EXISTS project_knowledge_phase ON project_knowledge_cards(project,phase,seq);
      CREATE TABLE IF NOT EXISTS project_knowledge_terms(project TEXT NOT NULL, term TEXT NOT NULL, card TEXT NOT NULL,
        PRIMARY KEY(project,term,card));
      CREATE TABLE IF NOT EXISTS project_knowledge_exports(project TEXT NOT NULL, card TEXT NOT NULL,
        artifact TEXT NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY(project,card));
      CREATE TABLE IF NOT EXISTS project_knowledge_links(project TEXT NOT NULL, card TEXT NOT NULL,
        target TEXT NOT NULL, PRIMARY KEY(project,card,target));
      CREATE INDEX IF NOT EXISTS project_knowledge_link_target ON project_knowledge_links(project,target);
      CREATE TABLE IF NOT EXISTS project_knowledge_retirements(project TEXT NOT NULL, card TEXT NOT NULL,
        reason TEXT NOT NULL, PRIMARY KEY(project,card));
      CREATE TABLE IF NOT EXISTS project_knowledge_uses(project TEXT NOT NULL, run TEXT NOT NULL, task TEXT NOT NULL,
        card TEXT NOT NULL, PRIMARY KEY(project,run,task,card));`);
    for (const table of ["project_knowledge_cards", "project_knowledge_exports", "project_knowledge_links", "project_knowledge_retirements"])
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT,'append-only project knowledge'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT,'append-only project knowledge'); END;`);
  }
  private origin(c: Capsule, patchHash: string | null): Origin {
    return { run: c.runId, task: c.task.id, baseCommit: this.cfg.baseCommit,
      environment: this.environment, patchHash: patchHash ?? digest("") };
  }
  private insert(card: Card): string {
    const id = digest(card);
    const old = this.store.db.prepare("SELECT id FROM project_knowledge_cards WHERE project=? AND source_key=?").get(this.project, card.sourceKey);
    if (old) { invariant(old.id === id, "knowledge replay input drift; use a new id"); return id; }
    invariant(card.project === this.project, "knowledge project mismatch");
    this.store.artifact(json(card));
    this.store.db.prepare("INSERT INTO project_knowledge_cards(project,id,source_key,kind,phase,run,task) VALUES(?,?,?,?,?,?,?)")
      .run(this.project, id, card.sourceKey, card.kind, card.phase, card.origin?.run ?? null, card.origin?.task ?? null);
    for (const term of knowledgeTerms([...card.tags, card.trigger].join(" ")))
      this.store.db.prepare("INSERT OR IGNORE INTO project_knowledge_terms VALUES(?,?,?)").run(this.project, term, id);
    this.store.event("project.knowledge.recorded", { project: this.project, id, kind: card.kind }, card.origin?.run, card.origin?.task);
    return id;
  }
  private count(c: Capsule, kind: Card["kind"]): number {
    return Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM project_knowledge_cards WHERE project=? AND run=? AND task=? AND kind=?")
      .get(this.project, c.runId, c.task.id, kind)!.n);
  }
  private assertLease(c: Capsule): void {
    const task = this.store.db.prepare("SELECT status,fence,deadline FROM tasks WHERE run=? AND id=?").get(c.runId, c.task.id);
    const run = this.store.db.prepare("SELECT recipe,contract FROM runs WHERE id=?").get(c.runId);
    invariant(task?.status === "RUNNING" && task.fence === c.fence && task.deadline > Date.now() &&
      run?.recipe === c.recipeHash && run?.contract === c.contractHash, "stale knowledge lease");
  }
  /** Packs are content-versioned. A changed seed never silently overwrites history. */
  importPack(pack: KnowledgePack): Json {
    validateKnowledgePack(pack);
    const version = digest(pack);
    return this.store.transaction(() => {
      this.store.artifact(json(pack));
      const ids = pack.entries.map(e => this.insert({ schema: 1, project: this.project, kind: "seed",
        sourceKey: `pack:${version}:${e.id}`, ...pick(e), evidence: { pack: version, entry: e.id, source: pack.source,
          seedKind: e.kind, rootCause: null } }));
      return { pack: pack.id, version, ids, trust: "EXPERT_SEED_UNVERIFIED" };
    });
  }
  /** Runs in the journal checkpoint transaction. Only host-created diagnostic
   * fixtures enter the negative ledger; prose summaries are never parsed as facts. */
  observe(c: Capsule, seq: number, memory: MemoryEntry[]): void {
    for (let ordinal = 0; ordinal < memory.length; ordinal++) {
      const e = memory[ordinal]; if (e.kind !== "failure") continue;
      const sourceKey = `failure:${c.runId}:${c.task.id}:${e.receipt}`;
      if (this.store.db.prepare("SELECT 1 FROM project_knowledge_cards WHERE project=? AND source_key=?").get(this.project, sourceKey)) continue;
      if (this.count(c, "failure") >= this.policy.maxCardsPerTask) break;
      const fixture: any = this.store.readArtifact(e.receipt);
      invariant(fixture.kind === "diagnostic-regression-fixture" && fixture.run === c.runId && fixture.task === c.task.id &&
        fixture.patchReceipt === e.patchHash, "knowledge failure fixture binding mismatch");
      const call: any = this.store.readArtifact(fixture.callReceipt);
      // No raw stderr, private transcript or unconstrained parameter payload is
      // copied to project-shared context. Original evidence remains task-owned.
      const name = typeof call.arguments?.name === "string" ? call.arguments.name.slice(0, 128) : call.tool;
      this.insert({ schema: 1, project: this.project, kind: "failure", sourceKey,
        origin: this.origin(c, e.patchHash), trigger: `${call.tool} ${name}`, phase: "debugging",
        tags: knowledgeTerms(`${name} ${c.task.writeScope.join(" ")}`).slice(0, 12),
        lesson: "The host observed a failed operation on these exact inputs. Reproduce before generalizing or excluding a research path.",
        conditions: "Historical input identity only; a crash or tool error does not falsify a scientific hypothesis.",
        evidence: { eventSeq: seq, ordinal, fixture: e.receipt, inputKey: e.inputKey, failureSignature: e.failureSignature,
          tool: call.tool, name, rootCause: null } });
    }
  }
  record(c: Capsule, input: ExperienceInput, patchHash: string | null): Json {
    fields(input, ["id", "kind", ...textFields, "receipts"], ["claimId", "contradicts"]); identifier(input.id); text(input);
    invariant(["hypothesis", "procedure", "constraint"].includes(input.kind), "invalid experience kind");
    invariant(Array.isArray(input.receipts) && input.receipts.length <= 8 && new Set(input.receipts).size === input.receipts.length &&
      input.receipts.every(h => hash(h) && this.store.db.prepare("SELECT 1 FROM agent_receipts WHERE run=? AND task=? AND hash=?")
        .get(c.runId, c.task.id, h)), "unowned experience receipt");
    input.receipts.forEach(h => this.store.readArtifact(h));
    invariant(input.contradicts === undefined || (Array.isArray(input.contradicts) && input.contradicts.length <= 4 &&
      new Set(input.contradicts).size === input.contradicts.length && input.contradicts.every(hash)), "invalid knowledge contradiction references");
    return this.store.transaction(() => {
      this.assertLease(c);
      const sourceKey = `experience:${c.runId}:${c.task.id}:${input.id}`;
      const old = this.store.db.prepare("SELECT id FROM project_knowledge_cards WHERE project=? AND source_key=?").get(this.project, sourceKey);
      if (old) {
        const saved = this.store.readArtifact(String(old.id)) as unknown as Card;
        invariant(saved.evidence.inputHash === digest(input) && saved.origin?.patchHash === (patchHash ?? digest("")), "knowledge replay input drift; use a new id");
        return { id: String(old.id), trust: "UNVERIFIED_EXPERIENCE", sharedAfterExactSourceAcceptance: true };
      }
      invariant(this.count(c, "experience") < this.policy.maxCardsPerTask, "experience card budget exhausted");
      let claim: any = null;
      if (input.claimId !== undefined) {
        identifier(input.claimId); const current = currentClaim(this.store, c.runId, input.claimId);
        invariant(current?.goal === c.task.id && current.statement === canonical({ lesson: input.lesson, conditions: input.conditions }),
          "experience claim must bind the exact lesson and conditions of this task");
        claim = { id: current.id, version: current.version, statementHash: current.statementHash, dependenciesHash: digest(current.dependencies) };
      }
      for (const id of input.contradicts ?? []) invariant(this.visible(c, id), "unknown or private contradiction target");
      const card: Card = { schema: 1, project: this.project, kind: "experience", sourceKey,
        origin: this.origin(c, patchHash), ...pick(input), evidence: { receipts: input.receipts, inputHash: digest(input),
          experienceKind: input.kind, claim, contradicts: input.contradicts ?? [], rootCause: null } };
      const id = this.insert(card);
      for (const target of input.contradicts ?? []) this.store.db.prepare("INSERT OR IGNORE INTO project_knowledge_links VALUES(?,?,?)")
        .run(this.project, id, target);
      return { id, trust: "UNVERIFIED_EXPERIENCE", sharedAfterExactSourceAcceptance: true };
    });
  }
  private visible(c: Capsule | undefined, id: string): any {
    return this.store.db.prepare(`SELECT k.*,x.artifact,x.evidence FROM project_knowledge_cards k
      LEFT JOIN project_knowledge_exports x ON x.project=k.project AND x.card=k.id
      WHERE k.project=? AND k.id=? AND (k.kind!='experience' OR x.card IS NOT NULL OR (k.run=? AND k.task=?))`)
      .get(this.project, id, c?.runId ?? "", c?.task.id ?? "");
  }
  private checkedSource(card: Card, row: any): void {
    invariant(card.origin && row.artifact && row.evidence, "knowledge missing accepted source");
    const evidence = this.store.db.prepare(`SELECT id FROM fabric_evidence WHERE run=? AND task=? AND evidence_hash=?
      AND source='foundry-independent-verifier' AND kind='independent-verification'`)
      .get(card.origin.run, card.origin.task, row.evidence);
    invariant(evidence, "knowledge missing independent evidence");
    const accepted = acceptedDiscriminator(this.store, card.origin.run, String(evidence.id));
    invariant(accepted.artifactHash === row.artifact && accepted.evidenceHash === row.evidence &&
      accepted.artifact.patchHash === card.origin.patchHash, "knowledge source patch or evidence changed");
    this.store.readArtifact(card.origin.patchHash);
  }
  private read(row: any): Card {
    const card = this.store.readArtifact(String(row.id)) as unknown as Card;
    invariant(card.project === this.project && card.kind === row.kind && card.phase === row.phase && card.sourceKey === row.source_key &&
      (card.origin?.run ?? null) === row.run && (card.origin?.task ?? null) === row.task, "knowledge index differs from source");
    if (card.kind === "seed") {
      const pack = this.store.readArtifact(card.evidence.pack) as unknown as KnowledgePack;
      const entry = pack.entries.find(e => e.id === card.evidence.entry);
      invariant(entry && canonical(pick(entry)) === canonical(pick(card)), "knowledge pack binding mismatch");
    } else if (card.kind === "failure") {
      const event = this.store.db.prepare("SELECT payload FROM agent_events WHERE run=? AND task=? AND seq=?")
        .get(card.origin!.run, card.origin!.task, card.evidence.eventSeq);
      invariant(event, "knowledge failure source missing");
      const payload: any = this.store.readArtifact(String(event.payload));
      const memory = payload.memory?.[card.evidence.ordinal];
      invariant(memory?.kind === "failure" && memory.receipt === card.evidence.fixture && memory.patchHash === card.origin!.patchHash,
        "knowledge failure differs from source event");
      this.store.readArtifact(card.evidence.fixture);
    }
    if (row.artifact) this.checkedSource(card, row);
    if (card.kind === "finding") {
      invariant(this.programme, "knowledge research programme missing");
      const finding = this.programme.read(card.evidence.finding, true);
      invariant(finding.origin.run === card.origin!.run && finding.origin.task === card.origin!.task &&
        finding.assessmentHash === card.evidence.assessmentHash, "knowledge scientific finding changed");
    }
    return card;
  }
  /** Called INSIDE scheduler acceptance. A checked transition records only the
   * before/after observation, never an inferred cause or an ablation claim. */
  accepted(c: Capsule, artifact: Json, artifactHash: string, evidenceHash: string): void {
    const patch = (artifact as any)?.patchHash;
    const source = this.store.db.prepare("SELECT status,fence,artifact,evidence FROM tasks WHERE run=? AND id=?").get(c.runId, c.task.id);
    invariant(source?.status === "PASS" && source.fence === c.fence && source.artifact === artifactHash && source.evidence === evidenceHash &&
      digest(artifact) === artifactHash && hash(patch), "knowledge export requires exact acceptance");
    const proof: any = this.store.readArtifact(evidenceHash);
    const behavior = proof.verification?.checks?.find((x: any) => x.id === "behavior" && x.verdict === "PASS");
    const reports: any = hash(behavior?.detail) ? this.store.readArtifact(behavior.detail) : [];
    const rows = this.store.db.prepare("SELECT * FROM project_knowledge_cards WHERE project=? AND run=? AND task=? AND kind IN ('failure','experience') ORDER BY seq LIMIT ?")
      .all(this.project, c.runId, c.task.id, this.policy.maxCardsPerTask * 2);
    for (const row of rows) {
      const card = this.read(row);
      let id = String(row.id);
      if (card.kind === "experience") { if (card.origin!.patchHash !== patch) continue; }
      else {
        if (card.evidence.tool !== "run_check" || card.origin!.patchHash === patch || !Array.isArray(reports) ||
          !reports.some(r => r.name === card.evidence.name && r.code === 0 && !r.error)) continue;
        id = this.insert({ ...pick(card), schema: 1, project: this.project, kind: "transition", phase: "implementation",
          sourceKey: `transition:${row.id}:${artifactHash}`, origin: this.origin(c, patch),
          lesson: `Check ${card.evidence.name} failed on a historical input; the accepted patch passed the same named independent check. Inspect the delta and revalidate its applicability.`,
          conditions: "Observed transition only. The root cause, causal contribution and generality have not been established.",
          evidence: { failure: row.id, beforePatch: card.origin!.patchHash, rootCause: null } });
      }
      const old = this.store.db.prepare("SELECT artifact,evidence FROM project_knowledge_exports WHERE project=? AND card=?").get(this.project, id);
      invariant(!old || old.artifact === artifactHash && old.evidence === evidenceHash, "knowledge export drift");
      this.store.db.prepare("INSERT OR IGNORE INTO project_knowledge_exports VALUES(?,?,?,?)").run(this.project, id, artifactHash, evidenceHash);
    }
    // Reference the existing scientific knowledge lifecycle. Never duplicate its
    // validator, conflict resolution, dependency graph or truth decisions.
    if (this.programme) {
      const assessments = this.store.db.prepare("SELECT template,job_key FROM research_assessments WHERE run=? AND task=? ORDER BY template,job_key LIMIT ?")
        .all(c.runId, c.task.id, this.policy.maxCardsPerTask);
      for (const assessment of assessments) {
        const key = digest({ run: c.runId, task: c.task.id, template: assessment.template, job: assessment.job_key });
        const row = this.store.db.prepare("SELECT id,version FROM research_knowledge WHERE programme=? AND source_key=?").get(this.programme.policy.id, key);
        invariant(row, "knowledge scientific publication missing");
        const ref = { id: String(row.id), version: String(row.version) }, finding = this.programme.read(ref, true);
        const id = this.insert({ schema: 1, project: this.project, kind: "finding", sourceKey: `finding:${ref.version}`,
          origin: this.origin(c, patch), phase: "any", trigger: `research ${row.id}`,
          tags: knowledgeTerms(`${row.id} ${c.task.writeScope.join(" ")}`).slice(0, 12),
          lesson: `Independent scientific assessment: ${finding.assessment.outcome}. Consult the exact protocol and assumptions before reuse.`,
          conditions: "Applies only to the referenced protocol, evidence and declared code/data/environment. A checked observation is not a general domain rule.",
          evidence: { finding: ref, assessmentHash: finding.assessmentHash, rootCause: null } });
        this.store.db.prepare("INSERT OR IGNORE INTO project_knowledge_exports VALUES(?,?,?,?)").run(this.project, id, artifactHash, evidenceHash);
      }
    }
  }
  private trust(card: Card, row: any): string {
    if (card.kind === "seed") return "EXPERT_SEED_UNVERIFIED";
    if (card.kind === "failure") return "OBSERVED_FAILURE_NOT_FALSIFICATION";
    if (card.kind === "transition") return "CHECKED_TRANSITION_NOT_CAUSAL_PROOF";
    if (card.kind === "finding") {
      try { this.programme!.read(card.evidence.finding); }
      catch { return "STALE_OR_CONFLICTED_FINDING_REVALIDATE"; }
      return "CHECKED_SCIENTIFIC_OBSERVATION_WITH_ASSUMPTIONS";
    }
    const binding = card.evidence.claim;
    if (binding) {
      const claim = currentClaim(this.store, card.origin!.run, binding.id);
      if (!claim || claim.statementHash !== binding.statementHash || digest(claim.dependencies) !== binding.dependenciesHash ||
        ["STALE", "RETRACTED"].includes(claim.status)) return "STALE_CLAIM_REVALIDATE";
      if (claim.status === "REFUTED") return "REFUTED_CLAIM";
      if (claim.status === "SUPPORTED") {
        const record = this.store.db.prepare("SELECT evidence_id FROM fabric_adjudications WHERE run=? AND subject=?")
          .get(card.origin!.run, `claim:${claim.id}:${claim.version - 1}`);
        invariant(record, "supported knowledge requires an independent adjudication");
        const discriminator = acceptedDiscriminator(this.store, card.origin!.run, String(record.evidence_id));
        invariant(discriminator.checks.some(x => x.id === "claim-adjudication" && x.verdict === "PASS") &&
          discriminator.artifact?.claimJudgment?.statementHash === binding.statementHash &&
          discriminator.artifact?.claimJudgment?.verdict === "SUPPORTED", "knowledge claim adjudication mismatch");
        return "VALIDATED_CLAIM_WITH_CONDITIONS";
      }
    }
    return row.artifact ? "UNVERIFIED_LESSON_ACCEPTED_SOURCE" : "UNVERIFIED_LOCAL_HYPOTHESIS";
  }
  /** Indexed candidates + keyset paging; each returned card is authenticated.
   * Project sharing grants the card, never its originating private receipts. */
  search(c: Capsule | undefined, query: KnowledgeQuery = {}, maxBytes = this.policy.maxContextBytes): Json {
    if (c) this.assertLease(c);
    fields(query, [], ["query", "phase", "after", "limit"]);
    invariant(query.query === undefined || (typeof query.query === "string" && Buffer.byteLength(query.query) <= 2048), "invalid knowledge query");
    const phase = query.phase ?? "any", after = query.after ?? 0, limit = query.limit ?? 5;
    invariant(KNOWLEDGE_PHASES.includes(phase) && Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 10,
      "invalid knowledge page");
    invariant(Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= this.policy.maxContextBytes, "invalid knowledge context budget");
    const terms = knowledgeTerms(query.query ?? ""), args: any[] = [this.project, after || Number.MAX_SAFE_INTEGER, c?.runId ?? "", c?.task.id ?? ""];
    let where = "";
    if (phase !== "any") { where += " AND k.phase IN ('any',?)"; args.push(phase); }
    if (terms.length) {
      where += ` AND k.id IN (SELECT card FROM project_knowledge_terms WHERE project=? AND term IN (${terms.map(() => "?").join(",")}))`;
      args.push(this.project, ...terms);
    }
    const rows = this.store.db.prepare(`SELECT k.*,x.artifact,x.evidence FROM project_knowledge_cards k
      LEFT JOIN project_knowledge_exports x ON x.project=k.project AND x.card=k.id
      WHERE k.project=? AND k.seq<? AND (k.kind!='experience' OR x.card IS NOT NULL OR (k.run=? AND k.task=?))
      AND NOT EXISTS(SELECT 1 FROM project_knowledge_retirements r WHERE r.project=k.project AND r.card=k.id)
      ${where} ORDER BY k.seq DESC LIMIT ?`).all(...args, limit + 1);
    const items: any[] = []; let cursor = after;
    const page = (hasMore: boolean) => ({ project: this.policy.namespace, authority: "ADVICE_ONLY_REVALIDATE_BEFORE_USE",
      items, nextAfter: cursor, hasMore });
    for (const row of rows.slice(0, limit)) {
      const card = this.read(row);
      invariant(!terms.length || knowledgeTerms([...card.tags, card.trigger].join(" ")).some(t => terms.includes(t)),
        "knowledge term index differs from source");
      const links = this.store.db.prepare(`SELECT card,target FROM project_knowledge_links WHERE project=? AND (card=? OR target=?) LIMIT 5`)
        .all(this.project, row.id, row.id).filter(l => this.visible(c, String(l.card)) && this.visible(c, String(l.target)));
      const item: any = { id: row.id, kind: card.kind, ...pick(card), trust: this.trust(card, row),
        applicability: card.origin ? (card.origin.baseCommit === this.cfg.baseCommit && card.origin.environment === this.environment
          ? "MATCHING_BASE_AND_CHECKS_STILL_REVALIDATE" : "HISTORICAL_ENVIRONMENT_REVALIDATE") : "DECLARED_CONDITIONS_ONLY",
        ...(links.length ? { contradictions: links.map(l => l.card === row.id ? l.target : l.card), contested: true } : {}),
        evidenceAccess: "REFERENCES_DO_NOT_GRANT_SOURCE_RECEIPT_ACCESS" };
      items.push(item); const previous = cursor; cursor = Number(row.seq);
      if (Buffer.byteLength(canonical(page(true))) > maxBytes) {
        items.pop(); cursor = previous;
        if (items.length) break;
        // Keep all trust labels and the exact card reference in a small envelope.
        delete item.trigger; delete item.lesson; delete item.conditions; delete item.tags;
        item.previewOmitted = true; items.push(item); cursor = Number(row.seq);
        invariant(Buffer.byteLength(canonical(page(true))) <= maxBytes, "knowledge metadata exceeds context bound");
      }
    }
    if (c) for (const item of items) this.store.db.prepare("INSERT OR IGNORE INTO project_knowledge_uses VALUES(?,?,?,?)")
      .run(this.project, c.runId, c.task.id, item.id);
    return json(page(rows.some(row => Number(row.seq) < cursor)));
  }
  /** Full card, not source logs, can become an owned recall receipt. */
  get(c: Capsule | undefined, id: string): Json {
    if (c) this.assertLease(c);
    invariant(hash(id), "invalid knowledge id"); const row = this.visible(c, id); invariant(row, "unknown or private knowledge card");
    const card = this.read(row);
    const retirement = this.store.db.prepare("SELECT reason FROM project_knowledge_retirements WHERE project=? AND card=?").get(this.project, id);
    return json({ id, ...card, trust: retirement ? "DEPRECATED" : this.trust(card, row),
      ...(card.kind === "finding" ? { finding: this.programme!.read(card.evidence.finding, true) } : {}),
      ...(retirement ? { reason: retirement.reason } : {}), authority: "ADVICE_ONLY_REVALIDATE_BEFORE_USE" });
  }
  /** Portable procedures/references are seeds on import, never automatically
   * trusted global rules. Source card IDs retain their evidence lineage. */
  exportPack(id: string, ids: string[]): KnowledgePack {
    identifier(id);
    invariant(Array.isArray(ids) && ids.length > 0 && ids.length <= 32 && new Set(ids).size === ids.length, "invalid knowledge export selection");
    const entries = ids.map(key => {
      const card = this.get(undefined, key) as any;
      invariant(card.trust !== "DEPRECATED" && card.kind !== "failure", "export an active procedure or reference, not raw failures");
      return { id: `card-${key}`, kind: "reference" as const, ...pick(card) };
    });
    const result: KnowledgePack = { schema: 1, id, source: `future-code:project:${this.project}; entry ids identify source cards; revalidate after import`, entries };
    validateKnowledgePack(result); return result;
  }
  retire(id: string, reason: string): void {
    invariant(hash(id) && typeof reason === "string" && !!reason.trim() && Buffer.byteLength(reason) <= 1024, "invalid knowledge retirement");
    this.store.transaction(() => {
      invariant(this.visible(undefined, id), "unknown or private knowledge card");
      const old = this.store.db.prepare("SELECT reason FROM project_knowledge_retirements WHERE project=? AND card=?").get(this.project, id);
      invariant(!old || old.reason === reason, "knowledge retirement replay drift");
      this.store.db.prepare("INSERT OR IGNORE INTO project_knowledge_retirements VALUES(?,?,?)").run(this.project, id, reason);
      if (!old) this.store.event("project.knowledge.retired", { project: this.project, id, reason });
    });
  }
}
