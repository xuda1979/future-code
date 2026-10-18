import test from "node:test";
import assert from "node:assert/strict";
import { canonical } from "../../src/harness/foundry/kernel.ts";
import { ResearchProgramme } from "../../src/harness/foundry/researchProgramme.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { ResearchJobs } from "../../src/harness/foundry/swarm/jobs.ts";
import { verifyResearch } from "../../src/harness/foundry/swarm/research.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { assertTheoryAcceptance, theoryTaskContext } from "../../src/harness/foundry/swarm/theory.ts";
import { WorkflowPolicyAgent } from "../../src/harness/foundry/swarm/workflowPolicy.ts";
import { researchStrategySnapshot } from "../../src/harness/foundry/swarm/researchStrategy.ts";
import { abortable } from "../../src/harness/foundry/swarm/transport.ts";
import { theoreticalResearchExample } from "../../scripts/theory-research-demo.mjs";
import { proofResult } from "../../examples/theoretical-research/proof-executor.mjs";
import { fixture, task, reply, signal } from "./swarm-fixtures.ts";

function configure(s: any, count = 8) {
  const p = theoreticalResearchExample(count);
  s.checks.behavior.argv = [process.execPath, "-e", "process.exit(0)"];
  s.recipe.parallelism = count; s.budget.modelConcurrency = count;
  s.agents.coder.tools.push("run_job", "spawn_tasks"); s.agents.coder.jobs = Object.keys(p.specs);
  s.agents.planner = { ...s.agents.coder, tools: [...s.agents.coder.tools], model: "planner" };
  s.jobs = Object.fromEntries(Object.entries(p.specs).map(([name, spec]) => [name, {
    adapter: p.executor, idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 16, maxConcurrent: count,
    research: { spec, validators: { kernel: p.validator } },
  }]));
  s.researchStrategy = p.strategy;
  s.researchProgramme = { id: "deductive-programme", maxFindingsPerTask: 16, maxContextBytes: 30000 };
  s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 10000,
    dynamicDAG: { maxChildrenPerTask: 16, maxDepth: 2, maxSpawnedTasks: 16 },
    workflowPolicy: { agent: "planner", mode: "apply", minIntervalMs: 100, maxReviews: 64,
      maxOperations: 4, maxSnapshotTasks: 16, maxSnapshotBytes: 16000, maxTaskTimeoutMs: 40000,
      allowedOperations: ["expand_task"] } };
}
const root = () => ({ ...task(), goal: "Establish the exact target through independent lemmas and a checked composition", writeScope: [], readScope: [] });
const child = (name: string) => ({ id: name, goal: `Derive the frozen ${name} statement and submit its certificate`,
  acceptance: ["exact independent deductive validation"], input: {}, writeScope: [], readScope: [], research: [name] });
function jobReply(cfg: any, s: any, request: any) {
  const name = String(s.db.prepare("SELECT template FROM research_jobs WHERE key=?").get(request.key)!.template);
  const packet = proofResult(cfg.spec.jobs[name].research.spec, { key: request.key, jobId: request.key });
  return { schema: 1, key: request.key, jobId: request.key, status: "SUCCEEDED",
    result: { exitCode: 0, data: packet.result, artifacts: packet.artifacts } };
}
function workerOnly() {
  const turns = new Map<string, number>();
  return (async (_url: any, init: any) => {
    const body = JSON.parse(init.body), packet = JSON.parse(body.messages.find((m: any) => m.role === "user").content);
    const id = packet.task.id, turn = turns.get(id) ?? 0; turns.set(id, turn + 1);
    return turn === 0 && packet.task.research?.length ? reply("", [{ name: "run_job", arguments: { name: packet.task.research[0], input: {} } }]) : reply("Ready for independent checking");
  }) as typeof fetch;
}

test("workflow-managed eight-agent lemma research composes checked results and retains exact invalidatable programme dependencies", async () => fixture(async (s, cfg) => {
  const turns = new Map<string, number>(), batches: string[][] = []; let active = 0, peak = 0, starts = 0;
  let release!: () => void; const started = new Promise<void>(resolve => { release = resolve; });
  const fetcher = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body), packet = JSON.parse(body.messages.find((m: any) => m.role === "user").content);
    if (body.model === "planner") {
      const names: string[] = packet.researchStrategy.decision.batch;
      const operations = names.length ? [{ op: "expand_task", taskId: "a", children: names.map(child) }] : [];
      if (names.length) batches.push(names);
      return reply("", [{ name: "propose_workflow", arguments: { schema: 1, reason: "Discharge the current independent proof obligations",
        expectedGraphVersion: packet.observation.graphVersion, expectedPolicyVersion: packet.observation.policyVersion,
        expectedStateVersion: packet.observation.stateVersion, operations } }]);
    }
    const id = packet.task.id, turn = turns.get(id) ?? 0; turns.set(id, turn + 1);
    if (packet.task.research?.length && turn === 0) {
      assert.equal(packet.theoretical.items[0].ready, true);
      assert.match(packet.contract, /counterexamples and gap audits/);
      if (packet.task.research[0] === "theorem") assert.equal(packet.theoretical.items[0].premises.length, 8);
      return reply("", [{ name: "run_job", arguments: { name: packet.task.research[0], input: {} } }]);
    }
    return reply("Certificate ready for independent checking");
  }) as typeof fetch;
  const rpc = async (_cmd: any, _cfg: any, request: any, signal: AbortSignal) => {
    const name = String(s.db.prepare("SELECT template FROM research_jobs WHERE key=?").get(request.key)!.template);
    if (name.startsWith("lemma")) {
      starts++; active++; peak = Math.max(peak, active); if (starts === 8) release();
      await abortable(started, signal); active--;
    }
    return jobReply(cfg, s, request);
  };
  const driver = new SwarmDriver(s, cfg, fetcher, undefined, rpc as any), policy = new WorkflowPolicyAgent(s, cfg, fetcher);
  const result = await runTasks(s, [{ ...root(), research: ["theorem"] }], driver, { signal: signal(), beforeRefill: (run, signal) => policy.review(run, signal) });
  assert.equal(result.status, "PASS", JSON.stringify(s.db.prepare("SELECT id,error FROM tasks").all()));
  assert.equal(peak, 8); assert.deepEqual(batches.map(b => b.length), [8]);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_jobs").get()!.n, 9);
  const programme = new ResearchProgramme(s, cfg.spec.researchProgramme!), page: any = programme.list();
  const theorem = page.findings.find((f: any) => f.id === "theorem"), lemmas = page.findings.filter((f: any) => f.id.startsWith("lemma"));
  const theoremRef = { id: theorem.id, version: theorem.version }, refs = lemmas.map((f: any) => ({ id: f.id, version: f.version }));
  assert.equal(programme.read(theoremRef).assessment.theory!.status, "ESTABLISHED");
  assert.equal(programme.read(theoremRef).dependencies.length, 8);
  const concise: any = programme.context(refs, { theoryStatementsOnly: true });
  const complete: any = programme.context(refs);
  assert.equal(concise.findings[0].statement, complete.findings[0].spec.theory.statement);
  assert.deepEqual(concise.assumptionSets[concise.findings[0].assumptionsHash], complete.findings[0].spec.assumptions);
  assert.ok(Buffer.byteLength(canonical(concise)) < Buffer.byteLength(canonical(complete)));
  const snapshot: any = researchStrategySnapshot(s, cfg, result.id);
  assert.equal(snapshot.frontier.theory.stateCounts.ESTABLISHED, 9);
  const reopened = await Store.open(s.root);
  try { assert.deepEqual(new ResearchProgramme(reopened, cfg.spec.researchProgramme!).read(theoremRef), programme.read(theoremRef)); }
  finally { reopened.close(); }
  // A later run imports checked lemmas by exact version, without rerunning them.
  const laterTask = { ...root(), id: "reuse", research: ["theorem"], knowledge: refs };
  const later = await runTasks(s, [laterTask], new SwarmDriver(s, cfg, workerOnly(), undefined,
    (async (_cmd: any, _cfg: any, request: any) => jobReply(cfg, s, request)) as any), { signal: signal() });
  assert.equal(later.status, "PASS", JSON.stringify(s.db.prepare("SELECT id,error FROM tasks WHERE run=?").all(later.id)));
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_jobs WHERE run=?").get(later.id)!.n, 1);
  assertTheoryAcceptance(s, cfg, { runId: later.id, task: laterTask } as any);
  programme.retract(refs[0], "A project assumption has been withdrawn");
  const current: any = programme.list(), latest = current.findings.find((f: any) => f.id === "theorem");
  assert.throws(() => programme.read({ id: latest.id, version: latest.version }), /stale/);
  assert.throws(() => assertTheoryAcceptance(s, cfg, { runId: later.id, task: laterTask } as any), /retracted/);
  assert.ok(programme.read(theoremRef, true).assessmentHash);
}, configure));

test("missing proof prerequisites block direct jobs without spending remote capacity or confusing advisory notes with acceptance", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([{ ...root(), research: ["theorem"] }]), c = q.capsule(q.claim(run, "worker")!);
  const context: any = theoryTaskContext(s, cfg, c, 16000); assert.equal(context.items[0].ready, false);
  let calls = 0;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async () => { calls++; throw new Error("must not submit"); });
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, { id: "bypass", name: "run_job", arguments: { name: "theorem", input: {} } }, signal()), /not established/);
  assert.equal(calls, 0); assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_jobs").get()!.n, 0);
}, s => configure(s, 2)));

test("revocation between verification and commit rolls back theorem acceptance and programme publication", async () => fixture(async (s, cfg) => {
  const rpc = (async (_cmd: any, _cfg: any, request: any) => jobReply(cfg, s, request)) as any;
  const result = await runTasks(s, ["lemma0", "lemma1"].map(name => ({ ...root(), id: name, research: [name] })),
    new SwarmDriver(s, cfg, workerOnly(), undefined, rpc), { signal: signal() });
  assert.equal(result.status, "PASS");
  const programme = new ResearchProgramme(s, cfg.spec.researchProgramme!), page: any = programme.list();
  const refs = page.findings.map((f: any) => ({ id: f.id, version: f.version }));
  const driver = new SwarmDriver(s, cfg, workerOnly(), undefined, rpc), verify = driver.verify.bind(driver);
  driver.verify = async (c, result, signal, control) => {
    const checked = await verify(c, result, signal, control);
    assert.ok(checked.checks.every(c => c.verdict === "PASS"));
    programme.retract(refs[0], "Revoke between independent checking and commit");
    return checked;
  };
  const theorem = await runTasks(s, [{ ...root(), id: "composition", research: ["theorem"], knowledge: refs }], driver, { signal: signal() });
  assert.equal(theorem.status, "FAIL");
  assert.equal(s.db.prepare("SELECT status FROM tasks WHERE run=?").get(theorem.id)!.status, "FAIL");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_knowledge_heads WHERE id='theorem'").get()!.n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM fabric_evidence WHERE run=? AND source='foundry-independent-verifier'").get(theorem.id)!.n, 0);
}, s => { configure(s, 2); s.recipe.attempts = 1; }));

test("revoking a premise after submission preserves reconciliation and prevents independent acceptance", async () => fixture(async (s, cfg) => {
  const worker = workerOnly(), rpc = (async (_cmd: any, _cfg: any, request: any) => jobReply(cfg, s, request)) as any;
  const lemmas = ["lemma0", "lemma1"].map(name => ({ ...root(), id: name, research: [name] }));
  const result = await runTasks(s, lemmas, new SwarmDriver(s, cfg, worker, undefined, rpc), { signal: signal() });
  assert.equal(result.status, "PASS");
  const programme = new ResearchProgramme(s, cfg.spec.researchProgramme!), page: any = programme.list();
  const refs = page.findings.map((f: any) => ({ id: f.id, version: f.version }));
  const q = new Scheduler(s), run = q.start([{ ...root(), id: "composition", research: ["theorem"], knowledge: refs }]);
  const c = q.capsule(q.claim(run, "worker")!), call = { id: "submit", name: "run_job", arguments: { name: "theorem", input: {} } };
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, rpc);
  const terminal = await jobs.execute(c, cfg.spec.agents.coder, call, signal());
  assert.equal((terminal as any).status, "SUCCEEDED");
  programme.retract(refs[0], "Withdraw an assumption while the job is awaiting verification");
  let replayCalls = 0;
  const reopened = await Store.open(s.root);
  try {
    const replay = new ResearchJobs(new SessionJournal(reopened), cfg, async () => { replayCalls++; throw new Error("must reuse terminal job"); });
    assert.deepEqual(await replay.execute(c, cfg.spec.agents.coder, { ...call, id: "after-restart" }, signal()), terminal);
    assert.equal(replayCalls, 0);
    const check = await verifyResearch(reopened, cfg, c, signal());
    assert.equal(check.verdict, "FAIL"); assert.match(check.detail!, /retracted/);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) n FROM research_assessments WHERE run=?").get(run)!.n, 0);
  } finally { reopened.close(); }
}, s => configure(s, 2)));

test("same-run theory tasks enforce exact lemma closure without enabling the programme ledger", async () => fixture(async (s, cfg) => {
  const lemmas = ["lemma0", "lemma1"].map(name => ({ ...root(), id: name, research: [name] }));
  const theorem = { ...root(), id: "composition", dependencies: ["lemma0", "lemma1"], research: ["theorem"] };
  const driver = new SwarmDriver(s, cfg, workerOnly(), undefined,
    (async (_cmd: any, _cfg: any, request: any) => jobReply(cfg, s, request)) as any);
  assert.ok(driver.accepted);
  const result = await runTasks(s, [...lemmas, theorem], driver, { signal: signal() });
  assert.equal(result.status, "PASS", JSON.stringify(s.db.prepare("SELECT id,error FROM tasks").all()));
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_assessments WHERE outcome='SUPPORTED'").get()!.n, 3);
}, s => { configure(s, 2); delete s.researchProgramme; }));
