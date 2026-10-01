import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import {
  adjudicationTask, builtinDomainPacks, experienceMatches, fabricStatus,
  recordEvidence, refreshTaskAllocation, registerDomainPack,
} from "../../src/harness/foundry/evidenceFabric.ts";
import { toolEffectContract } from "../../src/harness/foundry/swarm/toolEffects.ts";
import type { Contract, Json, Lease, Recipe, Task } from "../../src/harness/foundry/types.ts";
import { spec as swarmSpec } from "./swarm-fixtures.ts";

const contract: Contract = {
  schema: 1, name: "evidence-fabric", workerId: "w", verifierId: "v", environmentId: "e",
  requiredChecks: ["behavior"], slos: [],
  limits: { parallelism: 8, attempts: 4, contextBytes: 32768, outputBytes: 32768, timeoutMs: 10000, tasks: 1000 },
};
const recipe: Recipe = { parallelism: 4, attempts: 3, contextBytes: 8192, timeoutMs: 5000, scheduling: "critical-path" };
const zero = { tokens: 0, costUsd: 0 };
const task = (id: string, goal = id, dependencies: string[] = []): Task => ({
  id, goal, acceptance: ["machine verified"], dependencies,
  writeScope: [`src/${id}.ts`], readScope: ["src"], input: null, estimatedDurationMs: 1,
});
function accept(q: Scheduler, lease: Lease, artifact: Json = { ok: true }) {
  const spec: Task = JSON.parse(q.store.db.prepare(
    "SELECT spec FROM tasks WHERE run=? AND id=?"
  ).get(lease.runId, lease.taskId)!.spec);
  return q.finish(lease, artifact, {
    contractHash: lease.contractHash, recipeHash: lease.recipeHash,
    verifierId: contract.verifierId, taskHash: digest(spec), artifactHash: digest(artifact),
    metrics: { ...zero, durationMs: 1 },
    verification: { artifactHash: digest(artifact), checks: [{ id: "behavior", verdict: "PASS" }] },
  }, zero);
}
async function fixture(fn: (store: Store) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), "evidence-fabric-")); const store = await Store.open(root);
  try { store.initialize(contract, recipe); await fn(store); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

test("goal and evidence graph are durable projections over the authoritative task DAG", async () => fixture(store => {
  const q = new Scheduler(store); const run = q.start([task("root"), task("child", "child", ["root"])]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM fabric_goals WHERE run=?").get(run)!.n, 2);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS n FROM fabric_goal_edges WHERE run=? AND source='root' AND target='child' AND kind='dependency'"
  ).get(run)!.n, 1);
  const lease = q.claim(run, "w")!; assert.equal(lease.taskId, "root");
  assert.equal(accept(q, lease), true);
  assert.equal(store.db.prepare("SELECT status FROM fabric_goals WHERE run=? AND id='root'").get(run)!.status, "VERIFIED");
  const evidence = store.db.prepare("SELECT verdict,strength,source FROM fabric_evidence WHERE run=? AND goal='root'").get(run)!;
  assert.equal(evidence.verdict, "PASS"); assert.equal(evidence.strength, 1);
  assert.equal(evidence.source, "foundry-independent-verifier");
  assert.equal(store.db.prepare("SELECT outcome FROM fabric_experience WHERE run=? AND task='root'").get(run)!.outcome, "PASS");
}));

test("allocator uses host evidence and penalizes repeated failed work without accepting model feasibility scores", async () => fixture(store => {
  const q = new Scheduler(store); const run = q.start([{ ...task("a"), priority: 10 }, task("b")]);
  const before = refreshTaskAllocation(store, run, "a")!;
  const first = q.claimMany(run, "w", 2).find(x => x.taskId === "a")!;
  q.fail(first, "same deterministic failure", zero);
  const second = q.claimMany(run, "w2", 2).find(x => x.taskId === "a")!;
  q.fail(second, "same deterministic failure", zero);
  const after = refreshTaskAllocation(store, run, "a")!;
  assert.ok(after.repeatedFailure > before.repeatedFailure);
  assert.ok(after.resourceSpent > before.resourceSpent);
  assert.ok(after.score < before.score);
  const columns = store.db.prepare("PRAGMA table_info(fabric_allocations)").all().map(r => r.name);
  assert.equal(columns.includes("feasibility"), false, "LLM self-reported feasibility must not become scheduler authority");
}));

test("verified experience is reusable as a topology-aware prior", async () => fixture(store => {
  const q = new Scheduler(store);
  const first = q.start([task("old", "Implement parser validation")]);
  const lease = q.claim(first, "w")!; accept(q, lease); q.claim(first, "finalize");
  const matches = experienceMatches(store, task("new", "Implement parser validation"));
  assert.equal(matches.length, 1); assert.equal((matches[0] as any).outcome, "PASS");
  const second = q.start([task("new", "Implement parser validation")]);
  const allocation = refreshTaskAllocation(store, second, "new")!;
  assert.equal(allocation.experienceYield, 1);
}));

test("strong contradictory evidence creates an adjudication goal instead of majority voting", async () => fixture(store => {
  const q = new Scheduler(store); const run = q.start([task("hypothesis", "Determine whether optimization is valid")]);
  const left = recordEvidence(store, { run, goal: "hypothesis", task: "hypothesis",
    kind: "experiment-result", verdict: "PASS", strength: 0.9, source: "experiment-A" });
  const right = recordEvidence(store, { run, goal: "hypothesis", task: "hypothesis",
    kind: "replication", verdict: "FAIL", strength: 0.95, source: "experiment-B" });
  const conflict = store.db.prepare("SELECT id,status FROM fabric_conflicts WHERE run=?").get(run)!;
  assert.equal(conflict.status, "OPEN");
  const proposal = adjudicationTask(store, conflict.id, ["src/adjudication.ts"], ["src"]);
  assert.match(proposal.goal, /smallest machine-checkable discriminator/);
  assert.equal((proposal.input as any).conflictId, conflict.id);
  assert.deepEqual(new Set((proposal.input as any).evidence.map((x: any) => x.id)), new Set([left, right]));
  assert.equal(store.db.prepare("SELECT status FROM fabric_goals WHERE run=? AND id='hypothesis'").get(run)!.status, "CONFLICTED");
}));

test("domain packs are immutable versioned contracts", async () => fixture(store => {
  const pack = builtinDomainPacks()[1];
  const hash = registerDomainPack(store, pack);
  assert.equal(registerDomainPack(store, pack), hash);
  assert.throws(() => registerDomainPack(store, { ...pack, validators: [...pack.validators, "changed"] }), /version the pack name/);
}));

test("tool effects distinguish replay-safe reads, state-bound edits, control-plane changes and external jobs", async () => {
  const s = swarmSpec("/tmp/project");
  s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 10000,
    dynamicDAG: { maxChildrenPerTask: 4, maxDepth: 3, maxSpawnedTasks: 20 } };
  s.agents.coder.tools.push("spawn_tasks", "run_job");
  s.jobs = { train: { adapter: { argv: ["/bin/true"] }, idempotentEnsure: true,
    pollMs: 100, staleMs: 1000, maxJobs: 2, maxConcurrent: 1 } };
  s.agents.coder.jobs = ["train"];
  const cfg: any = { version: 1, handsId: "h", spec: s, baseCommit: "abc", git: { argv: [], pins: [] }, checks: {} };
  assert.equal(toolEffectContract(cfg, "read_file", { path: "a" }).replay, "safe");
  assert.equal(toolEffectContract(cfg, "edit_file", { path: "a" }).compensation, "snapshot-rollback");
  assert.equal(toolEffectContract(cfg, "spawn_tasks", { children: [] }).idempotency, "spawn-request");
  assert.equal(toolEffectContract(cfg, "run_job", { name: "train", input: {} }).replay, "reconcile");
});

test("fabric status exposes evidence, conflicts and evidence-aware allocation without becoming scheduler authority", async () => fixture(store => {
  const q = new Scheduler(store); const run = q.start([task("a"), task("b")]);
  const status = fabricStatus(store, run);
  assert.equal(status.goals, 2); assert.equal(status.evidence, 0);
  assert.equal(status.topAllocations.length, 2);
}));
