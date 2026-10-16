import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assessResearch, validateResearchSpec, type ResearchSpec } from "../../adapters/research/legacy.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { ResearchJobs } from "../../src/harness/foundry/swarm/jobs.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { executable, validateSwarmTasks } from "../../src/harness/foundry/swarm/config.ts";
import { fixture, task, signal, scripted, reply } from "./swarm-fixtures.ts";
import { bellExperiment, simulateQuantum } from "../../scripts/quantum-experiment.mjs";
const clone = <T>(x: T): T => structuredClone(x);
const spec = () => bellExperiment() as ResearchSpec;

test("actual CPU Bell simulation supports witness and separable control refutes it reproducibly", () => {
  for (const control of [false, true]) {
    const s = bellExperiment(control), r = simulateQuantum(s);
    assert.deepEqual(r, simulateQuantum(s));
    assert.equal(assessResearch(s, r).outcome, control ? "REFUTED" : "SUPPORTED");
  }
});

test("quantum gate rejects changed provenance, postselection, bit order, circuits and non-finite data", () => {
  const s = spec(), r = simulateQuantum(s);
  for (const mutate of [
    (v: any) => v.backend.mode = "hardware", (v: any) => v.bitOrder = "q0-left",
    (v: any) => v.seed++, (v: any) => v.specHash = "a".repeat(64),
    (v: any) => v.identity.environment = "b".repeat(64), (v: any) => v.circuits.pop(),
    (v: any) => v.circuits[0].circuitHash = "c".repeat(64),
    (v: any) => v.circuits[0].counts = { "00": 4095 },
    (v: any) => v.circuits[0].counts = { "00": NaN },
    (v: any) => v.circuits[0].counts = { "0 0": 4096 },
    (v: any) => v.circuits[1] = v.circuits[0],
  ]) { const bad = clone(r); mutate(bad); assert.throws(() => assessResearch(s, bad)); }
  const hardware: any = clone(s); hardware.backend.mode = "hardware"; hardware.seed = null;
  assert.throws(() => validateResearchSpec(hardware), /hash/);
  hardware.backend.calibrationHash = "d".repeat(64); validateResearchSpec(hardware);
  assert.throws(() => assessResearch(hardware, r), /provenance|mismatch/);
  const asymmetric: any = clone(s); asymmetric.circuits = [{ ...asymmetric.circuits[0], parityQubits: [0] }];
  const a = { ...r, specHash: digest(asymmetric), circuits: [{ ...r.circuits[0], counts: { "01": 4096 } }] };
  assert.equal(assessResearch(asymmetric, a).estimates[0].mean, -1);
});

test("paired metric computes predeclared replicated bounds; no best-seed or score-only acceptance", () => {
  const base: any = spec();
  for (const k of ["backend", "bitOrder", "shots", "seed", "circuits"]) delete base[k];
  const s: any = { ...base, kind: "paired-metric", metric: { name: "accuracy", minimum: 0, maximum: 1, direction: "higher" },
    seeds: Array.from({ length: 200 }, (_, i) => i), minimumEffect: 0.05 };
  const r = { schema: 1, specHash: digest(s), identity: s.identity,
    samples: s.seeds.map((seed: number) => ({ seed, baseline: 0.2, candidate: 0.8 })) };
  assert.equal(assessResearch(s, r).outcome, "SUPPORTED");
  assert.equal(assessResearch(s, { ...r, samples: r.samples.map((x: any) => ({ ...x, candidate: 0 })) }).outcome, "REFUTED");
  assert.equal(assessResearch(s, { ...r, samples: r.samples.map((x: any) => ({ ...x, candidate: 0.25 })) }).outcome, "INCONCLUSIVE");
  for (const samples of [r.samples.slice(1), [...r.samples.slice(1), r.samples[1]],
    r.samples.map((x: any) => ({ ...x, candidate: 2 }))]) assert.throws(() => assessResearch(s, { ...r, samples }));
});

test("formal obligations require independently bound kernel audit and permitted axioms", () => {
  const s: any = spec(); for (const k of ["backend", "bitOrder", "shots", "seed", "circuits", "alpha"]) delete s[k];
  Object.assign(s, { kind: "formal-proof", statementHash: digest("target theorem"), allowedAxioms: ["propext", "Classical.choice"] });
  const r = { schema: 1, specHash: digest(s), identity: s.identity, source: "candidate source for fixture checker" };
  const audit = { schema: 1, specHash: digest(s), candidateHash: digest(r.source), statementHash: s.statementHash,
    environmentHash: s.identity.environment, verified: true, axioms: ["propext"] };
  assert.throws(() => assessResearch(s, r));
  assert.equal(assessResearch(s, r, audit).outcome, "SUPPORTED");
  for (const change of [{ verified: false }, { statementHash: digest("True") }, { candidateHash: digest("other") },
    { axioms: ["sorryAx"] }, { axioms: ["untrusted_axiom"] }]) assert.throws(() => assessResearch(s, r, { ...audit, ...change }));
});

function configure(s: any, control = false) {
  const experiment = bellExperiment(control), folder = dirname(s.project), path = join(folder, "experiment.json");
  const template = join(folder, "job-template.json"); writeFileSync(path, JSON.stringify(experiment));
  const runner = resolve("scripts/quantum-experiment.mjs"), endpoint = resolve("scripts/research-job-agent.py");
  writeFileSync(template, JSON.stringify({ argv: [process.execPath, "--experimental-strip-types", runner, "--spec", path],
    timeoutMs: 5000, resultMaxBytes: 16384, maxLogBytes: 16384 }));
  s.jobs = { bell: { adapter: { argv: [executable("python3"), endpoint, "--root", join(folder, "jobs"), "--config", template],
    files: [endpoint, template, runner, path, resolve("src/harness/foundry/research.ts"), resolve("src/harness/foundry/kernel.ts")] },
    research: { spec: experiment }, idempotentEnsure: true, pollMs: 100, staleMs: 10000, maxJobs: 4, maxConcurrent: 2 } };
  s.agents.coder.tools.push("run_job"); s.agents.coder.jobs = ["bell"];
}

test("Swarm executes quantum job once across call IDs and independently accepts a negative scientific result", async () => fixture(async (s, cfg) => {
  const protocol = cfg.spec.jobs!.bell.research!.spec;
  const mock = scripted([
    () => reply("", [{ name: "run_job", arguments: { name: "bell", input: protocol.input } }]),
    () => reply("", [{ id: "different-call", name: "run_job", arguments: { name: "bell", input: protocol.input } }]),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("experiment completed; host must assess the hypothesis"),
  ]);
  const result: any = await runSwarm(s, [{ ...task(), research: ["bell"] }], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS", JSON.stringify(s.db.prepare("SELECT error FROM tasks").all()));
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM research_jobs").get()!.n, 1);
  const row = s.db.prepare("SELECT * FROM research_assessments").get()!;
  assert.equal(row.outcome, "REFUTED"); assert.equal((s.readArtifact(String(row.assessment_hash)) as any).outcome, "REFUTED");
}, s => configure(s, true)));

test("required scientific jobs cannot be omitted or have their frozen input changed", async () => fixture(async (s, cfg) => {
  validateSwarmTasks(cfg.spec, [{ ...task(), research: ["bell"] }]);
  assert.throws(() => validateSwarmTasks(cfg.spec, [{ ...task(), research: ["unknown"] }]));
  const q = new Scheduler(s), run = q.start([{ ...task(), research: ["bell"] }]), c = q.capsule(q.claim(run, "x")!);
  const jobs = new ResearchJobs(new SessionJournal(s), cfg, async () => { throw new Error("must not call provider"); });
  await assert.rejects(jobs.execute(c, cfg.spec.agents.coder, { id: "x", name: "run_job", arguments: { name: "bell", input: {} } }, signal()), /frozen/);
  const { verifyResearch } = await import("../../src/harness/foundry/swarm/research.ts");
  assert.equal((await verifyResearch(s, cfg, c, signal())).verdict, "FAIL");
}, configure));
