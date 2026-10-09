import { test } from "node:test";
import assert from "node:assert/strict";
import { compactHistory, bytes, type Message } from "../../src/harness/foundry/swarm/context.ts";
import { fixture, task, signal, scripted, reply } from "./swarm-fixtures.ts";
import { runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";

test("linear retirement keeps maximum complete suffix under exact UTF-8 budget", () => {
  const groups: Message[] = [{ role: "user", content: "pinned task" }];
  for (let i = 0; i < 1000; i++) {
    groups.push({ role: "assistant", content: "thought " + i + "🐈".repeat(i % 4),
      calls: [{ id: "c" + i, name: "read_file", arguments: { path: "x" } }] });
    groups.push({ role: "tool", callId: "c" + i, content: "reply " + i });
  }
  const budget = 2000;
  const projected = compactHistory(groups, budget);
  assert.ok(bytes(projected) <= budget);
  assert.equal(projected[0].content, "pinned task");
  assert.ok(projected[1].content.includes("retired-context-v2"));
  const calls = projected.filter(m => m.role === "assistant").flatMap(m => m.calls?.map(c => c.id) ?? []);
  assert.deepEqual(calls, projected.filter(m => m.role === "tool").map(m => m.callId));
  assert.ok(calls.length > 0);
  assert.equal(projected.at(-1)?.callId, "c999");
  const repeated = compactHistory(projected, budget);
  assert.ok(repeated.filter(m => m.content.includes("retired-context-v2")).length <= 1);
});

test("checkpoint falls back to journal pointer if the note does not fit", () => {
  const history: Message[] = [{ role: "user", content: "objective" },
    { role: "assistant", content: "x".repeat(1000) },
    { role: "assistant", content: "most recent" }];
  const progress = { summary: "y".repeat(1000), nextAction: "verify", receipts: [],
    patchHash: null, atTurn: 4 };
  const p = compactHistory(history, 480, progress);
  assert.ok(bytes(p) <= 480);
  assert.ok(!p[1].content.includes("y".repeat(100)));
  assert.equal(p.at(-1)?.content, "most recent");
});

test("progress survives journal reopen and no unowned receipt is accepted", async () => fixture(async (s) => {
  const q = new Scheduler(s), run = q.start([task()]);
  const l = q.claim(run, "test")!, c = q.capsule(l);
  const journal = new SessionJournal(s);
  const t = journal.open(c, { history: [{ role: "user", content: "pinned" }],
    turns: 0, toolCalls: 0, patchHash: null, pending: null, output: null,
    feedbackHash: null, contextLimit: 8192 });
  const receipt = journal.receipt(c, { evidence: "raw observation" });
  assert.equal(journal.ownsReceipt(c, receipt), true);
  assert.equal(journal.ownsReceipt(c, "f".repeat(64)), false);
  t.state.progress = { summary: "blocked", nextAction: "try variant",
    receipts: [receipt], patchHash: null, atTurn: 1 };
  journal.checkpoint(t, "note.saved", {});
  assert.deepEqual(new SessionJournal(s).open(c, t.state).state.progress, t.state.progress);
}));

test("save_progress tool rejects unowned receipts without accepting agent assertions", async () => fixture(async (s) => {
  const mock = scripted([
    () => reply("", [{ name: "save_progress", arguments: {
      summary: "I say PASS", nextAction: "run checks", receipts: ["a".repeat(64)] } }]),
    body => {
      assert.match(JSON.stringify(body.messages), /unowned progress receipt/);
      return reply("finished");
    },
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "FAIL"); // unchanged project still fails independent behavior check
}, s => { s.agents.coder.tools.push("save_progress"); }));
