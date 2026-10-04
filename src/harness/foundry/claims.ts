import { canonical, digest, identifier, invariant } from "./kernel.ts";
import { acceptedDiscriminator, recordAdjudication } from "./adjudication.ts";
import type { Store } from "./store.ts";
import type { Json, Task } from "./types.ts";
import { admittedProposal } from "./proposals.ts";

export type ClaimStatus = "PROPOSED" | "SUPPORTED" | "REFUTED" | "RETRACTED" | "STALE";
export interface ClaimInput { id: string; statement: string; evidenceIds: string[]; dependencies: string[]; expectedVersion?: number }
export interface Claim {
  run: string; id: string; goal: string; version: number; statement: string; statementHash: string;
  status: ClaimStatus; evidenceIds: string[]; dependencies: { id: string; version: number }[];
  reason: string; proposalId: string | null;
}
export interface ClaimConflict { id: string; run: string; goal: string; leftClaim: string; rightClaim: string; status: "OPEN" | "RESOLVED" }

export function installClaimTables(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS fabric_claim_versions(
    run TEXT NOT NULL, claim TEXT NOT NULL, version INTEGER NOT NULL, goal TEXT NOT NULL,
    status TEXT NOT NULL, hash TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(run,claim,version));
    CREATE INDEX IF NOT EXISTS fabric_claims_goal ON fabric_claim_versions(run,goal,claim,version);
    CREATE TABLE IF NOT EXISTS fabric_claim_requests(
      run TEXT NOT NULL, goal TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      claim TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(run,goal,request_key));
    CREATE TABLE IF NOT EXISTS fabric_claim_dependencies(
      run TEXT NOT NULL, claim TEXT NOT NULL, version INTEGER NOT NULL, dependency TEXT NOT NULL,
      dependency_version INTEGER NOT NULL, PRIMARY KEY(run,claim,version,dependency));
    CREATE INDEX IF NOT EXISTS fabric_claim_dependents ON fabric_claim_dependencies(run,dependency,claim);
    CREATE TABLE IF NOT EXISTS fabric_claim_conflicts(
      id TEXT PRIMARY KEY, run TEXT NOT NULL, goal TEXT NOT NULL, left_claim TEXT NOT NULL,
      right_claim TEXT NOT NULL, left_version INTEGER NOT NULL, right_version INTEGER NOT NULL,
      status TEXT NOT NULL, proposal TEXT NOT NULL, created REAL NOT NULL, resolution_evidence TEXT);
    CREATE INDEX IF NOT EXISTS fabric_claim_conflicts_run ON fabric_claim_conflicts(run,status);
    CREATE TABLE IF NOT EXISTS fabric_adjudications(
      id TEXT PRIMARY KEY, run TEXT NOT NULL, subject TEXT NOT NULL, task TEXT NOT NULL,
      evidence_id TEXT NOT NULL, artifact_hash TEXT NOT NULL, created REAL NOT NULL);`);
  for (const table of ["fabric_claim_versions", "fabric_claim_dependencies", "fabric_claim_requests", "fabric_adjudications"]) store.db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'append-only claim history'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'append-only claim history'); END;`);
}

export function currentClaim(store: Store, run: string, id: string): Claim | null {
  const row = store.db.prepare("SELECT hash FROM fabric_claim_versions WHERE run=? AND claim=? ORDER BY version DESC LIMIT 1").get(run, id);
  return row ? store.readArtifact(String(row.hash)) as unknown as Claim : null;
}

function append(store: Store, claim: Claim, now: number): void {
  const hash = store.artifact(JSON.parse(canonical(claim)) as Json);
  store.db.prepare("INSERT INTO fabric_claim_versions VALUES(?,?,?,?,?,?,?)")
    .run(claim.run, claim.id, claim.version, claim.goal, claim.status, hash, now);
  for (const dependency of claim.dependencies) store.db.prepare("INSERT INTO fabric_claim_dependencies VALUES(?,?,?,?,?)")
    .run(claim.run, claim.id, claim.version, dependency.id, dependency.version);
  store.event("fabric.claim.versioned", { id: claim.id, version: claim.version, status: claim.status, hash }, claim.run, claim.goal);
}

function invalidateDependents(store: Store, run: string, id: string, now: number): void {
  const queue = [id], seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const dependency = queue[i];
    if (seen.has(dependency)) continue; seen.add(dependency);
    const rows = store.db.prepare(`SELECT DISTINCT d.claim FROM fabric_claim_dependencies d
      WHERE d.run=? AND d.dependency=? AND d.version=(SELECT MAX(v.version) FROM fabric_claim_versions v
        WHERE v.run=d.run AND v.claim=d.claim)`).all(run, dependency);
    for (const row of rows) {
      const claim = currentClaim(store, run, String(row.claim))!;
      if (["RETRACTED", "REFUTED", "STALE"].includes(claim.status)) continue;
      append(store, { ...claim, version: claim.version + 1, status: "STALE", proposalId: null,
        reason: `dependency ${dependency} changed; revalidation required` }, now);
      queue.push(claim.id);
    }
  }
}

function assertNoCycle(store: Store, run: string, id: string, dependencies: string[]): void {
  const queue = [...dependencies], seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const next = queue[i]; invariant(next !== id, "claim dependency cycle");
    if (seen.has(next)) continue; seen.add(next);
    const claim = currentClaim(store, run, next); invariant(claim, "unknown claim dependency");
    queue.push(...claim.dependencies.map(dep => dep.id));
  }
}

/** Model-supplied evidence REFERENCES do not make its conclusion true. */
export function proposeClaim(store: Store, run: string, goal: string, input: ClaimInput,
  proposalId: string, now = Date.now()): Claim {
  identifier(input.id);
  invariant(Object.keys(input).every(key => ["id", "statement", "evidenceIds", "dependencies", "expectedVersion"].includes(key)), "unexpected claim authority field");
  invariant(typeof input.statement === "string" && input.statement.trim().length > 0 && Buffer.byteLength(input.statement) <= 4096, "invalid claim statement");
  for (const ids of [input.evidenceIds, input.dependencies]) invariant(Array.isArray(ids) && ids.length <= 32 &&
    ids.every(id => typeof id === "string") && new Set(ids).size === ids.length, "invalid claim references");
  const task = store.db.prepare("SELECT spec FROM tasks WHERE run=? AND id=?").get(run, goal);
  invariant(task, "unknown claim goal");
  const readable = new Set([goal, ...JSON.parse(task.spec).dependencies]);
  return store.transaction(() => {
    const proposal = admittedProposal(store, proposalId, "CLAIM", run, goal);
    const payload = proposal.payload.arguments ?? proposal.payload;
    invariant(digest(payload) === digest(input), "claim payload differs from admitted proposal");
    const requestKey = digest({ source: proposal.source, callId: proposal.payload.id, expectedVersion: input.expectedVersion ?? 0 });
    const requestHash = digest(input);
    const replay = store.db.prepare("SELECT claim,version,request_hash FROM fabric_claim_requests WHERE run=? AND goal=? AND request_key=?")
      .get(run, goal, requestKey);
    if (replay) {
      invariant(replay.request_hash === requestHash, "claim replay input drift");
      const row = store.db.prepare("SELECT hash FROM fabric_claim_versions WHERE run=? AND claim=? AND version=?").get(run, replay.claim, replay.version);
      invariant(row, "claim replay version missing");
      return store.readArtifact(String(row.hash)) as unknown as Claim;
    }
    const old = currentClaim(store, run, input.id);
    invariant((input.expectedVersion ?? 0) === (old?.version ?? 0), "stale claim version");
    invariant(!old || old.goal === goal, "claim ownership mismatch");
    if (!old) invariant(Number(store.db.prepare("SELECT COUNT(DISTINCT claim) AS n FROM fabric_claim_versions WHERE run=? AND goal=?").get(run, goal)?.n ?? 0) < 32, "claim count limit");
    if (old) invariant(old.version < 128, "claim version limit");
    for (const id of input.evidenceIds) {
      const row = store.db.prepare("SELECT run,goal,artifact_hash,evidence_hash FROM fabric_evidence WHERE id=?").get(id);
      invariant(row?.run === run && readable.has(row.goal), "claim evidence outside task authority");
      if (row.artifact_hash) store.readArtifact(String(row.artifact_hash));
      if (row.evidence_hash) store.readArtifact(String(row.evidence_hash));
    }
    assertNoCycle(store, run, input.id, input.dependencies);
    const dependencies = input.dependencies.map(id => {
      const claim = currentClaim(store, run, id)!;
      invariant(readable.has(claim.goal) && !["STALE", "RETRACTED", "REFUTED"].includes(claim.status), "unusable claim dependency");
      return { id, version: claim.version };
    });
    const claim: Claim = { run, id: input.id, goal, version: (old?.version ?? 0) + 1,
      statement: input.statement, statementHash: digest(input.statement), status: old && ["SUPPORTED", "STALE"].includes(old.status) ? "STALE" : "PROPOSED",
      evidenceIds: input.evidenceIds, dependencies, reason: "model hypothesis; independent adjudication required", proposalId };
    append(store, claim, now);
    store.db.prepare("INSERT INTO fabric_claim_requests VALUES(?,?,?,?,?,?)").run(run, goal, requestKey, requestHash, claim.id, claim.version);
    if (old) invalidateDependents(store, run, claim.id, now);
    return claim;
  });
}

export function retractClaim(store: Store, run: string, id: string, expectedVersion: number,
  reason: string, now = Date.now()): Claim {
  invariant(typeof reason === "string" && reason.trim().length > 0 && Buffer.byteLength(reason) <= 4096, "retraction requires a reason");
  return store.transaction(() => {
    const claim = currentClaim(store, run, id); invariant(claim?.version === expectedVersion, "stale claim version");
    const next: Claim = { ...claim, version: claim.version + 1, status: "RETRACTED", reason, proposalId: null };
    append(store, next, now); invalidateDependents(store, run, id, now); return next;
  });
}

export function adjudicateClaim(store: Store, run: string, id: string, version: number,
  evidenceId: string, now = Date.now()): Claim {
  return store.transaction(() => {
    const claim = currentClaim(store, run, id); invariant(claim?.version === version, "stale claim adjudication");
    const discriminator = acceptedDiscriminator(store, run, evidenceId);
    invariant(discriminator.checks.some(check => check.id === "claim-adjudication" && check.verdict === "PASS"), "missing claim-adjudication check");
    const judgment = discriminator.artifact?.claimJudgment;
    invariant(judgment?.claimId === id && judgment.version === version && judgment.statementHash === claim.statementHash &&
      ["SUPPORTED", "REFUTED"].includes(judgment.verdict), "discriminator does not bind the exact claim");
    for (const dep of claim.dependencies) invariant(currentClaim(store, run, dep.id)?.version === dep.version &&
      currentClaim(store, run, dep.id)?.status === "SUPPORTED", "claim dependencies require revalidation");
    const next: Claim = { ...claim, version: version + 1, status: judgment.verdict,
      evidenceIds: [...new Set([...claim.evidenceIds, evidenceId])], proposalId: null, reason: `independent discriminator ${discriminator.task.id}` };
    append(store, next, now); invalidateDependents(store, run, id, now);
    recordAdjudication(store, run, `claim:${id}:${version}`, evidenceId, discriminator, now);
    return next;
  });
}

export function proposeClaimConflict(store: Store, run: string, goal: string, leftId: string,
  rightId: string, proposalId: string, now = Date.now()): string {
  const left = currentClaim(store, run, leftId), right = currentClaim(store, run, rightId);
  invariant(left && right && leftId !== rightId && left.goal === goal && right.goal === goal, "conflict claim authority mismatch");
  const proposal = admittedProposal(store, proposalId, "CONFLICT", run, goal);
  invariant(proposal.payload.leftClaim === leftId && proposal.payload.rightClaim === rightId ||
    proposal.payload.arguments?.leftClaim === leftId && proposal.payload.arguments?.rightClaim === rightId, "conflict payload differs from admitted proposal");
  const id = digest({ run, goal, pair: [[leftId, left.version], [rightId, right.version]].sort() });
  store.db.prepare("INSERT OR IGNORE INTO fabric_claim_conflicts VALUES(?,?,?,?,?,?,?,'OPEN',?,?,NULL)")
    .run(id, run, goal, leftId, rightId, left.version, right.version, proposalId, now);
  store.event("fabric.claim.conflict.opened", { id, leftId, rightId, proposalId }, run, goal);
  return id;
}

export function resolveClaimConflict(store: Store, id: string, evidenceId: string, now = Date.now()): void {
  store.transaction(() => {
    const conflict = store.db.prepare("SELECT * FROM fabric_claim_conflicts WHERE id=?").get(id);
    invariant(conflict?.status === "OPEN", "unknown or resolved claim conflict");
    const discriminator = acceptedDiscriminator(store, conflict.run, evidenceId);
    invariant(discriminator.checks.some(check => check.id === "conflict-adjudication" && check.verdict === "PASS"), "missing conflict-adjudication check");
    const judgment = discriminator.artifact?.conflictJudgment;
    invariant(judgment?.conflictId === id && judgment.leftVersion === conflict.left_version &&
      judgment.rightVersion === conflict.right_version && ["LEFT", "RIGHT", "NEITHER"].includes(judgment.verdict), "discriminator does not bind the exact conflict");
    // Resolve the recorded version pair. This never certifies any newer claims.
    store.db.prepare("UPDATE fabric_claim_conflicts SET status='RESOLVED',resolution_evidence=? WHERE id=?").run(evidenceId, id);
    recordAdjudication(store, conflict.run, `conflict:${id}`, evidenceId, discriminator, now);
  });
}

export function claimsForGoals(store: Store, run: string, goals: string[], after = "", limit = 20): Claim[] {
  invariant(goals.length > 0 && goals.length <= 100 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, "invalid claim page");
  const rows = store.db.prepare(`SELECT c.hash FROM fabric_claim_versions c WHERE c.run=? AND c.claim>?
    AND c.goal IN (${goals.map(() => "?").join(",")}) AND c.version=(SELECT MAX(v.version) FROM fabric_claim_versions v
      WHERE v.run=c.run AND v.claim=c.claim) ORDER BY c.claim LIMIT ?`).all(run, after, ...goals, limit);
  return rows.map(row => store.readArtifact(String(row.hash)) as unknown as Claim);
}

/** A proposal for the normal host admission path; never a second scheduler. */
export function claimRevalidationTask(store: Store, run: string, id: string): Task {
  const claim = currentClaim(store, run, id); invariant(claim, "unknown claim");
  const original = store.db.prepare("SELECT spec FROM tasks WHERE run=? AND id=?").get(run, claim.goal);
  invariant(original, "claim task missing");
  const { dependencyViews: _views, ...task }: Task = JSON.parse(original.spec);
  return { ...task, id: `revalidate-${digest({ run, id, version: claim.version }).slice(0, 16)}`,
    dependencies: [], writeScope: [], readScope: [...new Set([...task.writeScope, ...(task.readScope ?? [])])],
    goal: `Independently revalidate claim ${id} version ${claim.version}: ${claim.statement}`,
    acceptance: ["produce a pinned machine-checkable discriminator bound to claimId, version and statementHash"],
    input: JSON.parse(canonical({ claim, originalAcceptance: task.acceptance })) };
}

export function claimGate(store: Store, run: string): { openClaimConflicts: number; staleClaims: number } {
  return {
    openClaimConflicts: Number(store.db.prepare("SELECT COUNT(*) AS n FROM fabric_claim_conflicts WHERE run=? AND status='OPEN'").get(run)?.n ?? 0),
    staleClaims: Number(store.db.prepare(`SELECT COUNT(*) AS n FROM fabric_claim_versions c WHERE c.run=? AND c.status='STALE'
      AND c.version=(SELECT MAX(v.version) FROM fabric_claim_versions v WHERE v.run=c.run AND v.claim=c.claim)`).get(run)?.n ?? 0),
  };
}
