import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, digest } from "../../src/harness/foundry/kernel.ts";
import * as evolution from "../../src/harness/foundry/evolution.ts";
import { evaluate, loadEvaluation, promote, rollback, suggest } from "../../src/harness/foundry/evolution.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { spawnTasks } from "../../src/harness/foundry/dynamicDag.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import type { Driver, Protocol } from "../../src/harness/foundry/types.ts";
import { contract, recipe, task } from "./fixtures.ts";

async function fixture(fn: (s: Store, d: Driver, baseline: string) => Promise<void>): Promise<void> {
  const path = mkdtempSync(join(tmpdir(), "foundry-evaluation-")); const s = await Store.open(path);
  const baseline = s.initialize(contract, { ...recipe, parallelism: 1 });
  // Synthetic host-side meter for admission tests, not a real savings claim.
  const d: Driver = { verifierId: contract.verifierId, workerId: contract.workerId,
    async execute(c) { return { artifact: { answer: 4 }, measurement: { tokens: c.recipeHash === baseline ? 20 : 10, costUsd: c.recipeHash === baseline ? 2 : 1 } }; },
    async verify(_c, r) { return { artifactHash: digest(r.artifact), checks: [{ id: "behavior", verdict: "PASS" }], measurement: { tokens: 0, costUsd: 0 } }; } };
  try { await fn(s, d, baseline); } finally { s.close(); rmSync(path, { recursive: true, force: true }); }
}
const protocol = (): Protocol => ({ datasetId: "fixture-holdout-v1", environmentId: contract.environmentId, tasks: [task()], repetitions: 2, objective: "costUsd", minRelativeGain: 0.2 });
test("matched evaluation is counterbalanced; promotion and rollback are explicit", async () => fixture(async (s, d, baseline) => {
  const candidate = s.propose({ parallelism: 2 }); const e = await evaluate(s, candidate, protocol(), d);
  assert.equal(e.decision, "ADMIT"); assert.equal(e.relativeGain, 0.5); assert.equal(s.active(), baseline);
  assert.deepEqual(s.db.prepare("SELECT recipe FROM runs ORDER BY rowid").all().map(r => r.recipe), [baseline, candidate, candidate, baseline]);
  assert.equal(promote(s, e.id), candidate); assert.equal(promote(s, e.id), candidate);
  rollback(s, baseline); assert.equal(s.active(), baseline);
  assert.throws(() => promote(s, e.id), /consumed/);
}));
test("insufficient gain rejects an otherwise healthy candidate", async () => fixture(async (s, d) => {
  d.execute = async () => ({ artifact: { answer: 4 }, measurement: { tokens: 20, costUsd: 2 } });
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  assert.equal(e.decision, "REJECT"); assert.throws(() => promote(s, e.id));
}));
test("zero observed baseline cost is not a fabricated improvement", async () => fixture(async (s, d) => {
  d.execute = async () => ({ artifact: {}, measurement: { tokens: 0, costUsd: 0 } });
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  assert.equal(e.decision, "UNKNOWN"); assert.throws(() => promote(s, e.id));
}));
test("missing token/cost evidence prevents cost-based promotion", async () => fixture(async (s, d) => {
  d.execute = async () => ({ artifact: {} });
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  assert.equal(e.decision, "UNKNOWN"); assert.throws(() => promote(s, e.id));
}));
test("a candidate with worse quality is rejected despite cheaper reported work", async () => fixture(async (s, d, baseline) => {
  d.verify = async (c, r) => ({ artifactHash: digest(r.artifact), checks: [{ id: "behavior", verdict: c.recipeHash === baseline ? "PASS" : "FAIL" }], measurement: { tokens: 0, costUsd: 0 } });
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  assert.equal(e.decision, "REJECT"); assert.throws(() => promote(s, e.id));
}));
test("stale parent cannot replace a subsequently promoted recipe", async () => fixture(async (s, d) => {
  const a = s.propose({ parallelism: 2 }); const b = s.propose({ parallelism: 3 });
  const ea = await evaluate(s, a, protocol(), d); const eb = await evaluate(s, b, protocol(), d);
  promote(s, ea.id); assert.throws(() => promote(s, eb.id), /stale/);
}));
test("changing a persisted evaluation or underlying run invalidates its receipt", async () => fixture(async (s, d) => {
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  s.db.prepare("UPDATE evaluations SET json=? WHERE id=?").run(JSON.stringify({ ...e, relativeGain: 0.99 }), e.id);
  assert.throws(() => promote(s, e.id), /integrity/);
  s.db.prepare("UPDATE evaluations SET json=?,hash=? WHERE id=?").run(canonical(e), digest(e), e.id);
  s.db.prepare("UPDATE attempts SET cost=0 WHERE run=?").run(e.pairs[0].candidate.id);
  assert.throws(() => promote(s, e.id), /evidence changed/);
}));
test("changing the protocol hash or task set cannot produce an admitted receipt", async () => fixture(async (s, d) => {
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  const altered = { ...e, protocol: { ...e.protocol, minRelativeGain: 0.0001 } };
  s.db.prepare("UPDATE evaluations SET json=?,hash=? WHERE id=?").run(canonical(altered), digest(altered), e.id);
  assert.throws(() => promote(s, e.id), /drift/);
  s.db.prepare("UPDATE evaluations SET json=?,hash=? WHERE id=?").run(canonical(e), digest(e), e.id);
  s.db.prepare("UPDATE tasks SET spec=? WHERE run=? AND id='a'").run(canonical({ ...task(), goal: "different problem" }), e.pairs[0].candidate.id);
  assert.throws(() => promote(s, e.id), /task set/);
}));
test("missing accepted artifacts invalidate promotion", async () => fixture(async (s, d) => {
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  const row = s.db.prepare("SELECT artifact FROM tasks WHERE run=?").get(e.pairs[0].candidate.id)!;
  unlinkSync(join(s.root, "artifacts", `${row.artifact}.json`));
  assert.throws(() => promote(s, e.id));
}));
test("bad environment and partial evaluations never promote", async () => fixture(async (s, d) => {
  const candidate = s.propose({ parallelism: 2 });
  await assert.rejects(evaluate(s, candidate, { ...protocol(), environmentId: "other" }, d), /environment/);
  const abort = new AbortController(); abort.abort();
  const e = await evaluate(s, candidate, protocol(), d, abort.signal);
  assert.equal(e.decision, "UNKNOWN"); assert.throws(() => promote(s, e.id));
}));
test("rollback refuses an unadmitted candidate", async () => fixture(async s => {
  const hash = s.propose({ parallelism: 2 }); assert.throws(() => rollback(s, hash), /unadmitted/);
}));
test("suggest proposes from recorded independent work without auto-applying", async () => fixture(async (s, d, baseline) => {
  assert.equal(suggest(s), null);
  for (let i = 0; i < 3; i++) await runTasks(s, [task(), task("b")], d);
  const candidate = suggest(s); assert.ok(candidate); assert.equal(s.recipe(candidate).parallelism, 2); assert.equal(s.active(), baseline);
}));

test("missing verification evidence prevents promotion even when code artifacts exist", async () => fixture(async (s, d) => {
  const e = await evaluate(s, s.propose({parallelism:2}), protocol(), d);
  const row = s.db.prepare("SELECT evidence FROM tasks WHERE run=?").get(e.pairs[0].candidate.id)!;
  unlinkSync(join(s.root,"artifacts",`${row.evidence}.json`));
  assert.throws(() => promote(s,e.id));
}));

test("an interrupted evaluation resumes its original arm after reopening the store", async () => fixture(async (s, d) => {
  const abort = new AbortController(); const execute = d.execute;
  d.measurement = () => ({ tokens: 0, costUsd: 0 });
  d.execute = async (...args) => { abort.abort(); return execute(...args); };
  const candidate = s.propose({ parallelism: 2 });
  const paused = await evaluate(s, candidate, protocol(), d, abort.signal);
  assert.equal(paused.decision, "UNKNOWN");
  assert.equal(paused.pairs.length, 0);
  const firstRun = s.db.prepare("SELECT id FROM runs").get()!.id;
  assert.ok(paused.armRunIds?.some(p => p.baseline === firstRun));
  d.execute = execute;
  const reopened = await Store.open(s.root);
  try {
    const resumed = await evolution.resumeEvaluation(reopened, paused.id, d);
    assert.equal(resumed.id, paused.id); assert.equal(resumed.decision, "ADMIT");
    assert.equal(resumed.pairs[0].baseline.id, firstRun);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 4);
    assert.equal(resumed.pairs[0].baseline.attempts, 2, "paused attempt remains in cost accounting");
    const count = reopened.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n;
    assert.deepEqual(await evolution.resumeEvaluation(reopened, paused.id, d), resumed);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, count);
  } finally { reopened.close(); }
}));

test("a completed first arm survives interruption without a second execution", async () => fixture(async (s, d) => {
  const abort = new AbortController(); const candidate = s.propose({ parallelism: 2 });
  const original = d.execute; const baselineRuns = new Set<string>();
  d.execute = async (c, ...args) => {
    if (c.recipeHash === candidate) abort.abort(); else baselineRuns.add(c.runId);
    return original(c, ...args);
  };
  const paused = await evaluate(s, candidate, protocol(), d, abort.signal);
  const baselineRun = [...baselineRuns][0];
  assert.equal(new Scheduler(s).summary(baselineRun).status, "PASS");
  d.execute = original;
  const resumed = await evolution.resumeEvaluation(s, paused.id, d);
  assert.equal(resumed.pairs[0].baseline.id, baselineRun);
  assert.equal(resumed.pairs[0].baseline.attempts, 1);
}));

test("matched evaluation accepts verified dynamic children and still authenticates child evidence", async () => fixture(async (s, d, baseline) => {
  d.execute = async c => {
    if (c.task.id === "a") {
      const child = { ...task("a.leaf", [], ["src/a/leaf"]), readScope: ["src/a/leaf"] };
      const children = c.recipeHash === baseline ? [child] : [child,
        { ...child, id: "a.other", writeScope: ["src/a/other"], readScope: ["src/a/other"] }];
      const spawned = spawnTasks(s, c, "leaf", digest(children), children,
        { maxChildrenPerTask: 2, maxDepth: 2, maxSpawnedTasks: 10 });
      if (!spawned.complete) throw new DeferredAttemptError("spawn", Date.now(), "waiting for child");
    }
    return { artifact: { task: c.task.id }, measurement: { tokens: 10, costUsd: c.recipeHash === baseline ? 2 : 1 } };
  };
  d.measurement = () => ({ tokens: 0, costUsd: 0 });
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  assert.equal(e.decision, "ADMIT"); assert.equal(e.relativeGain, 0.25);
  assert.ok(e.pairs.every(p => p.baseline.accepted === 2 && p.candidate.accepted === 3));
  const row = s.db.prepare("SELECT evidence FROM tasks WHERE run=? AND id='a.leaf'").get(e.pairs[0].candidate.id)!;
  const evidence = s.readArtifact(row.evidence);
  unlinkSync(join(s.root, "artifacts", `${row.evidence}.json`));
  assert.throws(() => promote(s, e.id));
  s.artifact(evidence);
  const original = structuredClone(e);
  s.db.prepare("UPDATE tasks SET status='READY' WHERE run=? AND id='a.leaf'").run(e.pairs[0].candidate.id);
  e.pairs[0].candidate = new Scheduler(s).summary(e.pairs[0].candidate.id);
  s.db.prepare("UPDATE evaluations SET json=?,hash=? WHERE id=?").run(canonical(e), digest(e), e.id);
  assert.throws(() => promote(s, e.id), /unfinished tasks/);
  s.db.prepare("UPDATE tasks SET status='PASS' WHERE run=? AND id='a.leaf'").run(e.pairs[0].candidate.id);
  s.db.prepare("UPDATE evaluations SET json=?,hash=? WHERE id=?").run(canonical(original), digest(original), e.id);
  assert.equal(promote(s, e.id), e.candidateHash);
}));

test("protocol-scoped suggestion learns from a rejected candidate and tries another execution knob", async () => fixture(async (s, d) => {
  const tasks = [task(), { ...task("b"), priority: 5 }];
  for (let i = 0; i < 3; i++) await runTasks(s, tasks, d);
  const p = { ...protocol(), tasks };
  const rejected = suggest(s, p)!;
  d.execute = async () => ({ artifact: {}, measurement: { tokens: 20, costUsd: 2 } });
  const e = await evaluate(s, rejected, p, d);
  assert.equal(e.decision, "REJECT");
  const alternative = suggest(s, p);
  assert.ok(alternative); assert.notEqual(alternative, rejected);
  assert.equal(s.recipe(alternative).priorityContextShare, 0.7);
  assert.equal(suggest(s, { ...p, datasetId: "a-new-frozen-protocol" }), rejected);
}));

test("bounded automatic evolution exhausts rejected alternatives without repeating trials", async () => fixture(async (s, d, baseline) => {
  const tasks = [task(), { ...task("b"), priority: 5 }];
  for (let i = 0; i < 3; i++) await runTasks(s, tasks, d);
  d.execute = async () => ({ artifact: {}, measurement: { tokens: 20, costUsd: 2 } });
  const p = { ...protocol(), tasks };
  const result = await evolution.evolve(s, p, d, { maxCycles: 5, autoPromote: true });
  assert.equal(result.evaluations.length, 2);
  assert.ok(result.evaluations.every(e => e.decision === "REJECT"));
  assert.equal(result.active, baseline);
  const runCount = s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n;
  const again = await evolution.evolve(s, p, d, { maxCycles: 5, autoPromote: true });
  assert.equal(again.evaluations.length, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, runCount);
  await assert.rejects(evolution.evolve(s, p, d, { maxCycles: 0 }), /cycle/);
}));

test("stable run replay uses the same binary task ordering for mixed-case identifiers", async () => fixture(async s => {
  const q = new Scheduler(s); const tasks = [task("a"), task("B")];
  const run = q.start(tasks);
  assert.equal(q.start(tasks, s.active(), Date.now(), run), run);
}));

test("process death between arms preserves the completed arm and unknown interrupted cost", async () => fixture(async (s, d) => {
  const candidate = s.propose({ parallelism: 2 });
  const source = new URL("../../src/harness/foundry/", import.meta.url);
  const script = join(s.root, "crash.mjs");
  writeFileSync(script, `
    import { Store } from ${JSON.stringify(new URL("store.ts", source).href)};
    import { evaluate } from ${JSON.stringify(new URL("evolution.ts", source).href)};
    import { digest } from ${JSON.stringify(new URL("kernel.ts", source).href)};
    const s = await Store.open(${JSON.stringify(s.root)});
    await evaluate(s, ${JSON.stringify(candidate)}, ${JSON.stringify(protocol())}, {
      workerId: ${JSON.stringify(d.workerId)}, verifierId: ${JSON.stringify(d.verifierId)},
      async execute(c) {
        if(c.recipeHash === ${JSON.stringify(candidate)}) process.exit(71);
        return {artifact:{answer:4},measurement:{tokens:20,costUsd:2}};
      },
      async verify(c,r) {return {artifactHash:digest(r.artifact),checks:[{id:'behavior',verdict:'PASS'}],measurement:{tokens:0,costUsd:0}};}
    });
  `);
  const crashed = spawnSync(process.execPath, ["--experimental-strip-types", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(crashed.status, 71, crashed.stderr);
  const id = s.db.prepare("SELECT id FROM evaluations").get()!.id;
  const pending = loadEvaluation(s, id);
  const first = pending.armRunIds![0]!.baseline;
  assert.equal(new Scheduler(s).summary(first).status, "PASS");
  const resumed = await evolution.resumeEvaluation(s, id, d);
  assert.equal(resumed.pairs[0].baseline.id, first);
  assert.equal(resumed.pairs[0].baseline.attempts, 1);
  assert.equal(resumed.pairs[0].candidate.costUsd, null);
  assert.equal(resumed.decision, "UNKNOWN", "a killed unmetered attempt must not become a savings claim");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 4);
}));

test("concurrent evaluation resumes share fenced arms and cannot overwrite a newer receipt", async () => fixture(async (s, d) => {
  const abort = new AbortController(); abort.abort();
  const paused = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d, abort.signal);
  const original = d.execute;
  d.execute = async (...args) => { await new Promise(resolve => setTimeout(resolve, 15)); return original(...args); };
  const other = await Store.open(s.root);
  try {
    const outcomes = await Promise.allSettled([
      evolution.resumeEvaluation(s, paused.id, d), evolution.resumeEvaluation(other, paused.id, d),
    ]);
    assert.ok(outcomes.some(o => o.status === "fulfilled"));
    for (const o of outcomes) if (o.status === "rejected") assert.match(String(o.reason), /changed concurrently/);
    const e = loadEvaluation(s, paused.id);
    assert.equal(e.decision, "ADMIT"); assert.equal(e.pairs.length, 2);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 4);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, 4);
  } finally { other.close(); }
}));

test("resume rejects protocol drift and completed evidence loss before doing more work", async () => fixture(async (s, d) => {
  const abort = new AbortController(); const original = d.execute;
  const candidate = s.propose({ parallelism: 2 });
  d.execute = async (c, ...args) => {
    if (c.recipeHash === candidate) abort.abort();
    return original(c, ...args);
  };
  const e = await evaluate(s, candidate, protocol(), d, abort.signal);
  d.execute = original;
  const count = s.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n;
  const altered = { ...e, protocolHash: "changed" };
  s.db.prepare("UPDATE evaluations SET json=?,hash=? WHERE id=?").run(canonical(altered), digest(altered), e.id);
  await assert.rejects(evolution.resumeEvaluation(s, e.id, d), /drift/);
  s.db.prepare("UPDATE evaluations SET json=?,hash=? WHERE id=?").run(canonical(e), digest(e), e.id);
  const row = s.db.prepare("SELECT evidence FROM tasks WHERE run=?").get(e.armRunIds![0]!.baseline)!;
  unlinkSync(join(s.root, "artifacts", `${row.evidence}.json`));
  await assert.rejects(evolution.resumeEvaluation(s, e.id, d));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, count);
}));

test("automatic evolution resumes pending work and reuses a ready admission before promotion", async () => fixture(async (s, d, baseline) => {
  const tasks = [task(), task("b")];
  for (let i = 0; i < 3; i++) await runTasks(s, tasks, d);
  const p = { ...protocol(), tasks }; const abort = new AbortController(); abort.abort();
  const paused = await evaluate(s, suggest(s, p)!, p, d, abort.signal);
  const ready = await evolution.evolve(s, p, d);
  assert.equal(ready.stopReason, "awaiting-promotion");
  assert.equal(ready.evaluations[0].id, paused.id);
  assert.equal(s.active(), baseline);
  const count = s.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n;
  const applied = await evolution.evolve(s, p, d, { autoPromote: true });
  assert.equal(applied.active, ready.evaluations[0].candidateHash);
  assert.equal(applied.evaluations[0].id, paused.id);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, count);
}));

test("an injected unfinished child cannot hide behind an unchanged successful run summary", async () => fixture(async (s, d, baseline) => {
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  const run = e.pairs[0].candidate;
  const child = task("a.injected", [], ["src/a/injected"]);
  s.db.prepare("INSERT INTO tasks(run,id,spec,status) VALUES(?,?,?,'READY')").run(run.id, child.id, canonical(child));
  s.db.prepare("INSERT INTO spawn_edges(run,parent,child,request_key,depth,created) VALUES(?,?,?,?,?,?)")
    .run(run.id, "a", child.id, "injected", 1, Date.now());
  assert.equal(digest(new Scheduler(s).summary(run.id)), digest(run), "summary alone cannot authenticate task completeness");
  assert.throws(() => promote(s, e.id), /unfinished tasks/);
  assert.equal(s.active(), baseline);
}));

test("a retained legacy incomplete receipt cannot block new automatic evolution", async () => fixture(async (s, d) => {
  const tasks = [task(), task("b")];
  for (let i = 0; i < 3; i++) await runTasks(s, tasks, d);
  const p = { ...protocol(), tasks }; const abort = new AbortController(); abort.abort();
  const legacy = await evaluate(s, suggest(s, p)!, p, d, abort.signal);
  delete legacy.armRunIds;
  s.db.prepare("UPDATE evaluations SET json=?,hash=? WHERE id=?").run(canonical(legacy), digest(legacy), legacy.id);
  await assert.rejects(evolution.resumeEvaluation(s, legacy.id, d), /legacy incomplete/);
  const result = await evolution.evolve(s, p, d, { autoPromote: true });
  assert.deepEqual(result.skippedEvaluations, [{ id: legacy.id, reason: "legacy-missing-arm-bindings" }]);
  assert.equal(result.evaluations.length, 1);
  assert.notEqual(result.evaluations[0].id, legacy.id);
  assert.equal(result.evaluations[0].decision, "ADMIT");
  assert.equal(loadEvaluation(s, legacy.id).decision, "UNKNOWN", "historical evidence must remain intact");
}));

test("overflow of complete measured costs remains UNKNOWN rather than a numeric savings claim", async () => fixture(async (s, d) => {
  d.execute = async () => ({ artifact: {}, measurement: { tokens: 1, costUsd: Number.MAX_VALUE } });
  const e = await evaluate(s, s.propose({ parallelism: 2 }), protocol(), d);
  assert.equal(e.pairs.length, 2);
  assert.ok(e.pairs.every(p => p.baseline.costUsd === Number.MAX_VALUE && p.candidate.costUsd === Number.MAX_VALUE));
  assert.equal(e.relativeGain, null); assert.equal(e.decision, "UNKNOWN");
  assert.throws(() => promote(s, e.id));
}));
