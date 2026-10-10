import { canonical, digest, identifier, invariant } from "../kernel.ts";
import { DeferredAttemptError } from "../continuation.ts";
import type { Store } from "../store.ts";
import type { Capsule, Json } from "../types.ts";
import type { PinnedSwarm } from "./config.ts";
import { SessionJournal } from "./session.ts";
import { readPatchArtifact } from "./workspace.ts";

export interface FindingInput {
  id: string;
  audience: "cohort" | "shared";
  kind: "hypothesis" | "result" | "counterexample";
  summary: string;
  receipts: string[];
}
const json = (value: unknown): Json => JSON.parse(canonical(value));

/** A bounded communication plane. Foundry alone owns readiness and acceptance. */
export class CohortBoard {
  readonly store: Store; readonly cfg: PinnedSwarm; readonly journal: SessionJournal;
  constructor(store: Store, cfg: PinnedSwarm, journal = new SessionJournal(store)) {
    invariant(cfg.spec.coordination, "cohort coordination is not configured");
    this.store = store; this.cfg = cfg; this.journal = journal;
    store.db.exec(`CREATE TABLE IF NOT EXISTS swarm_cohort_leases(
      run TEXT NOT NULL, task TEXT NOT NULL, fence INTEGER NOT NULL,
      cohort TEXT NOT NULL, deadline REAL NOT NULL, PRIMARY KEY(run,task,fence));
      CREATE INDEX IF NOT EXISTS swarm_cohort_capacity ON swarm_cohort_leases(cohort,deadline);
      CREATE INDEX IF NOT EXISTS swarm_cohort_expiry ON swarm_cohort_leases(deadline);
      CREATE TABLE IF NOT EXISTS swarm_cohort_findings(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, task TEXT NOT NULL,
      finding TEXT NOT NULL, cohort TEXT NOT NULL, audience TEXT NOT NULL,
      patch TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE(run,task,finding));
      CREATE INDEX IF NOT EXISTS swarm_cohort_page ON swarm_cohort_findings(run,cohort,seq);
      CREATE INDEX IF NOT EXISTS swarm_cohort_task ON swarm_cohort_findings(run,task,seq);
      CREATE TABLE IF NOT EXISTS swarm_cohort_exports(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, finding_seq INTEGER NOT NULL UNIQUE,
      artifact TEXT NOT NULL, evidence TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS swarm_cohort_shared_page ON swarm_cohort_exports(run,seq);`);
    for (const table of ["swarm_cohort_findings", "swarm_cohort_exports"]) store.db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT,'append-only cohort findings'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT,'append-only cohort findings'); END;`);
  }
  cohort(c: Capsule): string {
    const id = this.cfg.spec.agents[c.task.agent ?? this.cfg.spec.defaultAgent]?.cohort;
    invariant(id && Object.hasOwn(this.cfg.spec.coordination!.cohorts, id), "unassigned task cohort");
    return id;
  }
  /** Extra capacity guard, not a replacement scheduler. Busy work yields its lease. */
  claim(c: Capsule): void {
    const cohort = this.cohort(c); const now = Date.now();
    this.store.transaction(() => {
      this.journal.assertLease(c, now);
      this.store.db.prepare("DELETE FROM swarm_cohort_leases WHERE deadline<=?").run(now);
      const own = this.store.db.prepare("SELECT 1 FROM swarm_cohort_leases WHERE run=? AND task=? AND fence=?")
        .get(c.runId, c.task.id, c.fence);
      if (own) return;
      // Join the authoritative task fence so obsolete, unexpired rows never consume capacity.
      const active = this.store.db.prepare(`SELECT COUNT(*) AS n FROM swarm_cohort_leases l
        JOIN tasks t ON t.run=l.run AND t.id=l.task AND t.fence=l.fence
        WHERE l.cohort=? AND l.deadline>? AND t.status='RUNNING'`).get(cohort, now)!.n;
      if (active >= this.cfg.spec.coordination!.cohorts[cohort]!.maxConcurrent)
        throw new DeferredAttemptError("cohort-capacity", now + 250, `Cohort ${cohort} is busy; execution will resume`);
      const task = this.store.db.prepare("SELECT deadline FROM tasks WHERE run=? AND id=?").get(c.runId, c.task.id)!;
      this.store.db.prepare("INSERT INTO swarm_cohort_leases VALUES(?,?,?,?,?)")
        .run(c.runId, c.task.id, c.fence, cohort, task.deadline);
    });
  }
  release(c: Capsule): void {
    this.store.db.prepare("DELETE FROM swarm_cohort_leases WHERE run=? AND task=? AND fence=?")
      .run(c.runId, c.task.id, c.fence);
  }
  status(run: string): Json {
    const cohorts = Object.entries(this.cfg.spec.coordination!.cohorts).map(([id, policy]) => ({
      id, maxConcurrent: policy.maxConcurrent,
      activeExecutions: Number(this.store.db.prepare(`SELECT COUNT(*) AS n FROM swarm_cohort_leases l
        JOIN tasks t ON t.run=l.run AND t.id=l.task AND t.fence=l.fence
        WHERE l.cohort=? AND l.deadline>? AND t.status='RUNNING'`).get(id, Date.now())!.n),
      runFindings: Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM swarm_cohort_findings WHERE run=? AND cohort=?")
        .get(run, id)!.n),
    }));
    return json({ cohorts, sharedExports: this.store.db.prepare("SELECT COUNT(*) AS n FROM swarm_cohort_exports WHERE run=?").get(run)!.n,
      maxDigestBytes: this.cfg.spec.coordination!.maxDigestBytes, summaryTrust: "UNVERIFIED" });
  }
  publish(c: Capsule, input: FindingInput, patchHash: string | null): Json {
    identifier(input.id); invariant(input.id.length <= 128, "finding id too long");
    invariant(Object.keys(input).every(key => ["id", "audience", "kind", "summary", "receipts"].includes(key)), "unexpected finding authority");
    invariant(["cohort", "shared"].includes(input.audience) &&
      ["hypothesis", "result", "counterexample"].includes(input.kind), "invalid finding category");
    invariant(typeof input.summary === "string" && input.summary.trim().length > 0 &&
      Buffer.byteLength(input.summary) <= 2048, "invalid finding summary bytes");
    invariant(Array.isArray(input.receipts) && input.receipts.length <= 8 && new Set(input.receipts).size === input.receipts.length &&
      input.receipts.every(hash => this.journal.ownsReceipt(c, hash)), "unowned finding receipt");
    const patch = patchHash ?? this.store.artifact(""); this.store.readArtifact(patch);
    const cohort = this.cohort(c);
    const note = json({ ...input, cohort, sourceTask: c.task.id, sourceAgent: c.task.agent ?? this.cfg.spec.defaultAgent,
      summaryTrust: "UNVERIFIED", receiptReferencesGrantAccess: false });
    const hash = this.store.artifact(note);
    return this.store.transaction(() => {
      this.journal.assertLease(c);
      const old = this.store.db.prepare("SELECT seq,hash,patch FROM swarm_cohort_findings WHERE run=? AND task=? AND finding=?")
        .get(c.runId, c.task.id, input.id);
      if (old) {
        invariant(old.hash === hash && old.patch === patch, "finding replay input drift; publish a new id for a new finding");
        return json({ finding: input.id, seq: old.seq, summaryTrust: "UNVERIFIED", replayed: true });
      }
      const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM swarm_cohort_findings WHERE run=? AND task=?")
        .get(c.runId, c.task.id)!.n;
      invariant(count < this.cfg.spec.coordination!.maxFindingsPerTask, "task finding budget exhausted");
      this.store.db.prepare("INSERT INTO swarm_cohort_findings(run,task,finding,cohort,audience,patch,hash) VALUES(?,?,?,?,?,?,?)")
        .run(c.runId, c.task.id, input.id, cohort, input.audience, patch, hash);
      const row = this.store.db.prepare("SELECT seq FROM swarm_cohort_findings WHERE run=? AND task=? AND finding=?")
        .get(c.runId, c.task.id, input.id)!;
      this.store.event("cohort.finding.published", { seq: row.seq, hash, audience: input.audience, cohort }, c.runId, c.task.id);
      return json({ finding: input.id, seq: row.seq, summaryTrust: "UNVERIFIED", sharedAfterAcceptance: input.audience === "shared" });
    });
  }
  /** Called inside the scheduler's acceptance transaction, after immutable checks. */
  accepted(c: Capsule, artifact: Json, artifactHash: string, evidenceHash: string): void {
    const task = this.store.db.prepare("SELECT status,fence,artifact,evidence FROM tasks WHERE run=? AND id=?")
      .get(c.runId, c.task.id);
    invariant(task?.status === "PASS" && task.fence === c.fence && task.artifact === artifactHash &&
      task.evidence === evidenceHash && digest(artifact) === artifactHash, "cohort export requires exact accepted source");
    const patch = (artifact as any)?.patchHash;
    const rows = this.store.db.prepare("SELECT seq,patch FROM swarm_cohort_findings WHERE run=? AND task=? AND audience='shared' ORDER BY seq LIMIT ?")
      .all(c.runId, c.task.id, this.cfg.spec.coordination!.maxFindingsPerTask);
    for (const row of rows) {
      if (row.patch !== patch) continue; // Notes from superseded patches remain local.
      const old = this.store.db.prepare("SELECT artifact,evidence FROM swarm_cohort_exports WHERE finding_seq=?").get(row.seq);
      invariant(!old || old.artifact === artifactHash && old.evidence === evidenceHash, "cohort export binding drift");
      this.store.db.prepare("INSERT OR IGNORE INTO swarm_cohort_exports(run,finding_seq,artifact,evidence) VALUES(?,?,?,?)")
        .run(c.runId, row.seq, artifactHash, evidenceHash);
    }
  }
  read(c: Capsule, audience: "cohort" | "shared", after = 0, limit = 10, contextLimit = this.cfg.spec.recipe.contextBytes): Json {
    this.journal.assertLease(c);
    invariant(["cohort", "shared"].includes(audience) && Number.isSafeInteger(after) && after >= 0 &&
      Number.isSafeInteger(limit) && limit > 0 && limit <= 20, "invalid finding page");
    const cap = Math.min(this.cfg.spec.coordination!.maxDigestBytes, Math.floor(contextLimit / 4));
    invariant(cap >= 1024, "CONTEXT_OVERFLOW: finding metadata needs a larger admitted envelope");
    const rows = audience === "cohort"
      ? this.store.db.prepare("SELECT seq,task,hash FROM swarm_cohort_findings WHERE run=? AND cohort=? AND seq>? ORDER BY seq LIMIT ?")
        .all(c.runId, this.cohort(c), after, limit + 1)
      : this.store.db.prepare(`SELECT e.seq,f.task,f.hash,e.artifact,e.evidence FROM swarm_cohort_exports e
        JOIN swarm_cohort_findings f ON f.seq=e.finding_seq WHERE e.run=? AND e.seq>? ORDER BY e.seq LIMIT ?`)
        .all(c.runId, after, limit + 1);
    const findings: Json[] = []; let cursor = after;
    const page = (next: number, hasMore: boolean) => json({ audience, findings, nextAfter: next, hasMore, summaryTrust: "UNVERIFIED" });
    for (const row of rows.slice(0, limit)) {
      if (audience === "shared") {
        const source = this.store.db.prepare("SELECT status,artifact,evidence FROM tasks WHERE run=? AND id=?").get(c.runId, row.task);
        invariant(source?.status === "PASS" && source.artifact === row.artifact && source.evidence === row.evidence,
          "shared finding source binding drift");
        readPatchArtifact(this.store, c.runId, String(row.task)); // Revalidate proof and content, including the patch.
      }
      const note = this.store.readArtifact(String(row.hash)) as Record<string, Json>;
      const findingReceipt = this.journal.receipt(c, note); // Grant this shared note only, never its private receipt bodies.
      const entry: Record<string, Json> = { ...note, seq: row.seq, findingReceipt,
        sourceAcceptance: audience === "shared" ? "TASK_CHECKS_PASSED" : "NOT_ASSERTED",
        ...(audience === "shared" ? { sourceArtifactHash: row.artifact, sourceEvidenceHash: row.evidence } : {}) };
      findings.push(entry);
      if (Buffer.byteLength(canonical(page(row.seq, true))) > cap) {
        if (findings.length > 1) { findings.pop(); break; }
        // A note preview may shrink. Its complete body remains available by owned receipt.
        entry.summaryTruncated = true;
        while (Buffer.byteLength(canonical(page(row.seq, true))) > cap && (entry.summary as string).length)
          entry.summary = Array.from(entry.summary as string).slice(0, -64).join("");
        invariant(Buffer.byteLength(canonical(page(row.seq, true))) <= cap, "CONTEXT_OVERFLOW: finding metadata exceeds digest budget");
      }
      cursor = Number(row.seq);
    }
    return page(cursor, rows.some(row => Number(row.seq) > cursor));
  }
}
