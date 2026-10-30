import test from "node:test";
import assert from "node:assert/strict";
import { ResearchProgramme, validateKnowledgeRefs, type KnowledgeRef } from "../../src/harness/foundry/researchProgramme.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { validateSwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { decodeSpawnChildren } from "../../src/harness/foundry/swarm/spawn.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { handleSwarm } from "../../src/harness/foundry/swarm/cli.ts";
import { bellExperiment, simulateQuantum } from "../../scripts/quantum-experiment.mjs";
import { fixture, task, signal, scripted, reply, spec } from "./swarm-fixtures.ts";

function configure(s: any) {
  s.researchProgramme = { id: "physics", maxFindingsPerTask: 4, maxContextBytes: 24000 };
  s.jobs = Object.fromEntries(["bell", "followup", "leaf"].map(name => [name, {
    adapter: { argv: [process.execPath, "-e", "process.exit(0)"] }, research: { spec: bellExperiment() },
    idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 20, maxConcurrent: 2,
  }]));
  s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = ["bell", "followup", "leaf"];
}
function programme(s: any, cfg: any) { return new ResearchProgramme(s, cfg.spec.researchProgramme); }
function current(p: ResearchProgramme, id: string): KnowledgeRef {
  const row = (p.list() as any).findings.find((f: any) => f.id === id); return { id, version: row.version };
}
async function run(s: any, cfg: any, name?: string, knowledge: KnowledgeRef[] = [], refute = false) {
  const protocol = cfg.spec.jobs!.bell.research!.spec;
  const mock = scripted([
    ...(name ? [() => reply("", [{ name: "run_job", arguments: { name, input: protocol.input } }])] : []),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("ready for independent checks"),
  ]);
  const driver = new SwarmDriver(s, cfg, mock.fetcher, undefined, async (_c, _cfg, input: any) => {
    const data = simulateQuantum(protocol);
    if (refute) data.circuits[1].counts = { "01": 4096 };
    return { schema: 1, key: input.key, jobId: input.key, status: "SUCCEEDED", result: { exitCode: 0, data } };
  });
  const result = await runTasks(s, [{ ...task(), ...(name ? { research: [name] } : {}), knowledge }], driver, { signal: signal() });
  assert.equal(result.status, "PASS", JSON.stringify(s.db.prepare("SELECT error FROM tasks WHERE run=?").all(result.id)));
  return { result, mock };
}

test("programme findings survive reopen and enter later runs only through explicit exact references", async () => fixture(async (s, cfg) => {
  const first = await run(s, cfg, "bell"), p = programme(s, cfg), ref = current(p, "bell");
  const record = p.read(ref);
  assert.equal(record.origin.run, first.result.id); assert.equal(record.assessment.outcome, "SUPPORTED");
  const reopened = await Store.open(s.root);
  try { assert.deepEqual(new ResearchProgramme(reopened, cfg.spec.researchProgramme!).read(ref), record); }
  finally { reopened.close(); }
  const imported = await run(s, cfg, undefined, [ref]);
  const initial = JSON.parse(imported.mock.bodies[0].messages.find((m: any) => m.role === "user").content);
  assert.equal(initial.knowledge.findings[0].version, ref.version);
  assert.equal(initial.knowledge.trust, "VERIFIED_OBSERVATIONS_WITH_ASSUMPTIONS");
  const isolated = await run(s, cfg);
  assert.ok(!isolated.mock.bodies[0].messages.some((m: any) => m.content?.includes(ref.version)));
  assert.equal((p.list("bell", 1) as any).findings.length, 0);
}, configure));

test("superseding an exact finding invalidates transitive dependents while retaining history", async () => fixture(async (s, cfg) => {
  const p = programme(s, cfg);
  await run(s, cfg, "bell"); const first = current(p, "bell");
  await run(s, cfg, "followup", [first]); const second = current(p, "followup");
  await run(s, cfg, "leaf", [second]); const third = current(p, "leaf");
  await run(s, cfg, "bell"); const next = current(p, "bell");
  assert.notEqual(first.version, next.version);
  for (const ref of [first, second, third]) {
    assert.throws(() => p.context([ref]), /stale|superseded/);
    assert.equal(p.read(ref, true).version, ref.version);
  }
  assert.equal(p.read(next).assessment.outcome, "SUPPORTED");
  const states = (p.list() as any).findings.map((f: any) => f.state); assert.deepEqual(states, ["ACTIVE", "STALE", "STALE"]);
}, configure));

test("contradictory accepted observations remain conflicted despite subsequent agreeing replications", async () => fixture(async (s, cfg) => {
  const p = programme(s, cfg);
  await run(s, cfg, "bell"); const first = current(p, "bell");
  await run(s, cfg, "bell", [], true); const contrary = current(p, "bell");
  assert.equal(p.read(first, true).assessment.outcome, "SUPPORTED");
  assert.equal(p.read(contrary, true).assessment.outcome, "REFUTED");
  assert.throws(() => p.context([contrary]), /conflicted/);
  assert.equal(p.matching(digest(cfg.spec.jobs!.bell.research!.spec)).conflicted, true);
  await run(s, cfg, "bell");
  assert.throws(() => p.context([current(p, "bell")]), /conflicted/);
  assert.equal((p.list() as any).findings[0].state, "CONFLICTED");
}, configure));

test("operator retraction invalidates dependents without deleting source evidence", async () => fixture(async (s, cfg) => {
  const p = programme(s, cfg);
  await run(s, cfg, "bell"); const parent = current(p, "bell");
  await run(s, cfg, "followup", [parent]); const child = current(p, "followup");
  p.retract(parent, "Calibration assumptions no longer hold.");
  assert.throws(() => p.read(parent), /retracted/); assert.throws(() => p.read(child), /stale/);
  assert.equal(p.read(parent, true).assessment.outcome, "SUPPORTED");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='research.knowledge.retracted'").get()!.n, 1);
  await run(s, cfg, "bell");
  assert.throws(() => p.read(current(p, "bell")), /retracted/); // replaying the same protocol cannot erase revocation
}, configure));

test("unaccepted sources, oversized imports and child authority expansion are rejected", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), runId = q.start([task()]), c = q.capsule(q.claim(runId, "x")!), p = programme(s, cfg);
  assert.throws(() => p.accepted(c, digest({}), digest({}), {}), /accepted source/);
  await run(s, cfg, "bell"); const ref = current(p, "bell");
  assert.throws(() => new ResearchProgramme(s, { ...cfg.spec.researchProgramme!, maxContextBytes: 10 }).context([ref]), /context/);
  assert.throws(() => validateKnowledgeRefs([ref, ref]), /references/);
  assert.throws(() => p.read({ ...ref, version: "f".repeat(64) }), /unknown/);
  const allowed: any = structuredClone(cfg.spec); allowed.supervision = { reportEveryMs: 1000, checkpointEveryMs: 1000,
    dynamicDAG: { maxChildrenPerTask: 3, maxDepth: 2, maxSpawnedTasks: 10 } };
  const child = { id: "child", goal: "inspect", acceptance: ["verified"], input: {}, writeScope: [], readScope: [], knowledge: [ref] };
  assert.throws(() => decodeSpawnChildren(allowed, task(), [child]), /widens/);
  assert.deepEqual(decodeSpawnChildren(allowed, { ...task(), knowledge: [ref] }, [child])[0].knowledge, [ref]);
}, configure));

test("programme configuration bounds imports and rejects ambiguous publication names", () => {
  const s = spec("/fixture"); configure(s); validateSwarmSpec(s);
  for (const max of [0, 33]) {
    const bad = structuredClone(s); bad.researchProgramme!.maxFindingsPerTask = max; assert.throws(() => validateSwarmSpec(bad));
  }
  const bad = structuredClone(s); bad.jobs!.followup.research!.provides = "bell";
  assert.throws(() => validateSwarmSpec(bad), /duplicate/);
});

test("publication failure rolls back task acceptance and exports together", async () => fixture(async (s, cfg) => {
  const protocol = cfg.spec.jobs!.bell.research!.spec;
  const mock = scripted([
    () => reply("", ["bell", "followup"].map(name => ({ name: "run_job", arguments: { name, input: protocol.input } }))),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("done"),
  ]);
  const driver = new SwarmDriver(s, cfg, mock.fetcher, undefined, async (_c, _cfg, input: any) => ({
    schema: 1, key: input.key, jobId: input.key, status: "SUCCEEDED", result: { exitCode: 0, data: simulateQuantum(protocol) },
  }));
  const result = await runTasks(s, [{ ...task(), research: ["bell", "followup"] }], driver, { signal: signal() });
  assert.equal(result.status, "FAIL");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_knowledge").get()!.n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM tasks WHERE status='PASS'").get()!.n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='research.knowledge.published'").get()!.n, 0);
}, s => { configure(s); s.researchProgramme!.maxFindingsPerTask = 1; s.recipe.attempts = 1; }));

test("content-bound closure blocks stale reuse even when a reverse invalidation edge is missing", async () => fixture(async (s, cfg) => {
  const p = programme(s, cfg);
  await run(s, cfg, "bell"); const parent = current(p, "bell");
  await run(s, cfg, "followup", [parent]); const child = current(p, "followup");
  await run(s, cfg, "leaf", [child]); const leaf = current(p, "leaf");
  // Model an incomplete derived SQL index. Immutable finding contents still
  // contain the exact parent reference, so they must control reuse.
  s.db.prepare("DELETE FROM research_knowledge_dependencies WHERE programme=? AND parent=?").run("physics", parent.version);
  p.retract(parent, "Upstream premise was falsified");
  assert.equal((p.list() as any).findings.find((f: any) => f.id === child.id).state, "ACTIVE");
  assert.throws(() => p.read(child), /retracted/);
  assert.throws(() => p.read(leaf), /retracted/);
  assert.throws(() => p.context([leaf]), /retracted/);
  assert.throws(() => p.certificate([leaf]), /retracted/);
  assert.equal(p.read(leaf, true).version, leaf.version);
  let modelCalls = 0;
  const driver = new SwarmDriver(s, cfg, (async () => { modelCalls++; throw new Error("invalid import reached provider"); }) as typeof fetch);
  const result = await runTasks(s, [{ ...task(), knowledge: [leaf] }], driver, { signal: signal() });
  assert.equal(result.status, "FAIL"); assert.equal(result.accepted, 0); assert.equal(modelCalls, 0);
}, configure));

test("dependency certificates deduplicate shared ancestors, bind exact evidence and survive restart", async () => fixture(async (s, cfg) => {
  const p = programme(s, cfg);
  await run(s, cfg, "bell"); const first = current(p, "bell");
  await run(s, cfg, "followup", [first]); const second = current(p, "followup");
  await run(s, cfg, "leaf", [first, second]); const third = current(p, "leaf");
  const certificate: any = p.certificate([third, first]);
  assert.equal(certificate.nodes.length, 3); assert.equal(new Set(certificate.nodes.map((n: any) => n.version)).size, 3);
  assert.deepEqual(certificate, p.certificate([first, third]));
  const { certificateHash, ...body } = certificate; assert.equal(digest(body), certificateHash);
  for (const node of certificate.nodes) {
    const record = p.read({ id: node.id, version: node.version });
    assert.equal(node.recordHash, digest(record)); assert.equal(node.assessmentHash, record.assessmentHash);
    assert.deepEqual(node.origin, record.origin);
  }
  assert.throws(() => p.certificate([third], 2), /closure exceeds bound/);
  for (const limit of [0, 257, Infinity]) assert.throws(() => p.certificate([third], limit), /bound/);
  const reopened = await Store.open(s.root);
  try { assert.deepEqual(new ResearchProgramme(reopened, cfg.spec.researchProgramme!).certificate([third, first]), certificate); }
  finally { reopened.close(); }
  const viaCLI = await handleSwarm(["knowledge-certificate", "--root", s.root, "--finding", third.id, "--version", third.version, "--limit", "3"]);
  assert.deepEqual(viaCLI, p.certificate([third]));
  await assert.rejects(handleSwarm(["knowledge-certificate", "--root", s.root, "--finding", third.id, "--version", third.version, "--limit", "2"]), /bound/);
}, configure));

test("a dependency losing source acceptance invalidates active descendants at read time", async () => fixture(async (s, cfg) => {
  const p = programme(s, cfg);
  await run(s, cfg, "bell"); const parent = current(p, "bell");
  await run(s, cfg, "followup", [parent]); const child = current(p, "followup"), source = p.read(parent).origin;
  s.db.prepare("UPDATE tasks SET status='FAIL' WHERE run=? AND id=?").run(source.run, source.task);
  assert.throws(() => p.read(child), /source acceptance changed/);
  assert.throws(() => p.context([child]), /source acceptance changed/);
  // Historical inspection of the child retains its original accepted receipt.
  assert.equal(p.read(child, true).dependencies[0].version, parent.version);
}, configure));
