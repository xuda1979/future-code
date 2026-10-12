import { test } from "node:test";
import assert from "node:assert/strict";
import { bytes } from "../../src/harness/foundry/swarm/context.ts";
import { readMemory, rebuildMemoryPage, progressMemory, failureMemory } from "../../src/harness/foundry/swarm/memory.ts";
import { recordDiagnostic } from "../../src/harness/foundry/swarm/diagnostics.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { fixture, task, signal, scripted, reply } from "./swarm-fixtures.ts";
import { runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { handleSwarm } from "../../src/harness/foundry/swarm/cli.ts";

test("indexed notes are bounded, patch-bound, owned and survive reopen/rebuild", async () => fixture(async s => {
  const q = new Scheduler(s), run = q.start([{ ...task(), readScope: ["src/a.txt"] }, { ...task("b"), readScope: ["src/b.txt"] }]);
  const c = q.capsule(q.claim(run, "a")!), other = q.capsule(q.claim(run, "b")!);
  const journal = new SessionJournal(s);
  const t = journal.open(c, { history: [{ role: "user", content: "pinned" }], turns: 0,
    toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 8192 });
  const patches = [s.artifact("patch one"), s.artifact("patch two")];
  for (let i = 0; i < 12; i++) {
    t.state.patchHash = patches[i % 2]; t.state.turns++;
    t.state.progress = { summary: "中文🐈".repeat(200) + i, nextAction: "verify " + i,
      receipts: [], patchHash: t.state.patchHash, atTurn: t.state.turns };
    const entry = progressMemory(t.state.progress, journal.receipt(c, JSON.parse(JSON.stringify(t.state.progress))));
    journal.checkpoint(t, "tool.result", { memory: [entry] });
  }
  const page = readMemory(s, c, { kind: "progress", limit: 10 }, t.state);
  assert.ok(bytes(page) <= 2048); assert.ok(page.items.length > 0 && page.items.length < 10);
  assert.equal(page.items[0].currentPatch, true);
  assert.equal(page.items[1].currentPatch, false);
  assert.ok(page.items.every(e => journal.ownsReceipt(c, e.receipt)));
  assert.equal(readMemory(s, other, { kind: "all" }, t.state).items.length, 0);
  const filtered = readMemory(s, c, { kind: "progress", patchHash: patches[0] }, t.state);
  assert.ok(filtered.items.every(e => e.patchHash === patches[0] && e.currentPatch === false));
  const seen: string[] = []; let before: string | undefined;
  do {
    const next = readMemory(s, c, { kind: "all", before, limit: 10 }, t.state);
    seen.push(...next.items.map(e => e.cursor)); before = next.nextBefore ?? undefined;
  } while (before);
  assert.equal(seen.length, 12); assert.equal(new Set(seen).size, 12);
  const reopened = await Store.open(s.root);
  try {
    new SessionJournal(reopened);
    assert.deepEqual(readMemory(reopened, c, { kind: "all" }, t.state), readMemory(s, c, { kind: "all" }, t.state));
  } finally { reopened.close(); }
  const cli = await handleSwarm(["memory", "--root", s.root, "--run", run, "--task", c.task.id, "--limit", "10"]);
  assert.deepEqual(cli, page);
  s.db.exec("DELETE FROM agent_memory");
  let after = 0, complete = false;
  while (!complete) {
    const rebuilt = rebuildMemoryPage(s, run, c.task.id, after, 3);
    after = rebuilt.nextAfter; complete = rebuilt.complete;
  }
  assert.deepEqual(readMemory(s, c, { kind: "all" }, t.state).items.map(e => e.cursor), seen.slice(0, page.items.length));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_memory").get()!.n, 12);
  const rebuiltAgain: any = await handleSwarm(["memory-rebuild", "--root", s.root, "--run", run, "--task", c.task.id]);
  assert.equal(rebuiltAgain.complete, true); assert.equal(rebuiltAgain.indexed, 12);
  s.db.prepare("UPDATE agent_memory SET patch_hash=? WHERE run=? AND task=? AND seq=12").run("f".repeat(64), run, c.task.id);
  assert.throws(() => readMemory(s, c, { kind: "all" }, t.state), /differs from source/);
  rebuildMemoryPage(s, run, c.task.id);
  assert.deepEqual(readMemory(s, c, { kind: "all", limit: 10 }, t.state), page);
}));

test("a successful short task leaves the cold index empty", async () => fixture(async s => {
  const mock = scripted([
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("ready"),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(mock.bodies.length, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_memory").get()!.n, 0);
}));

test("cold failures stay historical when job evidence changes and hot diagnostics clear", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "a")!);
  const journal = new SessionJournal(s);
  const t = journal.open(c, { history: [{ role: "user", content: "pinned" }], turns: 1,
    toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 8192 });
  const call = { id: "check", name: "run_check", arguments: { name: "behavior" } };
  const failed = { code: 1, stderr: "behavior mismatch" }, receipt = journal.receipt(c, failed);
  const diagnostic = recordDiagnostic(t, journal, cfg, call, failed, receipt, null, true)!;
  journal.checkpoint(t, "tool.result", { memory: [failureMemory(diagnostic, t.state.turns)] });
  assert.equal(readMemory(s, c, { kind: "failure" }, t.state).items[0].currentInput, true);
  t.state.lastJobReceipt = journal.receipt(c, { result: "new external observation" });
  const stale = readMemory(s, c, { kind: "failure" }, t.state).items[0];
  assert.equal(stale.currentPatch, true); assert.equal(stale.currentInput, false);
  const ok = { code: 0 };
  recordDiagnostic(t, journal, cfg, call, ok, journal.receipt(c, ok), null, true);
  assert.equal(t.state.diagnostics!.failures.length, 0);
  assert.equal(readMemory(s, c, { kind: "failure" }, t.state).items[0].receipt, diagnostic.fixture);
  assert.equal((s.readArtifact(diagnostic.fixture) as any).resultReceipt, receipt);
}));

test("same-event batched failures use ordinal cursors without skipping entries", async () => fixture(async s => {
  const mock = scripted([
    () => reply("", [0, 1].map(i => ({ name: "edit_file", arguments: { path: "src/a.txt", oldText: "missing-" + i, newText: "42" } }))),
    () => reply("", [{ name: "recall", arguments: { memoryKind: "failure", limit: 1 } }]),
    body => {
      const page = JSON.parse(body.messages.at(-1).content);
      assert.equal(page.items.length, 1); assert.ok(page.nextBefore);
      assert.match(page.items[0].cursor, /:1$/);
      return reply("", [{ name: "recall", arguments: { memoryKind: "failure", limit: 1, memoryBefore: page.nextBefore } }]);
    },
    body => {
      const page = JSON.parse(body.messages.at(-1).content);
      assert.equal(page.items.length, 1); assert.equal(page.nextBefore, null);
      assert.match(page.items[0].cursor, /:0$/);
      return reply("complete");
    },
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "FAIL"); assert.equal(mock.bodies.length, 4);
}, spec => { spec.recipe.attempts = 1; }));

test("memory indexing rolls back with its source checkpoint and rejects foreign receipts", async () => fixture(async s => {
  const q = new Scheduler(s), run = q.start([{ ...task(), readScope: ["src/a.txt"] }, { ...task("b"), readScope: ["src/b.txt"] }]);
  const c = q.capsule(q.claim(run, "a")!), other = q.capsule(q.claim(run, "b")!);
  const journal = new SessionJournal(s);
  const t = journal.open(c, { history: [{ role: "user", content: "pinned" }], turns: 0,
    toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 8192 });
  const note = { summary: "hint", nextAction: "check", receipts: [], patchHash: null, atTurn: 0 };
  const foreign = journal.receipt(other, JSON.parse(JSON.stringify(note)));
  assert.throws(() => journal.checkpoint(t, "tool.result", { memory: [progressMemory(note, foreign)] }), /unowned memory receipt/);
  assert.equal(t.seq, 0);
  assert.equal(journal.page(run, c.task.id).length, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_memory").get()!.n, 0);
  assert.throws(() => readMemory(s, c, { kind: "all", before: "1:evil" }, t.state), /memory cursor/);
  assert.throws(() => readMemory(s, c, { kind: "all", failureSignature: "bad" }, t.state), /memory hash/);
}));

test("memory supports the full 128-check ceiling and reads each source event once per page", async () => fixture(async s => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "a")!);
  const journal = new SessionJournal(s);
  const t = journal.open(c, { history: [{ role: "user", content: "pinned" }], turns: 1,
    toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 8192 });
  const note = { summary: "small note", nextAction: "verify", receipts: [], patchHash: null, atTurn: 1 };
  const e = progressMemory(note, journal.receipt(c, JSON.parse(JSON.stringify(note))));
  journal.checkpoint(t, "verification.feedback", { memory: Array.from({ length: 128 }, () => e) });
  const original = s.readArtifact.bind(s); let reads = 0;
  s.readArtifact = hash => { reads++; return original(hash); };
  try {
    const page = readMemory(s, c, { kind: "all", limit: 2 }, t.state);
    assert.deepEqual(page.items.map(item => item.cursor), ["1:127", "1:126"]);
    assert.equal(reads, 1);
    assert.equal(readMemory(s, c, { kind: "all", before: page.nextBefore!, limit: 1 }, t.state).items[0].cursor, "1:125");
  } finally { s.readArtifact = original; }
}));

test("save_progress and cold failures can be recalled without turning notes into acceptance", async () => fixture(async s => {
  let signature = "";
  const mock = scripted([
    () => reply("", [{ name: "run_check", arguments: { name: "behavior" } }]),
    () => reply("", [{ name: "save_progress", arguments: { summary: "I assert PASS", nextAction: "repair", receipts: [] } }]),
    () => reply("", [{ name: "recall", arguments: { memoryKind: "failure" } }]),
    body => {
      const result = JSON.parse(body.messages.at(-1).content);
      assert.equal(result.items[0].trust, "OBSERVATION_NOT_ACCEPTANCE");
      signature = result.items[0].failureSignature;
      assert.ok(/^[a-f0-9]{64}$/.test(signature));
      return reply("", [{ name: "recall", arguments: { memoryKind: "failure", failureSignature: signature } }]);
    },
    body => {
      assert.equal(JSON.parse(body.messages.at(-1).content).items[0].failureSignature, signature);
      return reply("", [{ name: "recall", arguments: { memoryKind: "progress" } }]);
    },
    body => {
      assert.equal(JSON.parse(body.messages.at(-1).content).items[0].trust, "UNVERIFIED_AGENT_NOTE_NOT_ACCEPTANCE");
      return reply("", [{ name: "recall", arguments: { memoryKind: "all", receipt: "a".repeat(64) } }]);
    },
    body => {
      assert.match(body.messages.at(-1).content, /ambiguous recall/);
      return reply("done");
    },
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "FAIL"); assert.equal(mock.bodies.length, 7);
}, spec => { spec.agents.coder.tools.push("save_progress"); spec.recipe.attempts = 1; }));
