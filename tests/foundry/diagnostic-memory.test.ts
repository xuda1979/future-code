import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { diagnosticContext, recordDiagnostic, pruningCandidate } from "../../src/harness/foundry/swarm/diagnostics.ts";
import { bytes, compactHistory, refreshDiagnosticNotice, type Message } from "../../src/harness/foundry/swarm/context.ts";
import { validateSwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { reflectRun } from "../../src/harness/foundry/rndReflection.ts";
import { superviseSwarm } from "../../src/harness/foundry/swarm/supervisor.ts";
import { fixture, task, signal, spec, reply, scripted } from "./swarm-fixtures.ts";

test("unchanged-failure limits are explicit bounded operator declarations", () => {
  const s = spec("/tmp/repo"); s.checks.behavior.maxUnchangedFailures = 2;
  validateSwarmSpec(s);
  for (const maxUnchangedFailures of [0, 1, 17, 2.5, "2", null])
    assert.throws(() => validateSwarmSpec({ ...s, checks: { behavior: {
      ...s.checks.behavior, maxUnchangedFailures,
    } } } as any), /unchanged failure/);
});

test("host failure fixtures are owned, bounded, resumable and bound to exact inputs", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "fixture")!);
  const journal = new SessionJournal(s);
  const t = journal.open(c, { history: [{ role: "user", content: "pinned" }], turns: 1,
    toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 32768 });
  const call = { id: "check", name: "run_check", arguments: { name: "behavior" } };
  const result = { code: 1, stdout: "", stderr: "数学 failure".repeat(100) };
  const receipt = journal.receipt(c, result);
  const failure = recordDiagnostic(t, journal, cfg, call, result, receipt, null, true)!;
  assert.equal(journal.ownsReceipt(c, failure.fixture), true);
  const fixture: any = s.readArtifact(failure.fixture);
  assert.equal(fixture.trust, "OBSERVATION_NOT_ACCEPTANCE");
  assert.equal(fixture.resultReceipt, receipt);
  assert.equal(fixture.contractHash, c.contractHash);
  assert.deepEqual((s.readArtifact(fixture.callReceipt) as any).arguments, call.arguments);
  assert.ok(Buffer.byteLength(failure.excerpt) <= 512);
  journal.checkpoint(t, "fixture.saved", {});
  const other = await Store.open(s.root);
  try {
    const reopened = new SessionJournal(other).open(c, t.state);
    assert.deepEqual(reopened.state.diagnostics, t.state.diagnostics);
  } finally { other.close(); }
  for (let i = 0; i < 12; i++) {
    const value = { error: "literal edit failed " + i }, id = journal.receipt(c, value);
    recordDiagnostic(t, journal, cfg, { id: "edit-" + i, name: "edit_file", arguments: {
      path: "src/a.txt", oldText: "absent-" + i, newText: "42" } }, value, id, null, true);
  }
  assert.ok(t.state.diagnostics!.failures.length <= 8);
  assert.ok(diagnosticContext(t.state)!.failures.length <= 4);
}));

test("pruning requires identical nonzero checks and resets on real evidence changes", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "fixture")!);
  const journal = new SessionJournal(s);
  const t = journal.open(c, { history: [{ role: "user", content: "pinned" }], turns: 1,
    toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 32768 });
  const call = { id: "check", name: "run_check", arguments: { name: "behavior" } };
  const result = { code: 1, stdout: "", stderr: "failure" }, receipt = journal.receipt(c, result);
  const record = () => recordDiagnostic(t, journal, cfg, call, result, receipt, t.state.patchHash, true);
  record(); record();
  assert.equal(pruningCandidate(t.state, cfg), null); // opt-in only
  const enabled = { ...cfg, spec: { ...cfg.spec, checks: { behavior: {
    ...cfg.spec.checks.behavior, maxUnchangedFailures: 2,
  } } } };
  assert.equal(pruningCandidate(t.state, enabled)?.repeats, 2);
  t.state.lastJobReceipt = "a".repeat(64);
  assert.equal(pruningCandidate(t.state, enabled), null);
  record(); assert.equal(pruningCandidate(t.state, enabled), null);
  const changed = { ...result, stderr: "new diagnostic" };
  recordDiagnostic(t, journal, enabled, call, changed, journal.receipt(c, changed), t.state.patchHash, true);
  assert.equal(pruningCandidate(t.state, enabled), null);
  const before = t.state.patchHash;
  t.state.patchHash = s.artifact("check mutated source");
  recordDiagnostic(t, journal, enabled, call, result, receipt, before, true);
  assert.equal(t.state.diagnostics!.failures[0]!.eligible, false);
  record(); assert.equal(pruningCandidate(t.state, enabled), null);
  record(); assert.equal(pruningCandidate(t.state, enabled)?.repeats, 2);
  t.state.lastSpawnReceipt = "c".repeat(64);
  assert.equal(pruningCandidate(t.state, enabled), null);
  record(); assert.equal(pruningCandidate(t.state, enabled), null);
  t.state.feedbackHash = "b".repeat(64);
  record(); assert.equal(pruningCandidate(t.state, enabled), null);
  t.state.patchHash = s.artifact("changed patch");
  record(); assert.equal(pruningCandidate(t.state, enabled), null);
  const unknown = { error: "deadline exceeded" }, unknownReceipt = journal.receipt(c, unknown);
  for (let i = 0; i < 3; i++) recordDiagnostic(t, journal, enabled, call, unknown, unknownReceipt, t.state.patchHash, true);
  assert.equal(pruningCandidate(t.state, enabled), null); // timeouts are not deterministic failed checks
  const ok = { code: 0, stdout: "", stderr: "" };
  recordDiagnostic(t, journal, enabled, call, ok, journal.receipt(c, ok), t.state.patchHash, true);
  assert.equal(t.state.diagnostics!.failures.filter(f => f.tool === "run_check").length, 0);
  const malformed = { error: "missing tool name" }, malformedReceipt = journal.receipt(c, malformed);
  recordDiagnostic(t, journal, enabled, { id: "bad", name: "run_check", arguments: {} }, malformed, malformedReceipt, t.state.patchHash, false);
  assert.equal(pruningCandidate(t.state, enabled), null);
  const forged = recordDiagnostic(t, journal, enabled, { id: "fake", name: "verification", arguments: { name: "behavior" } },
    malformed, malformedReceipt, t.state.patchHash, false)!;
  assert.equal(forged.kind, "TOOL_ERROR");
}));

test("tiered retirement retains failure evidence, currentness and complete tool pairs", () => {
  const history: Message[] = [{ role: "user", content: "immutable task and dependency contracts" }];
  for (let i = 0; i < 30; i++) history.push({ role: "assistant", content: "old " + "x".repeat(200),
    calls: [{ id: "c" + i, name: "read_file", arguments: { path: "src/a.txt" } }] },
    { role: "tool", callId: "c" + i, content: "reply " + i });
  const diagnostics = { trust: "OBSERVATION_NOT_ACCEPTANCE" as const, failures: [{
    tool: "run_check", check: "behavior", receipt: "a".repeat(64), fixture: "b".repeat(64),
    patchHash: "c".repeat(64), current: false, repeats: 1, excerpt: "type mismatch", kind: "CHECK_FAILED" as const,
  }] };
  const p = compactHistory(history, 1800, null, diagnostics);
  assert.ok(bytes(p) <= 1800); assert.deepEqual(p[0], history[0]);
  assert.match(p[1].content, /type mismatch/); assert.match(p[1].content, /"current":false/);
  const again = compactHistory(p, 1800, null, diagnostics);
  assert.match(again[1].content, /type mismatch/);
  assert.equal(again.filter(m => m.content.startsWith("[future-code:retired-context-v2]")).length, 1);
  assert.deepEqual(p.filter(m => m.calls).flatMap(m => m.calls!.map(c => c.id)),
    p.filter(m => m.role === "tool").map(m => m.callId));
  const tiny = compactHistory(history, 900, null, diagnostics);
  assert.ok(bytes(tiny) <= 900); assert.equal(tiny.at(-1)?.callId, "c29");
  const cleared = refreshDiagnosticNotice(p, null, null);
  assert.ok(!cleared[1].content.includes("hostDiagnostics"));
  assert.deepEqual(refreshDiagnosticNotice(cleared, null, null), cleared);
});

test("independent verifier failures are retained as observations and cannot authorize pruning", async () => fixture(async (s, cfg) => {
  const mock = scripted([
    () => reply("complete"),
    body => {
      assert.match(JSON.stringify(body.messages), /repairRequired/);
      const row = s.db.prepare("SELECT state FROM agent_threads WHERE task='a'").get()!;
      const state: any = s.readArtifact(row.state);
      const diagnostic = state.diagnostics.failures[0];
      assert.equal(diagnostic.kind, "VERIFICATION_FAILED");
      assert.equal(diagnostic.eligible, false);
      assert.equal(diagnosticContext(state)!.failures[0]!.current, true);
      assert.equal(pruningCandidate(state, cfg), null);
      return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    () => reply("ready"),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(mock.bodies.length, 3);
}, s => { s.checks.behavior.maxUnchangedFailures = 2; }));

test("a repeated unchanged check exits before another request and records host reflection", async () => fixture(async (s) => {
  const mock = scripted(Array.from({ length: 2 }, (_, i) => () => reply("", [
    { id: "check-" + i, name: "run_check", arguments: { name: "behavior" } },
  ])));
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "FAIL"); assert.equal(mock.bodies.length, 2);
  const error = s.db.prepare("SELECT error FROM tasks WHERE run=?").get(result.id)!.error;
  assert.match(error, /STAGNANT_DIAGNOSTIC/);
  const journal = new SessionJournal(s), events: any[] = journal.page(result.id, "a", 0, 100);
  assert.equal(events.filter(e => e.kind === "trajectory.pruned").length, 1);
  const reflection: any = reflectRun(s, "objective", result.id).reflection;
  assert.ok(reflection.findings.some((f: any) => f.code === "stagnant_diagnostic_pruned"));
}, s => { s.checks.behavior.maxUnchangedFailures = 2; }));

test("automatic checkpoints share the failure memory and prune before another model request", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "fixture")!);
  let thread: ReturnType<SessionJournal["open"]> | undefined;
  const mock = scripted(Array.from({ length: 2 }, (_, i) => () => {
    assert.ok(thread);
    // Deliberately make the checkpoint due after this model reply, independent
    // of machine speed or time spent preparing the initial thread.
    thread.state.lastCheckAt = 0;
    return reply("", [{ id: "read-" + i, name: "read_file", arguments: { path: "src/a.txt" } }]);
  }));
  const driver = new SwarmDriver(s, cfg, mock.fetcher);
  const open = driver.journal.open.bind(driver.journal);
  driver.journal.open = (capsule, initial) => {
    thread = open(capsule, initial);
    thread.state.lastCheckAt = Number.MAX_SAFE_INTEGER; // not due before the first request
    return thread;
  };
  await assert.rejects(() => driver.execute(c, signal()), /STAGNANT_DIAGNOSTIC/);
  assert.equal(mock.bodies.length, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='checkpoint.checked'").get()!.n, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='trajectory.pruned'").get()!.n, 1);
}, s => {
  s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 1, checkpointCadence: "periodic" };
  s.checks.behavior.maxUnchangedFailures = 2;
}));

test("an overdue cold checkpoint waits for the first model turn and still verifies the final patch", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "fixture")!);
  const mock = scripted([
    body => {
      assert.ok(!JSON.stringify(body.messages).includes("checkpointCheck"));
      return reply("", [{ name: "read_file", arguments: { path: "src/a.txt" } }]);
    },
    body => {
      assert.match(JSON.stringify(body.messages), /checkpointCheck/);
      return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    () => reply("complete"),
  ]);
  const driver = new SwarmDriver(s, cfg, mock.fetcher), open = driver.journal.open.bind(driver.journal);
  driver.journal.open = (capsule, initial) => {
    const thread = open(capsule, initial);
    thread.state.lastCheckAt = 0; // due before startup without relying on a timer
    return thread;
  };
  const result = await driver.execute(c, signal());
  const verification = await driver.verify(c, result, signal());
  assert.equal(verification.checks.find(c => c.id === "behavior")?.verdict, "PASS");
  assert.equal(mock.bodies.length, 3);
}, s => { s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 1, checkpointCadence: "periodic" }; }));

test("host failure memory reaches the encoded provider request and preserves durable reply replay", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "fixture")!);
  const mock = scripted([
    () => reply("", [{ id: "original-failure", name: "run_check", arguments: { name: "behavior" } }]),
    ...Array.from({ length: 6 }, (_, i) => () => reply("x".repeat(1600), [
      { id: "read-" + i, name: "read_file", arguments: { path: "src/a.txt" } },
    ])),
    body => {
      assert.ok(bytes(body) <= cfg.spec.recipe.contextBytes);
      assert.ok(!body.messages.some((m: any) => m.tool_call_id === "original-failure"));
      const notice = body.messages.find((m: any) => m.content?.includes?.("hostDiagnostics"));
      assert.ok(notice, "retired failure must remain explicit");
      assert.match(notice.content, /Check exited with code 1/);
      assert.match(notice.content, /"current":true/);
      return reply("", [{ id: "repair", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    body => {
      const notice = body.messages.find((m: any) => m.content?.includes?.("hostDiagnostics"));
      assert.ok(notice); assert.match(notice.content, /"current":false/);
      return reply("ready for independent verification");
    },
  ]);
  const driver = new SwarmDriver(s, cfg, mock.fetcher);
  const checkpoint = driver.journal.checkpoint.bind(driver.journal);
  let lost = false;
  driver.journal.checkpoint = (thread, kind, payload) => {
    if (!lost && kind === "model.reply" && (payload as Message).calls?.[0]?.id === "repair") {
      lost = true; throw new Error("injected lost model.reply checkpoint");
    }
    checkpoint(thread, kind, payload);
  };
  await assert.rejects(() => driver.execute(c, signal()), /injected lost/);
  assert.equal(mock.bodies.length, 8);
  const replacement = new SwarmDriver(s, cfg, mock.fetcher);
  const result = await replacement.execute(c, signal());
  assert.equal(mock.bodies.length, 9, "saved reply is consumed without another request");
  assert.equal(replacement.journal.usage(run).requests, 9);
  const verification = await replacement.verify(c, result, signal());
  assert.equal(verification.checks.find(c => c.id === "behavior")?.verdict, "PASS");
}, s => { s.recipe.contextBytes = 8192; }));

test("pruning recovers the objective through a different plan with bounded diagnostic evidence", async () => fixture(async s => {
  const mock = scripted([
    () => reply("", [{ name: "run_check", arguments: { name: "behavior" } }]),
    () => reply("", [{ name: "run_check", arguments: { name: "behavior" } }]),
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("complete"),
  ]);
  let recovered = 0;
  const result: any = await superviseSwarm(s, { id: "diagnostic-recovery", goal: "Implement verified behavior", tasks: [task()] },
    signal(), undefined, mock.fetcher, async context => {
      recovered++;
      assert.equal(context.failures[0]!.diagnostics!.failures[0]!.check, "behavior");
      assert.equal(context.failures[0]!.diagnostics!.trust, "OBSERVATION_NOT_ACCEPTANCE");
      return { reason: "Repair the implementation before checking again",
        tasks: [{ ...task(), id: "repair", goal: "Apply the corrected implementation before rerunning diagnostics" }],
        addressedFindings: ["stagnant_diagnostic_pruned"] };
    });
  assert.equal(result.status, "PASS"); assert.equal(recovered, 1); assert.equal(mock.bodies.length, 4);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM swarm_objective_revisions").get()!.n, 2);
}, s => {
  s.checks.behavior.maxUnchangedFailures = 2;
  s.supervision = { reportEveryMs: 1000, checkpointEveryMs: 600000, maxReplans: 1 };
}));

test("scripted unchanged-failure loop uses 2 requests/checks instead of exhausting 20 turns", async () => {
  const requests: number[] = [], checks: number[] = [];
  for (const enabled of [false, true]) await fixture(async s => {
    const mock = scripted(Array.from({ length: 20 }, (_, i) => () => reply("", [
      { id: "check-" + i, name: "run_check", arguments: { name: "behavior" } },
    ])));
    const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
    assert.equal(result.status, "FAIL"); requests.push(mock.bodies.length);
    checks.push(s.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='tool.result'").get()!.n);
  }, s => { if (enabled) s.checks.behavior.maxUnchangedFailures = 2; });
  assert.deepEqual(requests, [20, 2]); assert.deepEqual(checks, [20, 2]);
});

test("remaining edits in a complete tool turn can repair a failure before pruning", async () => fixture(async s => {
  const mock = scripted([
    () => reply("", [{ name: "run_check", arguments: { name: "behavior" } }]),
    () => reply("", [
      { id: "check-again", name: "run_check", arguments: { name: "behavior" } },
      { id: "repair", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } },
      { id: "check-repaired", name: "run_check", arguments: { name: "behavior" } },
    ]),
    () => reply("ready for independent verification"),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(mock.bodies.length, 3);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='trajectory.pruned'").get()!.n, 0);
}, s => { s.checks.behavior.maxUnchangedFailures = 2; }));

test("batched edit failures retain fixtures and cannot certify an unchanged candidate", async () => fixture(async s => {
  const mock = scripted([
    () => reply("", [0, 1].map(i => ({ id: "bad-" + i, name: "edit_file", arguments: {
      path: "src/a.txt", oldText: "absent-" + i, newText: "42" } }))),
    () => reply("done"),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "FAIL");
  const row = s.db.prepare("SELECT state FROM agent_threads WHERE run=?").get(result.id)!;
  const state: any = s.readArtifact(row.state);
  assert.equal(state.diagnostics.failures.length, 2);
  for (const failure of state.diagnostics.failures) {
    const evidence: any = s.readArtifact(failure.fixture);
    assert.equal(evidence.trust, "OBSERVATION_NOT_ACCEPTANCE");
    assert.equal(evidence.snapshotBoundary, "tool-batch");
    assert.equal((s.readArtifact(evidence.batchCallsReceipt) as any).calls.length, 2);
    assert.match((s.readArtifact(evidence.resultReceipt) as any).error, /exactly one match/);
  }
}, s => { s.recipe.attempts = 1; }));

test("pruned trajectory remains pruned after reopen without another provider call", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "fixture")!);
  const mock = scripted(Array.from({ length: 2 }, () => () => reply("", [{ name: "run_check", arguments: { name: "behavior" } }])));
  await assert.rejects(() => new SwarmDriver(s, cfg, mock.fetcher).execute(c, signal()), /STAGNANT_DIAGNOSTIC/);
  const other = await Store.open(s.root);
  try {
    await assert.rejects(() => new SwarmDriver(other, cfg, mock.fetcher).execute(c, signal()), /STAGNANT_DIAGNOSTIC/);
    assert.equal(mock.bodies.length, 2);
  } finally { other.close(); }
}, s => { s.checks.behavior.maxUnchangedFailures = 2; }));
