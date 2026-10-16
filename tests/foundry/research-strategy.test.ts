import test from "node:test";
import assert from "node:assert/strict";
import { selectResearchStrategy, validateResearchStrategy, type ResearchStrategy } from "../../src/harness/foundry/researchStrategy.ts";
import { compareResearchStrategies } from "../../src/harness/foundry/researchEvaluation.ts";
import { pinCommand } from "../../src/harness/foundry/commands.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { ResearchProgramme } from "../../src/harness/foundry/researchProgramme.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { ResearchJobs } from "../../src/harness/foundry/swarm/jobs.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { WorkflowPolicyAgent } from "../../src/harness/foundry/swarm/workflowPolicy.ts";
import { researchStrategySnapshot } from "../../src/harness/foundry/swarm/researchStrategy.ts";
import { validateSwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { bellExperiment, simulateQuantum } from "../../scripts/quantum-experiment.mjs";
import { quantumComparisonProtocol } from "../../scripts/research-strategy-demo.mjs";
import { fixture, task, signal, reply } from "./swarm-fixtures.ts";

const strategy = (): ResearchStrategy => structuredClone(quantumComparisonProtocol().cases[0].strategy);
// These are trusted-host observation fixtures, not model-authored acceptance.
const observed = (candidate: string, outcome: any, key = "receipt") => ({ key, candidate,
  assessment: { schema: 1 as const, specHash: digest("spec"), resultHash: digest(outcome), outcome, estimates: [], assumptions: [] } });

test("strategy prioritizes falsification, honours evidence conditions and abstains at ceilings or uncertainty", () => {
  const s = strategy(); assert.equal(selectResearchStrategy(s, [], 0).next, "screen");
  assert.equal(selectResearchStrategy(s, [observed("screen", "REFUTED")], 1).next, null);
  assert.equal(selectResearchStrategy(s, [observed("screen", "SUPPORTED")], 1).next, "detailed");
  assert.equal(selectResearchStrategy(s, [], 2).reason, "EXPERIMENT_BUDGET_EXHAUSTED");
  assert.equal(selectResearchStrategy(s, [], 1, ["screen"]).next, null);
  s.candidates[0].after = [{ candidate: "screen", outcomes: ["INCONCLUSIVE"] }];
  assert.equal(selectResearchStrategy(s, [observed("screen", "SUPPORTED")], 1).next, null);
  assert.equal(selectResearchStrategy(s, [observed("screen", "INCONCLUSIVE")], 1).next, "detailed");
  s.candidates[0].purpose = "falsification"; delete s.candidates[0].after;
  assert.equal(selectResearchStrategy(s, [], 0, [], { screen: 10, detailed: 500 }).next, "screen");
});

test("contradictions and replay drift cannot become votes or confidence scores", () => {
  const s = strategy(); s.stopOnRefutation = false;
  const both = [observed("screen", "SUPPORTED", "a"), observed("screen", "REFUTED", "b")];
  assert.equal(selectResearchStrategy(s, both, 0).next, null);
  assert.equal(selectResearchStrategy(s, [...both, observed("screen", "SUPPORTED", "c")], 0).next, null);
  assert.throws(() => selectResearchStrategy(s, [observed("screen", "SUPPORTED"), observed("screen", "REFUTED")], 0), /drift/);
  const cyclic = strategy(); cyclic.candidates[0].after = [{ candidate: "screen", outcomes: ["SUPPORTED"] }];
  cyclic.candidates[1].after = [{ candidate: "detailed", outcomes: ["SUPPORTED"] }];
  assert.throws(() => validateResearchStrategy(cyclic), /cyclic/);
  assert.throws(() => validateResearchStrategy({ ...s, maxExperiments: Infinity }));
});

test("matched quantum experiment comparison preserves refutations and records actual avoided work", async () => {
  const p = quantumComparisonProtocol(), report = await compareResearchStrategies(p, pinCommand(p.executor, process.cwd()), signal());
  assert.equal(report.allEvidenceValid, true); assert.equal(report.totalJobsSaved, 1);
  const [negative, positive] = report.cases;
  assert.deepEqual(negative.arms.adaptive.refutedLines, ["preparation"]);
  assert.equal(negative.sameRefutedLines, true); assert.equal(negative.arms["static-all"].jobs, 2); assert.equal(negative.arms.adaptive.jobs, 1);
  assert.equal(positive.arms.adaptive.jobs, 2); assert.equal(positive.arms["static-all"].jobs, 2);
  assert.deepEqual(negative.order, ["static-all", "adaptive"]); assert.deepEqual(positive.order, ["adaptive", "static-all"]);
  for (const c of report.cases) for (const arm of Object.values(c.arms) as any[]) {
    assert.equal(arm.costUsd, null); assert.equal(arm.tokens, null); assert.ok(arm.durationMs >= 0);
    for (const r of arm.records) assert.ok(r.resultHash && r.assessment.specHash === r.specHash && r.durationMs >= 0);
  }
});

test("local comparison fails closed on malformed evidence, mismatched executors and deadlines", async () => {
  const p = quantumComparisonProtocol(); p.cases = p.cases.slice(0, 1);
  p.executor = { argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify({result:{score:1}}))"] };
  const bad = await compareResearchStrategies(p, pinCommand(p.executor, process.cwd()), signal());
  assert.equal(bad.allEvidenceValid, false);
  for (const arm of Object.values(bad.cases[0].arms) as any[]) assert.equal(arm.validExperiments, 0);
  await assert.rejects(compareResearchStrategies(p, pinCommand({ argv: [process.execPath, "-e", "process.exit(0)"] }, process.cwd()), signal()), /differs/);
  p.executor = { argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }; p.maxArmMs = 100;
  const hung = await compareResearchStrategies(p, pinCommand(p.executor, process.cwd()), signal());
  for (const arm of Object.values(hung.cases[0].arms) as any[]) assert.equal(arm.status, "TIMED_OUT");
  assert.equal(hung.allEvidenceValid, false);
});

function configure(s: any) {
  s.agents.planner = { ...s.agents.coder, tools: [...s.agents.coder.tools], model: "workflow-model" };
  s.jobs = Object.fromEntries(["screen", "detailed"].map(name => [name, {
    adapter: { argv: [process.execPath, "-e", "process.exit(0)"] }, research: { spec: bellExperiment(true) },
    idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 4, maxConcurrent: 2,
  }]));
  s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = ["screen", "detailed"];
  s.researchStrategy = strategy();
  s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 10000,
    dynamicDAG: { maxChildrenPerTask: 4, maxDepth: 2, maxSpawnedTasks: 8 },
    workflowPolicy: { agent: "planner", mode: "apply", minIntervalMs: 100, maxReviews: 16,
      maxOperations: 4, maxSnapshotTasks: 8, maxSnapshotBytes: 12000, maxTaskTimeoutMs: 40000,
      allowedOperations: ["expand_task", "set_task_timeout", "set_parallelism"] } };
}

test("unaccepted remote observations cannot drive a strategy decision; snapshots remain bounded", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "x")!);
  const protocol = cfg.spec.jobs!.screen.research!.spec;
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async (_c, _cfg, input: any) => ({
    schema: 1, key: input.key, jobId: input.key, status: "SUCCEEDED", result: { exitCode: 0, data: simulateQuantum(protocol) },
  }));
  await jobs.execute(c, cfg.spec.agents.coder, { id: "remote", name: "run_job", arguments: { name: "screen", input: protocol.input } }, signal());
  const packet: any = researchStrategySnapshot(s, cfg, run);
  assert.deepEqual(packet.observations, []); assert.deepEqual(packet.unresolved, ["screen"]); assert.equal(packet.decision.next, null);
  const tiny = structuredClone(cfg); tiny.spec.researchStrategy!.maxSnapshotBytes = 1024;
  for (const j of Object.values(tiny.spec.jobs!)) { j.research!.spec.question = "q".repeat(8000); j.research!.spec.hypothesis = "h".repeat(8000); }
  assert.throws(() => researchStrategySnapshot(s, tiny, run), /byte bound/);
}, configure));

test("independent workflow role uses verified refutation to stop an optional research branch", async () => fixture(async (s, cfg) => {
  const packets: any[] = []; let spawned = false;
  const turns = new Map<string, number>();
  const fetcher = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body), packet = JSON.parse(body.messages.find((m: any) => m.role === "user").content);
    if (body.model === "workflow-model") {
      packets.push(packet.researchStrategy);
      const page = packet.observation, operations: any[] = [];
      if (!spawned && packet.researchStrategy.decision.next === "screen") {
        spawned = true; operations.push({ op: "expand_task", taskId: "a", children: [{ id: "screen", goal: "Run the pinned falsification experiment",
          acceptance: ["independent experiment and behavior checks"], input: {}, research: ["screen"], writeScope: ["src/a.txt"], readScope: ["src"] }] });
      }
      return reply("", [{ name: "propose_workflow", arguments: { schema: 1, expectedGraphVersion: page.graphVersion,
        expectedPolicyVersion: page.policyVersion, expectedStateVersion: page.stateVersion,
        reason: "Use the host's verified experimental outcome", operations } }]);
    }
    const id = packet.task.id, turn = turns.get(id) ?? 0; turns.set(id, turn + 1);
    if (id === "a.screen" && turn === 0) return reply("", [{ name: "run_job", arguments: { name: "screen", input: cfg.spec.jobs!.screen.research!.spec.input } }]);
    if (turn === (id === "a.screen" ? 1 : 0)) return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    return reply("ready for independent acceptance");
  }) as typeof fetch;
  const driver = new SwarmDriver(s, cfg, fetcher, undefined, async (_c, _cfg, input: any) => ({ schema: 1,
    key: input.key, jobId: input.key, status: "SUCCEEDED", result: { exitCode: 0, data: simulateQuantum(cfg.spec.jobs!.screen.research!.spec) } }));
  const policy = new WorkflowPolicyAgent(s, cfg, fetcher);
  const result = await runTasks(s, [task()], driver, { signal: signal(), beforeRefill: (run, signal) => policy.review(run, signal) });
  assert.equal(result.status, "PASS", JSON.stringify(s.db.prepare("SELECT id,error FROM tasks").all()));
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM spawn_edges").get()!.n, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_jobs").get()!.n, 1);
  const final: any = researchStrategySnapshot(s, cfg, result.id);
  assert.equal(final.observations[0].outcome, "REFUTED"); assert.equal(final.decision.next, null);
  assert.ok(packets.some(p => p.observations.some((o: any) => o.outcome === "REFUTED")));
  assert.ok(packets.every(p => !JSON.stringify(p).includes("sourceReceipt")));
  const programme = new ResearchProgramme(s, cfg.spec.researchProgramme!);
  const finding = (programme.list() as any).findings.find((f: any) => f.id === "screen");
  const ref = { id: finding.id, version: finding.version };
  const later = new Scheduler(s).start([{ ...task(), knowledge: [ref] }]);
  const imported: any = researchStrategySnapshot(s, cfg, later);
  assert.equal(imported.used, 0); assert.equal(imported.observations[0].outcome, "REFUTED");
  assert.equal(imported.decision.next, null);
  programme.retract(ref, "Simulator assumptions changed");
  assert.equal((researchStrategySnapshot(s, cfg, later) as any).decision.reason, "IMPORTED_FINDING_UNAVAILABLE");
}, s => { configure(s); s.researchProgramme = { id: "quantum", maxFindingsPerTask: 4, maxContextBytes: 24000 }; }));

test("strategy configuration requires a separate bounded workflow role and scientific templates", async () => fixture(async (_s, cfg) => {
  validateSwarmSpec(cfg.spec);
  const noRole = structuredClone(cfg.spec); delete noRole.supervision!.workflowPolicy;
  assert.throws(() => validateSwarmSpec(noRole), /independent/);
  const unknown = structuredClone(cfg.spec); unknown.researchStrategy!.candidates[0].template = "unreviewed";
  assert.throws(() => validateSwarmSpec(unknown), /pinned/);
}, configure));
