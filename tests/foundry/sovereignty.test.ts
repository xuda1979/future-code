import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { canonical, digest } from "../../src/harness/foundry/kernel.ts";
import { decideProposal, requireAdmission, submitProposal } from "../../src/harness/foundry/proposals.ts";
import { adjudicateClaim, claimGate, currentClaim, proposeClaim, proposeClaimConflict, retractClaim,
  resolveClaimConflict, claimRevalidationTask } from "../../src/harness/foundry/claims.ts";
import { adjudicationTask, recordEvidence, resolveConflict } from "../../src/harness/foundry/evidenceFabric.ts";
import { admitAdjudicationTask } from "../../src/harness/foundry/adjudication.ts";
import { contextualInterventionPolicy, recoveryFeatures, recordInterventionContext } from "../../src/harness/foundry/contextualPolicy.ts";
import { installInterventionMemoryTables } from "../../src/harness/foundry/interventionMemory.ts";
import { integrateSwarm, runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { objectiveEvidenceGate } from "../../src/harness/foundry/swarm/supervisor.ts";
import { contract, recipe, task } from "./fixtures.ts";
import { fixture as swarmFixture, reply, scripted, signal, task as swarmTask } from "./swarm-fixtures.ts";
import type { Json, Task } from "../../src/harness/foundry/types.ts";

async function fixture(fn: (s: Store, q: Scheduler, run: string) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "sovereignty-")); const s = await Store.open(root);
  try { s.initialize(contract, recipe); const q = new Scheduler(s); await fn(s, q, q.start([task()])); }
  finally { s.close(); rmSync(root, { recursive: true, force: true }); }
}
function claim(s: Store, q: Scheduler, run: string, id: string, dependencies: string[] = [], expectedVersion?: number) {
  let lease = s.db.prepare("SELECT fence FROM tasks WHERE run=? AND id='a' AND status='RUNNING'").get(run);
  if (!lease) q.claim(run, "model");
  lease = s.db.prepare("SELECT fence,owner,deadline FROM tasks WHERE run=? AND id='a'").get(run)!;
  const c = q.capsule({ runId: run, taskId: "a", fence: lease.fence, owner: lease.owner, deadline: lease.deadline,
    contractHash: digest(contract), recipeHash: s.active() });
  const payload = { id, statement: `hypothesis ${id}`, dependencies, evidenceIds: [], ...(expectedVersion === undefined ? {} : { expectedVersion }) };
  const p = submitProposal(s, "CLAIM", payload, c, "test-model"); requireAdmission(s, p, () => {});
  return proposeClaim(s, run, "a", payload, p.id);
}
function acceptDiscriminator(s: Store, spec: Task, artifact: Json, check = "claim-adjudication") {
  const q = new Scheduler(s);
  const run = q.start([spec]);
  const lease = q.claim(run, "independent-checker")!;
  q.finish(lease, artifact, { contractHash: lease.contractHash, recipeHash: lease.recipeHash,
    verifierId: contract.verifierId, taskHash: digest(spec), artifactHash: digest(artifact),
    metrics: { tokens: 0, costUsd: 0, durationMs: 1 },
    verification: { artifactHash: digest(artifact), checks: [{ id: "behavior", verdict: "PASS" }, ...(check === "behavior" ? [] : [{ id: check, verdict: "PASS" }])] },
  }, { tokens: 0, costUsd: 0 });
  return { run, id: String(s.db.prepare("SELECT id FROM fabric_evidence WHERE run=? AND task=?").get(run, spec.id)!.id) };
}
function discriminatorInRun(s: Store, q: Scheduler, run: string, artifact: Json, check = "claim-adjudication") {
  const spec = { ...task(`judge-${digest({ artifact, check }).slice(0, 10)}`), writeScope: [] };
  admitAdjudicationTask(s, run, "a", `test:${digest({ artifact, check })}`, spec);
  const lease = q.claim(run, "independent-checker")!;
  assert.equal(lease.taskId, spec.id);
  q.finish(lease, artifact, { contractHash: lease.contractHash, recipeHash: lease.recipeHash,
    verifierId: contract.verifierId, taskHash: digest(spec), artifactHash: digest(artifact),
    metrics: { tokens: 0, costUsd: 0, durationMs: 1 },
    verification: { artifactHash: digest(artifact), checks: [{ id: "behavior", verdict: "PASS" }, ...(check === "behavior" ? [] : [{ id: check, verdict: "PASS" }])] },
  }, { tokens: 0, costUsd: 0 });
  return String(s.db.prepare("SELECT id FROM fabric_evidence WHERE run=? AND task=?").get(run, spec.id)!.id);
}

test("proposal receipts cannot authorize modified payloads or expired leases", async () => fixture((s, q, run) => {
  const c = q.capsule(q.claim(run, "model")!);
  const p = submitProposal(s, "TOOL_CALL", { path: "src/a" }, c, "test-model");
  assert.equal(decideProposal(s, p, () => {}).verdict, "ADMIT");
  const forged = { ...p, payload: { path: "protected/verifier" } };
  assert.equal(decideProposal(s, forged, () => { throw new Error("must not reach validator"); }).verdict, "REJECT");
  assert.equal(decideProposal(s, p, () => {}, Date.now() + recipe.timeoutMs + 1).verdict, "REJECT");
  assert.throws(() => s.db.prepare("DELETE FROM kernel_admissions").run(), /append-only proposal/);
}));

test("events and evidence are immutable while hypotheses can be withdrawn with intact history", async () => fixture((s, q, run) => {
  const a = claim(s, q, run, "cause");
  assert.equal(a.status, "PROPOSED");
  const evidence = recordEvidence(s, { run, goal: "a", verdict: "UNKNOWN", strength: 0, kind: "observation", source: "host" });
  assert.throws(() => s.db.prepare("UPDATE fabric_evidence SET verdict='PASS' WHERE id=?").run(evidence), /append-only evidence/);
  assert.throws(() => s.db.prepare("DELETE FROM events").run(), /append-only events/);
  assert.throws(() => s.db.prepare("DELETE FROM fabric_claim_versions").run(), /append-only claim/);
  const retracted = retractClaim(s, run, a.id, a.version, "counterexample disproved hypothesis");
  assert.equal(retracted.status, "RETRACTED");
  const hashes = s.db.prepare("SELECT hash FROM fabric_claim_versions WHERE run=? AND claim=? ORDER BY version").all(run, a.id);
  assert.equal(hashes.length, 2); assert.equal((s.readArtifact(hashes[0].hash) as any).statement, a.statement);
}));

test("claim revisions invalidate dependent knowledge transitively and reject cycles", async () => fixture((s, q, run) => {
  const a = claim(s, q, run, "a-claim");
  claim(s, q, run, "b-claim", [a.id]);
  claim(s, q, run, "c-claim", ["b-claim"]);
  assert.throws(() => claim(s, q, run, a.id, ["c-claim"], a.version), /cycle/);
  retractClaim(s, run, a.id, a.version, "new observation");
  assert.equal(currentClaim(s, run, "b-claim")!.status, "STALE");
  assert.equal(currentClaim(s, run, "c-claim")!.status, "STALE");
  assert.equal(claimGate(s, run).staleClaims, 2);
  const revalidation = claimRevalidationTask(s, run, "b-claim");
  assert.deepEqual(revalidation.writeScope, []); assert.deepEqual(revalidation.dependencies, []);
  assert.equal(revalidation.dependencyViews, undefined);
  assert.equal(s.db.prepare("SELECT status FROM tasks WHERE run=? AND id='a'").get(run)!.status, "RUNNING",
    "knowledge invalidation never resets execution or repeats an external effect");
}));

test("replaying a claim mutation appends once and rephrasing stale knowledge cannot clear the gate", async () => fixture((s, q, run) => {
  const original = claim(s, q, run, "cause");
  assert.equal(claim(s, q, run, "cause").version, original.version);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM fabric_claim_versions WHERE run=?").get(run)!.n, 1);
  const dependent = claim(s, q, run, "dependent", [original.id]);
  retractClaim(s, run, original.id, original.version, "new evidence");
  const stale = currentClaim(s, run, dependent.id)!;
  const revised = claim(s, q, run, dependent.id, [], stale.version);
  assert.equal(revised.status, "STALE"); assert.equal(claimGate(s, run).staleClaims, 1);
}));

test("a read-only host discriminator can reopen a passed run without resetting accepted work", async () => fixture((s, q, run) => {
  const lease = q.claim(run, "worker")!, spec = task(), artifact = { valid: true };
  q.finish(lease, artifact, { contractHash: lease.contractHash, recipeHash: lease.recipeHash,
    verifierId: contract.verifierId, taskHash: digest(spec), artifactHash: digest(artifact),
    metrics: { tokens: 0, costUsd: 0, durationMs: 1 },
    verification: { artifactHash: digest(artifact), checks: [{ id: "behavior", verdict: "PASS" }] },
  }, { tokens: 0, costUsd: 0 });
  q.claim(run, "finalize"); assert.equal(q.status(run), "PASS");
  const discriminator = { ...task("judge"), writeScope: [], readScope: ["src/a"] };
  assert.equal(admitAdjudicationTask(s, run, "a", "new-evidence", discriminator), "judge");
  assert.equal(q.status(run), "RUNNING");
  assert.equal(s.db.prepare("SELECT status FROM tasks WHERE run=? AND id='a'").get(run)!.status, "PASS");
  assert.equal(admitAdjudicationTask(s, run, "a", "new-evidence", discriminator), "judge");
  assert.throws(() => admitAdjudicationTask(s, run, "a", "new-evidence", { ...discriminator, goal: "changed" }), /replay drift/);
  assert.throws(() => admitAdjudicationTask(s, run, "a", "other", { ...discriminator, id: "other", readScope: ["private"] }), /widens read authority/);
  assert.throws(() => admitAdjudicationTask(s, run, "a", "cycle", { ...discriminator, id: "cyclic", dependencies: ["a"] }), /cycl/);
}));

test("independent adjudication must bind the exact claim and cannot borrow another run's evidence", async () => fixture((s, q, run) => {
  const a = claim(s, q, run, "cause");
  const fake = recordEvidence(s, { run, goal: "a", verdict: "PASS", strength: 1, kind: "model-confidence", source: "LLM" });
  assert.throws(() => adjudicateClaim(s, run, a.id, a.version, fake), /independent machine evidence/);
  const other = acceptDiscriminator(s, task("elsewhere"), { claimJudgment: { claimId: a.id, version: a.version, statementHash: a.statementHash, verdict: "SUPPORTED" } });
  assert.throws(() => adjudicateClaim(s, run, a.id, a.version, other.id), /independent machine evidence/);
  const wrong = discriminatorInRun(s, q, run, { claimJudgment: { claimId: a.id, version: a.version, statementHash: digest("wrong"), verdict: "SUPPORTED" } });
  assert.throws(() => adjudicateClaim(s, run, a.id, a.version, wrong), /exact claim/);
  const correct = discriminatorInRun(s, q, run, { claimJudgment: { claimId: a.id, version: a.version, statementHash: a.statementHash, verdict: "SUPPORTED" } });
  assert.equal(adjudicateClaim(s, run, a.id, a.version, correct).status, "SUPPORTED");
  assert.throws(() => adjudicateClaim(s, run, a.id, a.version, correct), /stale claim/);
}));

test("model-detected contradictions block completion until a bound machine discriminator resolves them", async () => fixture((s, q, run) => {
  const a = claim(s, q, run, "left"), b = claim(s, q, run, "right");
  const lease = s.db.prepare("SELECT fence,owner,deadline FROM tasks WHERE run=? AND id='a'").get(run)!;
  const c = q.capsule({ runId: run, taskId: "a", fence: lease.fence, owner: lease.owner, deadline: lease.deadline,
    contractHash: digest(contract), recipeHash: s.active() });
  const p = submitProposal(s, "CONFLICT", { leftClaim: a.id, rightClaim: b.id }, c, "model-detector");
  requireAdmission(s, p, () => {});
  const id = proposeClaimConflict(s, run, "a", a.id, b.id, p.id);
  assert.equal(claimGate(s, run).openClaimConflicts, 1);
  const wrong = discriminatorInRun(s, q, run, { conflictJudgment: { conflictId: id, leftVersion: a.version, rightVersion: b.version, verdict: "LEFT" } }, "behavior");
  assert.throws(() => resolveClaimConflict(s, id, wrong), /missing conflict-adjudication/);
  const correct = discriminatorInRun(s, q, run, { conflictJudgment: { conflictId: id, leftVersion: a.version, rightVersion: b.version, verdict: "NEITHER" } }, "conflict-adjudication");
  resolveClaimConflict(s, id, correct);
  assert.equal(claimGate(s, run).openClaimConflicts, 0);
  assert.equal(currentClaim(s, run, a.id)!.status, "PROPOSED", "resolving a conflict cannot certify a claim implicitly");
}));

test("existing evidence conflict cannot be closed by reusing one side or UNKNOWN evidence", async () => fixture((s, q, run) => {
  const left = recordEvidence(s, { run, goal: "a", kind: "experiment", verdict: "PASS", strength: 1, source: "A" });
  recordEvidence(s, { run, goal: "a", kind: "replication", verdict: "FAIL", strength: 1, source: "B" });
  const id = String(s.db.prepare("SELECT id FROM fabric_conflicts WHERE run=?").get(run)!.id);
  adjudicationTask(s, id);
  assert.throws(() => resolveConflict(s, id, left), /independent machine evidence/);
  const unknown = recordEvidence(s, { run, goal: "a", kind: "experiment", verdict: "UNKNOWN", strength: 1, source: "C" });
  assert.throws(() => resolveConflict(s, id, unknown), /independent machine evidence/);
  assert.equal(s.db.prepare("SELECT status FROM fabric_conflicts WHERE id=?").get(id)!.status, "OPEN");
}));

test("real swarm model replies, tool intents and hypotheses cross the unified proposal boundary", async () => swarmFixture(async s => {
  const api = scripted([
    () => reply("", [{ name: "propose_claim", arguments: { id: "result", statement: "implementation may fix the defect", dependencies: [], evidenceIds: [] } }]),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("PASS: trust my claim"),
  ]);
  const result: any = await runSwarm(s, [swarmTask()], signal(), undefined, api.fetcher);
  assert.equal(result.status, "PASS");
  assert.equal(currentClaim(s, result.id, "result")!.status, "PROPOSED");
  const kinds = s.db.prepare("SELECT DISTINCT kind FROM kernel_proposals WHERE run=?").all(result.id).map(r => r.kind);
  assert.deepEqual(new Set(kinds), new Set(["RESPONSE", "CLAIM", "TOOL_CALL"]));
  assert.equal(objectiveEvidenceGate(s, result.id).status, "PASS");
}, spec => { spec.agents.coder.tools.push("propose_claim"); }));

test("forged model authority and out-of-scope edits are rejected before effects", async () => swarmFixture(async (s, cfg, project) => {
  const api = scripted([
    () => reply("", [{ name: "propose_claim", arguments: { id: "truth", statement: "verified", dependencies: [], evidenceIds: [], status: "SUPPORTED" } }]),
    () => reply("", [{ name: "write_file", arguments: { path: "src/b.txt", content: "42\n" } }]),
    () => reply("done"),
  ]);
  const result: any = await runSwarm(s, [swarmTask()], signal(), undefined, api.fetcher);
  assert.equal(result.status, "FAIL"); assert.equal(currentClaim(s, result.id, "truth"), null);
  const rejected = s.db.prepare("SELECT reason FROM kernel_admissions WHERE verdict='REJECT'").all();
  assert.ok(rejected.some(r => /unexpected tool status/.test(r.reason)));
  assert.ok(rejected.some(r => /outside task authority/.test(r.reason)));
}, spec => { spec.agents.coder.tools.push("propose_claim"); spec.recipe.attempts = 1; }));

test("cached integration cannot bypass evidence conflicts opened after its checks", async () => swarmFixture(async s => {
  const api = scripted([
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("implemented"),
  ]);
  const result: any = await runSwarm(s, [swarmTask()], signal(), undefined, api.fetcher);
  await integrateSwarm(s, result.id, signal());
  recordEvidence(s, { run: result.id, goal: "a", kind: "counterexample", verdict: "FAIL", strength: 1, source: "independent-test" });
  assert.equal(objectiveEvidenceGate(s, result.id).status, "BLOCKED");
  await assert.rejects(integrateSwarm(s, result.id, signal()), /unresolved conflicts/);
}));

test("contextual policy excludes unrelated environments, deduplicates transitions and abstains on unknown outcomes", async () => fixture((s, q, run) => {
  installInterventionMemoryTables(s);
  const context = recoveryFeatures(s, run, [task()], { productivity: { verifiedFraction: 0 } });
  const insert = (i: number, outcome: string, features = context, source = `r${i}`, classes = ["narrow_write_scope"]) => {
    const id = `effect${i}`;
    s.db.prepare("INSERT INTO rnd_intervention_effects VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "o", source, `${source}-target`, "f", "low_verified_yield", digest(classes), canonical(classes), outcome, "e", context.domain, i);
    recordInterventionContext(s, id, features);
  };
  for (let i = 0; i < 12; i++) insert(i, "IMPROVED");
  insert(12, "IMPROVED", context, "r0"); // repeated snapshot is not an independent sample
  insert(13, "REGRESSED", { ...context, environmentId: "unrelated" });
  let policy: any = contextualInterventionPolicy(s, ["low_verified_yield"], context);
  assert.equal(policy.authority, "ADVISORY_ONLY");
  assert.equal(policy.findings.low_verified_yield[0].samples, 12);
  assert.equal(policy.findings.low_verified_yield[0].recommendation, "CONSIDER");
  insert(14, "UNKNOWN");
  policy = contextualInterventionPolicy(s, ["low_verified_yield"], context);
  assert.equal(policy.findings.low_verified_yield[0].recommendation, "ABSTAIN");
  for (let i = 15; i < 27; i++) insert(i, "IMPROVED", context, `r${i}`, ["reduce_acceptance_surface"]);
  policy = contextualInterventionPolicy(s, ["low_verified_yield"], context);
  assert.equal(policy.findings.low_verified_yield.find((p: any) => !p.comparable).recommendation, "ABSTAIN");
}));
