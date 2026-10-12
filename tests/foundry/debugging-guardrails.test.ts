import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { formatHealth, runHealth } from "../../src/harness/foundry/health.ts";
import { reflectRun } from "../../src/harness/foundry/rndReflection.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { recordDiagnostic, pruningCandidate, diagnosticContext } from "../../src/harness/foundry/swarm/diagnostics.ts";
import { admitDebuggingCall, inversionCandidate, triageCard, systemStateLedger } from "../../src/harness/foundry/swarm/debugging.ts";
import { executable, validateSwarmSpec, type SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { integrateSwarm, runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { fixture, reply, scripted, signal, spec, task } from "./swarm-fixtures.ts";

function enable(s: SwarmSpec): void {
  s.debugging = { maxFailedCycles: 4, maxInversionResets: 1,
    requireProbeBeforeMultiFile: true, branchTimeoutMs: 300000 };
  s.checks.premise = { argv: [process.execPath, "-e",
    "const a=require('node:assert/strict');a.equal(Number('42'),42);a.ok(Number.isNaN(Number('unparseable')));console.log('positive and negative controls passed')"],
    replaySafe: true, probeTimeoutMs: 1000 };
  s.agents.coder.probes = ["premise"]; s.agents.coder.tools.push("run_probe");
}
const write = (value: string, path = "src/a.txt") => ({ name: "write_file", arguments: { path, content: value + "\n" } });
const check = { name: "run_check", arguments: { name: "behavior" } };
const probe = { name: "run_probe", arguments: { name: "premise", hypothesis: "The runtime supports decimal conversion",
  falsifyWhen: "42 fails to parse as 42", negativeControl: "An unparseable string must not produce a valid number" } };
const loops = () => Array.from({ length: 4 }, (_, i) => () => reply("discard-theory-" + i, [write(String(i + 1)), check]));
function state(s: Store, run: string): any {
  return s.readArtifact(s.db.prepare("SELECT state FROM agent_threads WHERE run=? AND task='a'").get(run)!.state);
}

test("debugging policy and probe authority are bounded operator declarations", () => {
  const s = spec("/tmp/repo"); enable(s); validateSwarmSpec(s);
  for (const maxFailedCycles of [0, 2, 9, 3.5]) assert.throws(() => validateSwarmSpec({ ...s,
    debugging: { ...s.debugging!, maxFailedCycles } }), /failure window/);
  for (const maxInversionResets of [-1, 4, 1.5]) assert.throws(() => validateSwarmSpec({ ...s,
    debugging: { ...s.debugging!, maxInversionResets } }), /reset limit/);
  for (const branchTimeoutMs of [0, 300001, 1.5]) assert.throws(() => validateSwarmSpec({ ...s,
    debugging: { ...s.debugging!, branchTimeoutMs } }), /branch timeout/);
  for (const probeTimeoutMs of [0, 2001, 1.5]) assert.throws(() => validateSwarmSpec({ ...s,
    checks: { ...s.checks, premise: { ...s.checks.premise!, probeTimeoutMs } } }), /probe deadline/);
  assert.throws(() => validateSwarmSpec({ ...s, checks: { ...s.checks,
    premise: { ...s.checks.premise!, replaySafe: false } } }), /probe deadline/);
  assert.throws(() => validateSwarmSpec({ ...s, debugging: { ...s.debugging!, auditorAgent: "unknown" } }), /auditor/);
  assert.throws(() => validateSwarmSpec({ ...s, agents: { coder: { ...s.agents.coder,
    tools: s.agents.coder.tools.filter(t => t !== "run_probe") } } }), /probe-capable/);
});

test("oscillation across real patch changes is detected without inventing multiple cycles in one turn", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  const journal = new SessionJournal(s);
  const t = journal.open(c, { history: [{ role: "user", content: "pinned" }], turns: 0,
    toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 32768 });
  for (let i = 0; i < 4; i++) {
    t.state.turns++;
    t.state.patchHash = s.artifact("candidate-" + i);
    const r = { code: 1, stdout: "", stderr: i % 2 ? "Error B" : "Error A" };
    const receipt = journal.receipt(c, r);
    recordDiagnostic(t, journal, cfg, { id: "c" + i, ...check }, r, receipt, t.state.patchHash, true);
    recordDiagnostic(t, journal, cfg, { id: "duplicate", ...check }, r, receipt, t.state.patchHash, true);
  }
  const window = inversionCandidate(t.state, cfg)!;
  assert.equal(window.length, 4); assert.equal(triageCard(window).pattern, "oscillation");
  assert.equal(pruningCandidate(t.state, cfg), null, "existing identical-input pruning cannot catch this cycle");
  assert.equal((systemStateLedger(t.state) as any).observations[0].currentPatch, false);
  const unrelated = { code: 0, stdout: "", stderr: "" };
  recordDiagnostic(t, journal, cfg, { id: "other", name: "run_check", arguments: { name: "other" } },
    unrelated, journal.receipt(c, unrelated), t.state.patchHash, true);
  assert.ok(inversionCandidate(t.state, cfg));
  recordDiagnostic(t, journal, cfg, { id: "success", ...check }, unrelated,
    journal.receipt(c, unrelated), t.state.patchHash, true);
  assert.equal(inversionCandidate(t.state, cfg), null);
}, enable));

test("healthy single-file work adds zero provider requests with debugging enabled", async () => {
  const counts: number[] = [];
  for (const enabled of [false, true]) await fixture(async s => {
    const mock = scripted([() => reply("", [write("42")]), () => reply("done")]);
    const r: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
    assert.equal(r.status, "PASS"); counts.push(mock.bodies.length);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='debugging.inversion'").get()!.n, 0);
  }, s => { if (enabled) enable(s); });
  assert.deepEqual(counts, [2, 2]);
});

test("only completed probes open expansion; new failures and external evidence revoke support", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  const journal = new SessionJournal(s);
  const t = journal.open(c, { history: [{ role: "user", content: "pinned" }], turns: 1,
    toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 32768 });
  const first = { id: "first", ...write("1") }, second = { id: "second", ...write("1", "src/b.txt") };
  admitDebuggingCall(t.state, cfg, first);
  t.state.progress = { summary: "The dependency certainly supports it", nextAction: "edit both files", receipts: [], patchHash: null, atTurn: 1 };
  assert.throws(() => admitDebuggingCall(t.state, cfg, second), /FALSIFICATION_REQUIRED/);
  const ok = { code: 0, stdout: "controls passed", stderr: "" }, r = journal.receipt(c, ok);
  const runProbe = () => recordDiagnostic(t, journal, cfg, { id: "p", ...probe }, ok, r, t.state.patchHash, true);
  runProbe(); admitDebuggingCall(t.state, cfg, second);
  const ledger: any = systemStateLedger(t.state);
  assert.equal(ledger.probe.hypothesis.trust, "UNVERIFIED_AGENT_HYPOTHESIS");
  assert.equal(ledger.probe.code, 0);
  for (const field of ["lastJobReceipt", "lastSpawnReceipt", "feedbackHash"] as const) {
    t.state[field] = s.artifact(field);
    assert.throws(() => admitDebuggingCall(t.state, cfg, second), /FALSIFICATION_REQUIRED/);
    runProbe(); admitDebuggingCall(t.state, cfg, second);
  }
  const failure = { code: 1, stdout: "", stderr: "new failing check" };
  recordDiagnostic(t, journal, cfg, { id: "f", ...check }, failure,
    journal.receipt(c, failure), t.state.patchHash, true);
  assert.throws(() => admitDebuggingCall(t.state, cfg, second), /FALSIFICATION_REQUIRED/);
  assert.equal(t.state.debugging!.probe, undefined);
}, enable));

test("multi-file expansion is gated before batch effects and a probe never replaces final integration", async () => fixture(async s => {
  const mock = scripted([
    () => reply("", [write("42"), write("42", "src/b.txt")]),
    body => {
      assert.match(JSON.stringify(body), /FALSIFICATION_REQUIRED/);
      return reply("", [probe, write("42", "src/b.txt")]);
    },
    () => reply("done"),
  ]);
  const r: any = await runSwarm(s, [{ ...task(), writeScope: ["src"] }], signal(), undefined, mock.fetcher);
  assert.equal(r.status, "PASS"); assert.equal(mock.bodies.length, 3);
  const d = state(s, r.id).debugging;
  assert.equal(d.probe.observation.code, 0); assert.ok(d.probe.observation.receipt);
  assert.equal((s.readArtifact(d.probe.observation.receipt) as any).code, 0);
  const integrated = await integrateSwarm(s, r.id, signal());
  assert.ok(integrated.checksHash);
  const events: any[] = new SessionJournal(s).page(r.id, "a", 0, 100);
  const blockedBatch = events.filter(e => e.kind === "tool.batch.result").map(e => s.readArtifact(e.payloadHash) as any)
    .find(e => e.results.length === 2);
  assert.ok(blockedBatch);
  assert.match((s.readArtifact(blockedBatch.results[1].receipt) as any).error, /FALSIFICATION_REQUIRED/);
}, enable));

test("fresh auditor gets raw symptom only, retires speculation, and requires a probe before recovery edits", async () => fixture(async s => {
  const mock = scripted([
    ...loops(),
    body => {
      assert.equal(body.tools.length, 0); assert.match(body.messages[0].content, /read-only/);
      const text = JSON.stringify(body);
      assert.ok(!text.includes("discard-theory")); assert.ok(!text.includes("old-speculation"));
      const packet = JSON.parse(body.messages[1].content);
      assert.equal(packet.rawInitialSymptom.check, "behavior"); assert.equal(packet.rawInitialSymptom.code, 1);
      assert.ok(!text.includes("diff --git"));
      return reply("1. Environment: inspect the runtime; refute with a capability probe. 2. Contract: isolate the boundary; use a negative control. 3. Dependency: check the supported operation independently.");
    },
    body => {
      const text = JSON.stringify(body);
      assert.match(text, /inversionReset/); assert.match(text, /UNVERIFIED_AGENT_HYPOTHESES/);
      assert.ok(!text.includes("discard-theory")); assert.ok(!text.includes("old-speculation"));
      return reply("", [write("42")]);
    },
    body => {
      assert.match(JSON.stringify(body), /FALSIFICATION_REQUIRED/);
      return reply("", [probe, write("42")]);
    },
    () => reply("done"),
  ]);
  const r: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(r.status, "PASS"); assert.equal(mock.bodies.length, 8);
  const t = state(s, r.id);
  assert.equal(t.debugging.resets, 1); assert.equal(t.debugging.probeRequired, false);
  assert.ok(diagnosticContext(t)!.systemStateLedger);
  const reflection: any = reflectRun(s, "o", r.id).reflection;
  assert.ok(reflection.findings.some((f: any) => f.code === "nonconvergent_debugging"));
}, enable));

test("a failed or timed-out probe suppresses remaining effects and exposes a triage card", async () => {
  for (const timeout of [false, true]) await fixture(async s => {
    const mock = scripted([() => reply("", [probe, write("42"), check])]);
    const r: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
    assert.equal(r.status, "FAIL"); assert.equal(mock.bodies.length, 1);
    const t = state(s, r.id);
    assert.match(t.debugging.prunedReason, timeout ? /PROBE_INCONCLUSIVE/ : /PREMISE_PROBE_FAILED/);
    assert.equal(s.readArtifact(t.patchHash), "");
    const health = runHealth(s, r.id);
    assert.equal(health.triage?.[0]?.card.check, "premise"); assert.match(formatHealth(health), /TRIAGE/);
    assert.equal(t.debugging.probe, undefined);
    const events: any[] = new SessionJournal(s).page(r.id, "a", 0, 100);
    assert.equal(events.filter(e => e.kind === "debugging.pruned").length, 1);
  }, s => {
    enable(s); s.checks.premise.argv = [process.execPath, "-e", timeout ? "setInterval(()=>{},10000)" : "process.exit(1)"];
    // Failure classification must not depend on Node cold-start latency when
    // the entire Foundry suite starts many test processes concurrently.
    s.checks.premise.probeTimeoutMs = timeout ? 60 : 2000;
  });
});

test("auditor crash replay consumes the same saved reply and preserves budgets", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  const mock = scripted([...loops(), () => reply("Three hypotheses: environment permission, interface mismatch, or unsupported dependency. Use discriminating controls."),
    () => reply("", [probe, write("42")]), () => reply("done")]);
  const driver = new SwarmDriver(s, cfg, mock.fetcher);
  const checkpoint = driver.journal.checkpoint.bind(driver.journal);
  driver.journal.checkpoint = (t, kind, payload) => {
    if (kind === "debugging.inversion") throw new Error("injected lost audit checkpoint");
    checkpoint(t, kind, payload);
  };
  await assert.rejects(() => driver.execute(c, signal()), /injected lost audit/);
  assert.equal(mock.bodies.length, 5); assert.ok(state(s, run).debugging.audit);
  const other = await Store.open(s.root);
  try {
    const replacement = new SwarmDriver(other, cfg, mock.fetcher);
    const r = await replacement.execute(c, signal());
    assert.equal(mock.bodies.length, 7); assert.equal(replacement.journal.usage(run).requests, 7);
    assert.equal(state(other, run).debugging.resets, 1);
    const v = await replacement.verify(c, r, signal());
    assert.equal(v.checks.find(c => c.id === "behavior")!.verdict, "PASS");
  } finally { other.close(); }
}, enable));

test("exhausted inversion budget ends the cyclic branch without another audit or worker request", async () => fixture(async s => {
  const mock = scripted(loops());
  const r: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(r.status, "FAIL"); assert.equal(mock.bodies.length, 4);
  assert.match(state(s, r.id).debugging.prunedReason, /NONCONVERGENT_DEBUGGING/);
  assert.match(formatHealth(runHealth(s, r.id)), /4 failing cycles/);
}, s => { enable(s); s.debugging!.maxInversionResets = 0; }));

test("a passing premise cannot replenish the lifetime inversion budget", async () => fixture(async s => {
  const mock = scripted([...loops(), () => reply("Three hypotheses: environment, contract, dependency; falsify each with controlled probes."),
    () => reply("", [probe]), ...loops()]);
  const r: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(r.status, "FAIL"); assert.equal(mock.bodies.length, 10);
  const d = state(s, r.id).debugging;
  assert.equal(d.resets, 1); assert.match(d.prunedReason, /NONCONVERGENT_DEBUGGING/);
}, enable));

test("the diagnostic deadline aborts a stuck provider and remains enforced after reopen", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "w")!);
  let calls = 0;
  const fetcher = (async (_url: any, init: any) => {
    calls++;
    if (calls === 1) return reply("", [write("1"), check]);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      if (init.signal.aborted) reject(init.signal.reason);
    });
  }) as typeof fetch;
  await assert.rejects(() => new SwarmDriver(s, cfg, fetcher).execute(c, signal()), /DEBUGGING_BRANCH_TIMEOUT/);
  const prior = calls;
  await assert.rejects(() => new SwarmDriver(s, cfg, fetcher).execute(c, signal()), /DEBUGGING_BRANCH_TIMEOUT/);
  assert.equal(calls, prior); assert.ok(prior <= 2);
}, s => { enable(s); s.debugging!.branchTimeoutMs = 150; }));

test("remote workers enforce named probe permissions and the coordinator-pinned process deadline", async () => fixture(async s => {
  const mock = scripted([() => reply("", [probe, write("42")])]);
  const r: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(r.status, "FAIL"); assert.equal(mock.bodies.length, 1);
  assert.match(state(s, r.id).debugging.prunedReason, /PROBE_INCONCLUSIVE/);
}, s => {
  enable(s);
  const endpoint = resolve("scripts/swarm-worker-agent.py"), parent = dirname(s.project);
  const workerRepo = join(parent, "worker-repo"), root = join(parent, "worker-root"), config = join(parent, "worker.json");
  execFileSync("git", ["clone", "-q", s.project, workerRepo]); mkdirSync(root);
  writeFileSync(config, JSON.stringify({ checks: { premise: { argv: [process.execPath, "-e", "setInterval(()=>{},10000)"] } } }));
  s.workers = { remote: { adapter: { argv: [executable("python3"), endpoint, "--root", root, "--repo", workerRepo, "--config", config],
    files: [endpoint, config] }, maxConcurrent: 1, maxRpcBytes: 1024 * 1024 } };
  s.checks.premise.probeTimeoutMs = 60;
}));
