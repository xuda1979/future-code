import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { superviseSwarm, objectiveEvidenceGate, installObjectives } from "../../src/harness/foundry/swarm/supervisor.ts";
import { integrateSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { ResearchProgramme } from "../../src/harness/foundry/researchProgramme.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { assertScientificObligations, objectiveScientificObligations, scientificObligations } from "../../src/harness/foundry/swarm/scientificAcceptance.ts";
import { LocalGitHands } from "../../src/harness/foundry/swarm/workspace.ts";
import type { Task } from "../../src/harness/foundry/types.ts";
import { theoreticalResearchExample } from "../../scripts/theory-research-demo.mjs";
import { proofResult } from "../../examples/theoretical-research/proof-executor.mjs";
import { fixture, task, reply, signal } from "./swarm-fixtures.ts";

function configure(s: any) {
  const p = theoreticalResearchExample(2);
  const folder = dirname(s.project), adapter = join(folder, "proof-rpc.mjs");
  const executor = fileURLToPath(new URL("../../examples/theoretical-research/proof-executor.mjs", import.meta.url));
  writeFileSync(adapter, `import {readFileSync} from 'node:fs';\nimport {proofResult} from ${JSON.stringify(executor)};\n` +
    `const r=JSON.parse(readFileSync(0,'utf8')),s=JSON.parse(readFileSync(process.argv[2],'utf8'));\n` +
    `const p=proofResult(s,{key:r.key,jobId:r.key});\n` +
    `console.log(JSON.stringify({schema:1,key:r.key,jobId:r.key,status:'SUCCEEDED',result:{exitCode:0,data:p.result,artifacts:p.artifacts}}));\n`);
  s.checks.behavior.argv = [process.execPath, "-e", "process.exit(0)"];
  s.recipe.attempts = 1;
  s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = Object.keys(p.specs);
  s.jobs = Object.fromEntries(Object.entries(p.specs).map(([name, spec]) => {
    const path = join(folder, `${name}.json`); writeFileSync(path, JSON.stringify(spec));
    return [name, {
    adapter: { argv: [process.execPath, "--experimental-strip-types", adapter, path], files: [executor] },
    idempotentEnsure: true, pollMs: 10, staleMs: 10000, maxJobs: 16, maxConcurrent: 2,
    research: { spec, validators: { kernel: p.validator } },
  }]; }));
  s.researchProgramme = { id: "acceptance-programme", maxFindingsPerTask: 8, maxContextBytes: 30000 };
  s.supervision = { reportEveryMs: 10, checkpointEveryMs: 100000, maxReplans: 1 };
}
const obligation = (id = "target", name = "lemma0") => ({ ...task(id), writeScope: [], readScope: [],
  goal: "Establish the exact frozen target", acceptance: ["independent exact deduction"], research: [name] });
function worker() {
  const seen = new Set<string>();
  return (async (_url: any, init: any) => {
    const body = JSON.parse(init.body), packet = JSON.parse(body.messages.find((m: any) => m.role === "user").content);
    const key = packet.task.id;
    if (packet.task.research?.length && !seen.has(key)) {
      seen.add(key); return reply("", [{ name: "run_job", arguments: { name: packet.task.research[0], input: {} } }]);
    }
    return reply("Ready for independent checking");
  }) as typeof fetch;
}
async function establish(s: any, cfg: any) {
  const tasks = [obligation("lemma0"), obligation("lemma1", "lemma1"),
    { ...obligation("theorem", "theorem"), dependencies: ["lemma0", "lemma1"] }];
  const rpc = async (_cmd: any, _cfg: any, request: any) => {
    const name = String(s.db.prepare("SELECT template FROM research_jobs WHERE key=?").get(request.key).template);
    const p = proofResult(cfg.spec.jobs[name].research.spec, { key: request.key, jobId: request.key });
    return { schema: 1, key: request.key, jobId: request.key, status: "SUCCEEDED",
      result: { exitCode: 0, data: p.result, artifacts: p.artifacts } };
  };
  const result = await runTasks(s, tasks, new SwarmDriver(s, cfg, worker(), undefined, rpc as any), { signal: signal() });
  assert.equal(result.status, "PASS");
  const programme = new ResearchProgramme(s, cfg.spec.researchProgramme);
  const lemma = (programme.list() as any).findings.find((f: any) => f.id === "lemma0");
  return { result, programme, ref: { id: lemma.id, version: lemma.version } };
}

// Exercise the actual API recovery planner, rather than injecting a host plan.
test("API recovery cannot drop a mandatory proof and attest completion", async () => fixture(async s => {
  const original = obligation(); let modelCalls = 0;
  const ctl = new AbortController(), timeout = setTimeout(() => ctl.abort(), 10000);
  try {
    const fetcher = (async (_url: any, init: any) => {
      modelCalls++; const body = JSON.parse(init.body);
      if (body.tools.some((t: any) => t.function?.name === "propose_recovery_plan")) {
        const packet = JSON.parse(body.messages.find((m: any) => m.role === "user").content);
        const { research, ...replacement } = original;
        return reply("", [{ name: "propose_recovery_plan", arguments: { decision: "replan", reason: "Try a summary",
          tasks: [{ ...replacement, goal: "Write a summary" }],
          addressedFindings: packet.hostReflection.findings.slice(0, 1).map((f: any) => f.code) } }]);
      }
      return reply("No proof produced");
    }) as typeof fetch;
    const result: any = await superviseSwarm(s, { id: "mandatory", goal: original.goal, tasks: [original] }, ctl.signal,
      () => { if (s.db.prepare("SELECT 1 FROM swarm_recovery_attempts WHERE state='FAILED'").get()) ctl.abort(); }, fetcher);
    assert.equal(result.status, "PAUSED"); assert.equal(modelCalls, 2);
    assert.match(String(s.db.prepare("SELECT detail FROM swarm_recovery_attempts").get()!.detail), /required experiment/);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM swarm_objective_completions").get()!.n, 0);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM swarm_objective_revisions").get()!.n, 1);
  } finally { clearTimeout(timeout); }
}, configure));

test("scientific recovery preserves exact inputs/imports/checks and permits helper DAGs", async () => fixture(async (s, cfg) => {
  const ref = { id: "lemma", version: "a".repeat(64) }, original = { ...obligation(), knowledge: [ref] };
  const frozen = scientificObligations([original], cfg.spec);
  const weaker = structuredClone(cfg.spec); weaker.agents.weak = { ...weaker.agents.coder, checks: [] };
  const cases: [Partial<Task>, RegExp][] = [
    [{ id: "renamed" }, /obligation task/], [{ research: [] }, /required experiment/],
    [{ knowledge: [] }, /exact knowledge/], [{ knowledge: [{ ...ref, version: "b".repeat(64) }] }, /exact knowledge/],
    [{ input: { easier: true } }, /input changed/], [{ acceptance: ["a prose summary"] }, /acceptance weakened/],
    [{ agent: "weak" }, /checks weakened/],
  ];
  for (const [change, reason] of cases)
    assert.throws(() => assertScientificObligations(frozen, [{ ...original, ...change }], weaker), reason);
  const helper = { ...task("helper"), writeScope: [], readScope: [] };
  assert.doesNotThrow(() => assertScientificObligations(frozen, [helper, { ...original, dependencies: [helper.id],
    goal: "Try a different proof method", acceptance: [...original.acceptance, "extra audit"] }], cfg.spec));
  installObjectives(s);
  const initialPlan = s.artifact([original]), currentPlan = s.artifact([helper]);
  s.db.prepare("INSERT INTO swarm_objective_revisions VALUES(?,?,?,?,?,?)").run("frozen", 0, initialPlan, "initial-run", "initial", Date.now());
  s.db.prepare("INSERT INTO swarm_objective_revisions VALUES(?,?,?,?,?,?)").run("frozen", 1, currentPlan, "later-run", "recovery", Date.now());
  const reopened = await Store.open(s.root);
  try { assert.deepEqual(objectiveScientificObligations(reopened, cfg, "frozen"), frozen); }
  finally { reopened.close(); }
}, configure));

test("a previously admitted unsafe recovery cannot bypass the original objective at integration", async () => fixture(async (s, cfg) => {
  const original = obligation(), initial = new Scheduler(s).start([original]);
  const replacement = { ...original, id: "summary", research: [] };
  const recovered = await runTasks(s, [replacement], new SwarmDriver(s, cfg, worker()), { signal: signal() });
  assert.equal(recovered.status, "PASS");
  installObjectives(s);
  const firstPlan = s.artifact([original]), nextPlan = s.artifact([replacement]);
  s.db.prepare("INSERT INTO swarm_objectives VALUES(?,?,?,?,?,'RUNNING',NULL,NULL,NULL,?)")
    .run("legacy", original.goal, nextPlan, digest(cfg), recovered.id, Date.now());
  const revision = s.db.prepare("INSERT INTO swarm_objective_revisions VALUES(?,?,?,?,?,?)");
  revision.run("legacy", 0, firstPlan, initial, "initial", Date.now());
  revision.run("legacy", 1, nextPlan, recovered.id, "old unsafe recovery", Date.now());
  const gate = objectiveEvidenceGate(s, recovered.id, "legacy");
  assert.equal(gate.status, "BLOCKED"); assert.match(gate.scientificBlocker!, /obligation task/);
  await assert.rejects(integrateSwarm(s, recovered.id, signal()), /obligation task/);
}, configure));

test("the API planner preserves scientific fields and a valid replan completes checked research", async () => fixture(async (s, cfg) => {
  const { programme } = await establish(s, cfg);
  const refs = (programme.list() as any).findings.filter((f: any) => f.id.startsWith("lemma"))
    .map(({ id, version }: any) => ({ id, version }));
  const original = { ...obligation("target", "theorem"), knowledge: refs };
  let first = true, planned = false; const work = worker();
  const fetcher = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (body.tools.some((t: any) => t.function?.name === "propose_recovery_plan")) {
      planned = true;
      const schema = body.tools[0].function.parameters.properties.tasks.items.properties;
      assert.ok(schema.research && schema.knowledge);
      const packet = JSON.parse(body.messages.find((m: any) => m.role === "user").content);
      assert.deepEqual(packet.scientificObligations[0].knowledge, refs);
      return reply("", [{ name: "propose_recovery_plan", arguments: { decision: "replan", reason: "Submit and independently check the certificate",
        tasks: [{ ...original, goal: "Construct a checked certificate using the exact imported lemmas" }],
        addressedFindings: packet.hostReflection.findings.slice(0, 1).map((f: any) => f.code) } }]);
    }
    if (first) { first = false; return reply("No certificate yet"); }
    return work(url, init);
  }) as typeof fetch;
  const result: any = await superviseSwarm(s, { id: "valid-recovery", goal: original.goal, tasks: [original] },
    AbortSignal.timeout(15000), undefined, fetcher);
  assert.ok(planned); assert.equal(result.status, "PASS"); assert.equal(result.objective.state, "COMPLETE");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_assessments WHERE run=?").get(result.objective.run)!.n, 1);
  assert.equal(result.objective.evidenceGate.scientificBlocker, null);
}, configure));

for (const cached of [false, true]) test(`revoked premise blocks ${cached ? "cached" : "fresh"} integration and the objective gate`, async () => fixture(async (s, cfg) => {
  const { result, programme, ref } = await establish(s, cfg);
  if (cached) await integrateSwarm(s, result.id, signal());
  programme.retract(ref, "Withdraw the exact premise after task acceptance");
  const reopened = await Store.open(s.root);
  try {
    assert.equal(objectiveEvidenceGate(reopened, result.id).status, "BLOCKED");
    await assert.rejects(integrateSwarm(reopened, result.id, signal()), /scientific|retracted|stale/);
    if (!cached) assert.equal(reopened.getMeta(`extension.swarm.integration.${result.id}`), undefined);
    assert.equal(reopened.db.prepare("SELECT status FROM tasks WHERE run=? AND id='theorem'").get(result.id)!.status, "PASS",
      "historical acceptance remains inspectable");
  } finally { reopened.close(); }
}, configure));

test("a retracted standalone deduction cannot satisfy final acceptance", async () => fixture(async (s, cfg) => {
  const { result, programme } = await establish(s, cfg);
  const theorem = (programme.list() as any).findings.find((f: any) => f.id === "theorem");
  programme.retract({ id: theorem.id, version: theorem.version }, "The final deduction is withdrawn");
  assert.equal(objectiveEvidenceGate(s, result.id).status, "BLOCKED");
  await assert.rejects(integrateSwarm(s, result.id, signal()), /scientific|retracted/);
}, configure));

test("revocation during integration checks is rechecked before publishing a branch", async () => fixture(async (s, cfg, project) => {
  const { result, programme, ref } = await establish(s, cfg);
  const checks = LocalGitHands.prototype.verificationChecks;
  LocalGitHands.prototype.verificationChecks = async function (...args) {
    const reports = await checks.apply(this, args);
    programme.retract(ref, "Withdraw the premise while integration checks finish");
    return reports;
  };
  try { await assert.rejects(integrateSwarm(s, result.id, signal()), /retracted|scientific/); }
  finally { LocalGitHands.prototype.verificationChecks = checks; }
  const refs = execFileSync("git", ["-C", project, "for-each-ref", "--format=%(refname)", `refs/heads/swarm/${result.id}`], { encoding: "utf8" });
  assert.equal(refs.trim(), "");
}, configure));

test("the completion transaction rejects a revocation after the last pre-commit gate", async () => fixture(async (s, cfg) => {
  const { programme, ref } = await establish(s, cfg);
  const original = { ...obligation("final", "theorem"), knowledge: (programme.list() as any).findings
    .filter((f: any) => f.id.startsWith("lemma")).map(({ id, version }: any) => ({ id, version })) };
  const artifact = s.artifact.bind(s), ctl = new AbortController(); let revoked = false;
  s.artifact = value => {
    const hash = artifact(value);
    if ((value as any)?.objective === "late-revoke" && (value as any)?.evidenceGate) {
      revoked = true; programme.retract(ref, "Withdraw between attestation construction and commit");
    }
    return hash;
  };
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const result: any = await superviseSwarm(s, { id: "late-revoke", goal: original.goal, tasks: [original] }, ctl.signal,
      r => { if (revoked && r.status === "NEEDS_ATTENTION") ctl.abort(); }, worker());
    assert.ok(revoked); assert.equal(result.status, "PAUSED");
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM swarm_objective_completions WHERE objective='late-revoke'").get()!.n, 0);
    assert.equal(result.objective.evidenceGate.status, "BLOCKED");
  } finally { clearTimeout(timer); s.artifact = artifact; }
}, s => { configure(s); s.supervision.maxReplans = 0; }));
