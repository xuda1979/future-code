import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { canonical, digest, sha256 } from "../../src/harness/foundry/kernel.ts";
import { rebuildResearchAssignments } from "../../src/harness/foundry/researchAssignments.ts";
import { ResearchProgramme } from "../../src/harness/foundry/researchProgramme.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { spawnTasks } from "../../src/harness/foundry/dynamicDag.ts";
import { applyWorkflowProposal, workflowVersions } from "../../src/harness/foundry/workflow.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { WorkflowPolicyAgent } from "../../src/harness/foundry/swarm/workflowPolicy.ts";
import { validateSwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { decodeSpawnChildren } from "../../src/harness/foundry/swarm/spawn.ts";
import { ResearchJobs } from "../../src/harness/foundry/swarm/jobs.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { handleSwarm } from "../../src/harness/foundry/swarm/cli.ts";
import { abortable } from "../../src/harness/foundry/swarm/transport.ts";
import { ProjectKnowledge } from "../../src/harness/foundry/swarm/knowledge.ts";
import { assertResearchFrontierExpansion, researchStrategySnapshot } from "../../src/harness/foundry/swarm/researchStrategy.ts";
import { fixtureResult, tableFixtureSpec } from "../../adapters/research/table-fixture.mjs";
import { fixture, task, reply, signal } from "./swarm-fixtures.ts";

function configure(s: any) {
  s.checks.behavior.argv = [process.execPath, "-e", "process.exit(0)"];
  s.agents.planner = { ...s.agents.coder, tools: [...s.agents.coder.tools], model: "planner" };
  s.agents.coder.tools.push("run_job", "spawn_tasks"); s.agents.coder.jobs = ["screen", "proof", "alternative"];
  const analysis = resolve("adapters/research/paired-table-validator.mjs");
  s.jobs = Object.fromEntries(["screen", "proof", "alternative"].map(name => {
    const spec = tableFixtureSpec(`unregistered-${name}`);
    if (name === "screen") {
      for (const row of spec.input.observations) row.data.reading = row.unit === "candidate" ? 0 : 1;
      spec.identity.data = digest(spec.input.observations);
    }
    return [name, { adapter: { argv: [process.execPath, "-e", "process.exit(0)"] },
      research: { spec, validators: { analysis: { command: { argv: [process.execPath, "--experimental-strip-types", analysis],
        files: [resolve("src/harness/foundry/kernel.ts"), resolve("src/harness/foundry/research.ts")] },
      readOnly: true, timeoutMs: 2000, maxOutputBytes: 16384 } } },
      idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 20, maxConcurrent: 2 }];
  }));
  s.researchStrategy = { schema: 1, maxExperiments: 3, maxSnapshotBytes: 8192, stopOnRefutation: true,
    frontier: { maxParallel: 2, explorationWeight: 1, maxInconclusivePerLine: 2 }, candidates: [
      { id: "screen", template: "screen", line: "first", purpose: "falsification" },
      { id: "proof", template: "proof", line: "first", purpose: "replication", after: [{ candidate: "screen", outcomes: ["SUPPORTED"] }] },
      { id: "alternative", template: "alternative", line: "second", purpose: "falsification" },
    ] };
  s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 10000,
    dynamicDAG: { maxChildrenPerTask: 4, maxDepth: 2, maxSpawnedTasks: 8 },
    workflowPolicy: { agent: "planner", mode: "apply", minIntervalMs: 100, maxReviews: 16,
      maxOperations: 4, maxSnapshotTasks: 8, maxSnapshotBytes: 12000, maxTaskTimeoutMs: 40000,
      allowedOperations: ["expand_task", "set_task_timeout", "set_parallelism"] } };
  s.researchProgramme = { id: "frontier-project", maxFindingsPerTask: 4, maxContextBytes: 24000 };
}
const root = (id = "a") => ({ ...task(id), writeScope: [], readScope: [] });
const child = (id: string, template = id) => ({ id, goal: `Run independently checked ${template}`, acceptance: ["independent scientific validation"],
  input: {}, writeScope: [], readScope: [], research: [template] });
function deliberationPolicy(s: any) {
  configure(s);
  s.researchStrategy.deliberation = { familiarObservations: 1, stagnationWindow: 2, maxUninformative: 4,
    maxResearchMs: 60000, highImpact: false, reuseProgrammeFindings: true };
}
async function checkedScreen(s: any, cfg: any) {
  let turn = 0;
  const driver = new SwarmDriver(s, cfg, (async () => turn++ === 0 ? reply("", [{ name: "run_job", arguments: {
    name: "screen", input: cfg.spec.jobs.screen.research.spec.input } }]) : reply()) as typeof fetch, undefined,
  async (_c: any, _cfg: any, input: any) => {
    const data = fixtureResult(cfg.spec.jobs.screen.research.spec, { key: input.key, jobId: input.key });
    const bytes = Buffer.from(JSON.stringify(data.observations));
    return { schema: 1, key: input.key, jobId: input.key, status: "SUCCEEDED", result: { exitCode: 0, data,
      artifacts: { "raw-data": { sha256: sha256(bytes), bytes: bytes.length } } } };
  });
  const result = await runTasks(s, [{ ...root(), research: ["screen"] }], driver, { signal: signal() });
  assert.equal(result.status, "PASS");
  return result;
}
function propose(s: any, cfg: any, run: string, key: string, operations: any[]) {
  const versions = workflowVersions(s, run);
  return applyWorkflowProposal(s, run, key, JSON.parse(canonical({ schema: 1, reason: "Allocate verified research frontier", operations,
    expectedGraphVersion: versions.graphVersion, expectedPolicyVersion: versions.policyVersion, expectedStateVersion: versions.stateVersion })),
  { ...cfg.spec.supervision.workflowPolicy, spawn: cfg.spec.supervision.dynamicDAG }, (parent, children) => {
    const decoded = decodeSpawnChildren(cfg.spec, parent, children); assertResearchFrontierExpansion(s, cfg, run, decoded); return decoded;
  });
}

test("admitted tasks reserve frontier slots before remote jobs, survive reopen, and rebuild from authoritative tasks", async () => fixture(async (s, cfg) => {
  const run = new Scheduler(s).start([root(), root("b")]);
  const receipt = propose(s, cfg, run, "reserve", [{ op: "expand_task", taskId: "a", children: [child("screen"), child("alternative")] }]);
  assert.equal(receipt.verdict, "ADMIT");
  let snapshot: any = researchStrategySnapshot(s, cfg, run);
  assert.equal(snapshot.used, 0); assert.equal(snapshot.reserved, 2); assert.equal(snapshot.committed, 2);
  assert.deepEqual(snapshot.decision.batch, []); assert.equal(snapshot.decision.reason, "FRONTIER_AT_CAPACITY");
  const reopened = await Store.open(s.root);
  try { assert.deepEqual(researchStrategySnapshot(reopened, cfg, run), snapshot); } finally { reopened.close(); }
  s.db.prepare("DELETE FROM research_assignments WHERE run=?").run(run);
  rebuildResearchAssignments(s, run);
  assert.deepEqual(researchStrategySnapshot(s, cfg, run), snapshot);
  const competing = propose(s, cfg, run, "competing", [{ op: "expand_task", taskId: "b", children: [child("duplicate", "screen")] }]);
  assert.equal(competing.verdict, "REJECT"); assert.equal(competing.changed, false);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_assignments WHERE run=?").get(run)!.n, 2);
}, configure));

test("duplicate or premature research children roll back the complete patch, including reservations", async () => fixture(async (s, cfg) => {
  const run = new Scheduler(s).start([root(), root("b")]);
  const version = workflowVersions(s, run).graphVersion;
  const duplicate = propose(s, cfg, run, "duplicate", [{ op: "expand_task", taskId: "a", children: [child("one", "screen"), child("two", "screen")] }]);
  assert.equal(duplicate.verdict, "REJECT");
  const premature = propose(s, cfg, run, "premature", [
    { op: "expand_task", taskId: "a", children: [child("screen")] },
    { op: "expand_task", taskId: "b", children: [child("proof")] },
  ]);
  assert.equal(premature.verdict, "REJECT"); assert.equal(workflowVersions(s, run).graphVersion, version);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_assignments WHERE run=?").get(run)!.n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM spawn_edges WHERE run=?").get(run)!.n, 0);
}, configure));

test("worker delegation uses the same atomic gate and durable replay does not re-reserve work", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([root(), root("b")]);
  const [first, second] = q.claimMany(run, "workers", 2).map(lease => q.capsule(lease));
  const children = decodeSpawnChildren(cfg.spec, first.task, [child("screen")]);
  let checks = 0;
  const admit = () => { checks++; assertResearchFrontierExpansion(s, cfg, run, children); };
  const one = spawnTasks(s, first, "same", digest(children), children, cfg.spec.supervision!.dynamicDAG!, Date.now(), undefined, admit);
  const two = spawnTasks(s, first, "same", digest(children), children, cfg.spec.supervision!.dynamicDAG!, Date.now(), undefined, admit);
  assert.deepEqual(one, two); assert.equal(checks, 1);
  const others = decodeSpawnChildren(cfg.spec, second.task, [child("duplicate", "screen")]);
  assert.throws(() => spawnTasks(s, second, "competing", digest(others), others, cfg.spec.supervision!.dynamicDAG!, Date.now(), undefined,
    () => assertResearchFrontierExpansion(s, cfg, run, others)), /eligible frontier/);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_assignments WHERE run=?").get(run)!.n, 1);
}, configure));

test("real workflow and worker paths run a parallel batch, retain checked negative knowledge, and prune its proof branch", async () => fixture(async (s, cfg) => {
  const packets: any[] = []; const turns = new Map<string, number>(); let spawned = false, active = 0, peak = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  const fetcher = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body), packet = JSON.parse(body.messages.find((m: any) => m.role === "user").content);
    if (body.model === "planner") {
      packets.push(packet.researchStrategy);
      const operations: any[] = [];
      if (!spawned && packet.researchStrategy.decision.batch.length === 2) {
        spawned = true; operations.push({ op: "expand_task", taskId: "a", children: packet.researchStrategy.decision.batch.map((id: string) => child(id)) });
      }
      return reply("", [{ name: "propose_workflow", arguments: { schema: 1,
        expectedGraphVersion: packet.observation.graphVersion, expectedPolicyVersion: packet.observation.policyVersion,
        expectedStateVersion: packet.observation.stateVersion, reason: "Run independent falsification lines together", operations } }]);
    }
    const id = packet.task.id, turn = turns.get(id) ?? 0; turns.set(id, turn + 1);
    if (packet.task.research?.length && turn === 0) {
      const name = packet.task.research[0];
      return reply("", [{ name: "run_job", arguments: { name, input: cfg.spec.jobs![name].research!.spec.input } }]);
    }
    return reply("Ready for independent checks");
  }) as typeof fetch;
  const rpc = async (_c: any, _cfg: any, input: any, signal: AbortSignal) => {
    const row = s.db.prepare("SELECT template FROM research_jobs WHERE key=?").get(input.key)!;
    const spec: any = cfg.spec.jobs![row.template].research!.spec;
    active++; peak = Math.max(peak, active);
    if (active === 2) release();
    await abortable(bothStarted, signal); active--;
    const data = fixtureResult(spec, { key: input.key, jobId: input.key }), bytes = Buffer.from(JSON.stringify(data.observations));
    return { schema: 1, key: input.key, jobId: input.key, status: "SUCCEEDED", result: { exitCode: 0, data,
      artifacts: { "raw-data": { sha256: sha256(bytes), bytes: bytes.length } } } };
  };
  const driver = new SwarmDriver(s, cfg, fetcher, undefined, rpc as any), policy = new WorkflowPolicyAgent(s, cfg, fetcher);
  const result = await runTasks(s, [root()], driver, { signal: signal(), beforeRefill: (run, signal) => policy.review(run, signal) });
  assert.equal(result.status, "PASS", JSON.stringify(s.db.prepare("SELECT id,error FROM tasks").all()));
  assert.equal(peak, 2); assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_jobs").get()!.n, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_jobs WHERE template='proof'").get()!.n, 0);
  const final: any = researchStrategySnapshot(s, cfg, result.id);
  assert.equal(final.used, 2); assert.equal(final.reserved, 0); assert.deepEqual(final.decision.batch, []);
  assert.equal(final.frontier.stateCounts.INVALIDATED, 1);
  assert.ok(packets.some(p => p.decision.batch.length === 2));
  const programme = new ResearchProgramme(s, cfg.spec.researchProgramme!);
  const row = (programme.list() as any).findings.find((f: any) => f.id === "screen");
  const ref = { id: "screen", version: row.version };
  assert.equal(programme.read(ref).assessment.outcome, "REFUTED");
  const knowledge = new ProjectKnowledge(s, cfg), cards: any = knowledge.search(undefined, { query: "screen" });
  const negative = cards.items.find((item: any) => item.kind === "finding");
  assert.match(negative.lesson, /REFUTED/); assert.equal(negative.trust, "CHECKED_SCIENTIFIC_OBSERVATION_WITH_ASSUMPTIONS");
  const later = new Scheduler(s).start([{ ...root("later"), knowledge: [ref] }]);
  assert.deepEqual((researchStrategySnapshot(s, cfg, later) as any).decision.batch, ["alternative"]);
  programme.retract(ref, "Fixture provenance no longer applicable");
  const withdrawn: any = researchStrategySnapshot(s, cfg, later);
  assert.equal(withdrawn.decision.reason, "IMPORTED_FINDING_UNAVAILABLE"); assert.deepEqual(withdrawn.decision.batch, []);
  assert.equal((knowledge.search(undefined, { query: "screen" }) as any).items.find((item: any) => item.id === negative.id).trust,
    "STALE_OR_CONFLICTED_FINDING_REVALIDATE");
}, s => {
  configure(s); s.projectKnowledge = { namespace: "frontier-experience", maxCardsPerTask: 8, maxContextBytes: 8192 };
  s.agents.coder.tools.push("read_knowledge");
}));

test("frontier configuration cannot exceed host parallelism or delegate without bounds", async () => fixture(async (_s, cfg) => {
  const bad = structuredClone(cfg.spec); bad.researchStrategy!.frontier!.maxParallel = 8;
  assert.throws(() => validateSwarmSpec(bad), /parallelism/);
  const unbounded = structuredClone(cfg.spec); delete unbounded.supervision!.dynamicDAG;
  assert.throws(() => validateSwarmSpec(unbounded), /bounded delegation/);
}, configure));

test("a new scientific job cannot bypass frontier reservation by omitting the task requirement", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([root()]), c = q.capsule(q.claim(run, "worker")!);
  let called = false;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async () => { called = true; throw new Error("unexpected submission"); });
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, { id: "bypass", name: "run_job", arguments: {
    name: "screen", input: cfg.spec.jobs!.screen.research!.spec.input } }, signal()), /admitted task assignment/);
  assert.equal(called, false); assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_jobs").get()!.n, 0);
}, configure));

test("old stores backfill the rebuildable projection and the repair command restores it", async () => fixture(async (s, cfg) => {
  const run = new Scheduler(s).start([{ ...root(), research: ["screen"] }]);
  s.db.exec("DROP TABLE research_assignments");
  const migrated = await Store.open(s.root);
  try { assert.equal((researchStrategySnapshot(migrated, cfg, run) as any).reserved, 1); } finally { migrated.close(); }
  s.db.prepare("DELETE FROM research_assignments WHERE run=?").run(run);
  await assert.rejects(handleSwarm(["research-strategy-rebuild", "--root", s.root, "--run", run]), /allow-exec/);
  const repaired: any = await handleSwarm(["research-strategy-rebuild", "--root", s.root, "--run", run, "--allow-exec"]);
  assert.equal(repaired.reserved, 1); assert.equal(repaired.frontier.assigned, 1);
  assert.throws(() => rebuildResearchAssignments(s, "unknown"), /unknown research run/);
}, configure));

test("256 configured protocols remain admissible and a 4096-task run emits only its selected frontier", async () => fixture(async (s, cfg) => {
  const wide = structuredClone(cfg.spec), base = wide.jobs!.screen;
  wide.jobs = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`candidate${i}`, structuredClone(base)]));
  wide.agents.coder.jobs = Object.keys(wide.jobs);
  wide.researchStrategy!.maxExperiments = 256;
  wide.researchStrategy!.candidates = Array.from({ length: 256 }, (_, i) => ({ id: `candidate${i}`, template: `candidate${i}`,
    line: `line${i % 16}`, purpose: "falsification" }));
  validateSwarmSpec(wide);
  const ordinary = structuredClone(wide); delete ordinary.researchStrategy!.frontier;
  ordinary.researchStrategy!.maxExperiments = 32; ordinary.researchStrategy!.candidates = ordinary.researchStrategy!.candidates.slice(0, 32);
  assert.throws(() => validateSwarmSpec(ordinary), /job templates/);
  const run = new Scheduler(s).start(Array.from({ length: 4096 }, (_, i) => root(`task${i}`)));
  const snapshot: any = researchStrategySnapshot(s, { ...cfg, spec: wide }, run);
  assert.equal(snapshot.frontier.considered, 256); assert.equal(snapshot.candidates.length, 2);
  assert.equal(Buffer.byteLength(canonical(snapshot)) <= wide.researchStrategy!.maxSnapshotBytes, true);
  assert.deepEqual(snapshot.decision.batch, ["candidate0", "candidate1"]);
  const plan = s.db.prepare(`EXPLAIN QUERY PLAN SELECT task FROM research_assignments WHERE run=? AND template=? ORDER BY task LIMIT 2`)
    .all(run, "candidate0");
  assert.ok(plan.some(row => /SEARCH.*research_assignments.*INDEX/i.test(String(row.detail))));
}, configure));

test("automatic exact-protocol memory prunes a checked dead end across runs and survives reopen", async () => fixture(async (s, cfg) => {
  await checkedScreen(s, cfg);
  const run = new Scheduler(s).start([root("later")]), snapshot: any = researchStrategySnapshot(s, cfg, run);
  assert.deepEqual(snapshot.decision.batch, ["alternative"]); assert.equal(snapshot.frontier.stateCounts.INVALIDATED, 1);
  assert.equal(snapshot.dossier.records[0].outcome, "REFUTED"); assert.equal(snapshot.deliberation.gear, 1);
  assert.equal((s.readArtifact(snapshot.dossier.records[0].receipt) as any).outcome, "REFUTED");
  assert.equal(snapshot.deliberation.measuredMs, 0); // historical work is not billed to this run
  const reopened = await Store.open(s.root);
  try { assert.deepEqual(researchStrategySnapshot(reopened, cfg, run), snapshot); } finally { reopened.close(); }
  const proposal = propose(s, cfg, run, "avoid-repeat", [{ op: "expand_task", taskId: "later", children: [child("screen")] }]);
  assert.equal(proposal.verdict, "REJECT");
  const changed = structuredClone(cfg); changed.spec.jobs!.screen.research!.spec.assumptions.push("New operating constraint");
  assert.ok((researchStrategySnapshot(s, changed, run) as any).decision.batch.includes("screen"));
  const isolated = structuredClone(cfg); isolated.spec.researchProgramme!.id = "different-project";
  assert.ok((researchStrategySnapshot(s, isolated, run) as any).decision.batch.includes("screen"));
  const disabled = structuredClone(cfg); disabled.spec.researchStrategy!.deliberation!.reuseProgrammeFindings = false;
  assert.ok((researchStrategySnapshot(s, disabled, run) as any).decision.batch.includes("screen"));
}, deliberationPolicy));

test("the negative-knowledge index is bounded, rebuildable and cannot certify stale source acceptance", async () => fixture(async (s, cfg) => {
  const first = await checkedScreen(s, cfg), programme = new ResearchProgramme(s, cfg.spec.researchProgramme!);
  const protocol = digest(cfg.spec.jobs!.screen.research!.spec);
  assert.equal(programme.matching(protocol).findings[0].assessment.outcome, "REFUTED");
  const plan = s.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM research_knowledge_protocols WHERE programme=? AND spec_hash=?")
    .all(cfg.spec.researchProgramme!.id, protocol);
  assert.ok(plan.some(row => /SEARCH.*research_knowledge_protocol/i.test(String(row.detail))));
  s.db.prepare("DELETE FROM research_knowledge_protocols").run();
  assert.deepEqual(programme.matching(protocol).findings, []);
  await assert.rejects(handleSwarm(["knowledge-index-rebuild", "--root", s.root]), /allow-exec/);
  const rebuilt: any = await handleSwarm(["knowledge-index-rebuild", "--root", s.root, "--limit", "1", "--allow-exec"]);
  assert.equal(rebuilt.indexed, 1); assert.equal(rebuilt.complete, true);
  assert.equal(programme.matching(protocol).findings.length, 1);
  const run = new Scheduler(s).start([root("later")]);
  s.db.prepare("UPDATE tasks SET status='FAIL' WHERE run=? AND id='a'").run(first.id);
  const stale: any = researchStrategySnapshot(s, cfg, run);
  assert.equal(stale.decision.reason, "PROGRAMME_MEMORY_UNAVAILABLE"); assert.deepEqual(stale.decision.batch, []);
  assert.throws(() => programme.rebuildProtocolIndex(-1), /page/);
}, deliberationPolicy));

test("indexed protocol contents and explicit revocation are rechecked before memory can suppress work", async () => fixture(async (s, cfg) => {
  await checkedScreen(s, cfg);
  const programme = new ResearchProgramme(s, cfg.spec.researchProgramme!), protocol = digest(cfg.spec.jobs!.screen.research!.spec);
  const f = programme.matching(protocol).findings[0];
  s.db.prepare("UPDATE research_knowledge_protocols SET spec_hash=?").run(digest("wrong-protocol"));
  assert.throws(() => programme.matching(digest("wrong-protocol")), /index drift/);
  programme.rebuildProtocolIndex(); programme.retract({ id: f.id, version: f.version }, "Operating constraints withdrawn");
  assert.deepEqual(programme.matching(protocol).findings, []);
  const run = new Scheduler(s).start([root("later")]);
  assert.ok((researchStrategySnapshot(s, cfg, run) as any).decision.batch.includes("screen"));
}, deliberationPolicy));

test("research time exhaustion rejects new reservations but preserves existing authoritative work", async () => fixture(async (s, cfg) => {
  const first = await checkedScreen(s, cfg), capped = structuredClone(cfg);
  // Host timing is persisted by the job runtime, never submitted by the worker.
  const row = s.db.prepare("SELECT created FROM research_jobs WHERE run=?").get(first.id)!;
  s.db.prepare("UPDATE research_jobs SET updated=? WHERE run=?").run(Number(row.created) + 1000, first.id);
  capped.spec.researchStrategy!.deliberation!.maxResearchMs = 500;
  const snapshot: any = researchStrategySnapshot(s, capped, first.id);
  assert.equal(snapshot.decision.reason, "RESEARCH_TIME_BUDGET_EXHAUSTED"); assert.deepEqual(snapshot.decision.batch, []);
  assert.equal(s.db.prepare("SELECT status FROM tasks WHERE run=? AND id='a'").get(first.id)!.status, "PASS");
}, deliberationPolicy));
