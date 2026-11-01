import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { compactHistory, inlineReceipt, type Message } from "../../src/harness/foundry/swarm/context.ts";
import { recordDiagnostic } from "../../src/harness/foundry/swarm/diagnostics.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import type { SurfaceResult } from "../../src/harness/surface/protocol.ts";
import { fixture as surfaceFixture } from "../surface/fixtures.ts";
import { fixture, task, signal, scripted, reply } from "./swarm-fixtures.ts";

test("surface context keeps one spatial frame even before the token budget fills", async () => surfaceFixture(async c => {
  const history: Message[] = [{ role: "user", content: "immutable task" }];
  for (let i = 0; i < 10; i++) {
    const surface = await c.observe(), receipt = String(i).padStart(64, "a");
    const content = inlineReceipt(receipt, JSON.parse(JSON.stringify({ result: { surface } })), 2048);
    assert.ok(Buffer.byteLength(content) <= 2048);
    assert.equal(JSON.parse(content).surfaceContext.frameId, surface.frame.frameId);
    history.push({ role: "assistant", content: "", calls: [{ id: String(i), name: "invoke_capability", arguments: {} }] },
      { role: "tool", callId: String(i), receipt, content });
  }
  const projected = compactHistory(history, 1000000);
  const tools = projected.filter(m => m.role === "tool").map(m => JSON.parse(m.content));
  assert.equal(tools.filter(m => m.surfaceContext).length, 1); assert.equal(tools.filter(m => m.retired).length, 9);
  assert.equal(projected.length, history.length); assert.deepEqual(projected[0], history[0]);
  assert.deepEqual(compactHistory(projected, 1000000), projected);
}));

test("failed perceptual receipts enter owned falsification memory without claiming acceptance", async () => surfaceFixture(async surface => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]), c = q.capsule(q.claim(run, "surface")!), journal = new SessionJournal(s);
  const t = journal.open(c, { history: [{ role: "user", content: "task" }], turns: 1, toolCalls: 0, patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 32768 });
  const observed = await surface.observe(); observed.ok = false;
  const value = JSON.parse(JSON.stringify({ result: { surface: observed } })), receipt = journal.receipt(c, value);
  const failure = recordDiagnostic(t, journal, cfg, { id: "click", name: "invoke_capability", arguments: { name: "surface_act", input: {} } }, value, receipt, null, true);
  assert.equal(failure?.kind, "SURFACE_FAILED"); assert.equal(journal.ownsReceipt(c, failure!.fixture), true);
  assert.equal(failure?.eligible, false); assert.match(failure!.excerpt, /observe and falsify/);
})));

test("surface human handoff releases execution without spending another model turn", async () => surfaceFixture(async surface => {
  const observed = await surface.observe();
  const blocked: SurfaceResult = { ...observed, ok: false, interrupt: { signal: "SIG_SURFACE_INTERVENTION", id: "human", since: Date.now(), reason: "CAPTCHA", frameId: observed.frame.frameId } };
  await fixture(async (s, cfg, project) => {
    const q = new Scheduler(s), run = q.start([task()]), lease = q.claim(run, "human")!, c = q.capsule(lease);
    const mock = scripted([() => reply("", [{ name: "invoke_capability", arguments: { name: "surface_observe", input: {} } }]),
      () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]), () => reply("done")]);
    const driver = new SwarmDriver(s, cfg, mock.fetcher);
    await assert.rejects(() => driver.execute(c, signal()), (e: any) => e instanceof DeferredAttemptError && /SIG_SURFACE_INTERVENTION/.test(e.message));
    assert.equal(mock.bodies.length, 1);
    const row = s.db.prepare("SELECT state FROM agent_threads WHERE run=?").get(run)!;
    const state = s.readArtifact(row.state) as any; assert.equal(state.pending.name, "invoke_capability");
    writeFileSync(join(project, "../surface-observation.json"), JSON.stringify({ ...blocked, interrupt: undefined, ok: true }));
    const result = await driver.execute(c, signal());
    assert.equal(mock.bodies.length, 3); assert.equal((result.artifact as any).summary, "done");
    assert.ok(s.db.prepare("SELECT 1 FROM agent_events WHERE kind='surface.intervention'").get());
  }, spec => {
    const path = join(spec.project, "../surface-observation.json"); writeFileSync(path, JSON.stringify(blocked));
    const adapter = `const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify({schema:1,key:r.key,inputHash:r.inputHash,status:'CONFIRMED',result:{surface:JSON.parse(fs.readFileSync(${JSON.stringify(path)},'utf8'))}}))`;
    spec.operations = { schema: 1, namespace: "surface-test", resources: {}, timeoutMs: 1000, maxBytes: 65536, pollMs: 10, maxModelRequests: 10, maxModelRequestBytes: 1000000,
      capabilities: { surface_observe: { adapter: { argv: [process.execPath, "-e", adapter] }, effect: "read", input: { type: "object", properties: {} } } } };
    spec.agents.coder.tools.push("invoke_capability"); spec.agents.coder.capabilities = ["surface_observe"];
  });
}));
