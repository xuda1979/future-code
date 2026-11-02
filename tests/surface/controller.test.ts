import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { SurfaceController } from "../../src/harness/surface/controller.ts";
import { validateBatch } from "../../src/harness/surface/protocol.ts";
import type { SurfaceBatch } from "../../src/harness/surface/protocol.ts";

import { fixture } from "./fixtures.ts";

const click = (frameId: string, markId = 2): SurfaceBatch => ({ expectedFrameId: frameId,
  steps: [{ action: { kind: "activate", markId }, expect: { targetFocused: markId }, settleTimeoutMs: 100 }] });

test("HID input and guards reject malformed/ambiguous effects before dispatch", () => {
  for (const action of [{ kind: "activate" }, { kind: "activate", markId: 1, coords: { x: 0.5, y: 0.5 } },
    { kind: "activate", coords: { x: Infinity, y: 0 } }, { kind: "scroll", direction: "down", amountPx: -1 },
    { kind: "input", markId: 0, text: "x" }, { kind: "evaluate", script: "anything" }]) {
    assert.throws(() => validateBatch({ expectedFrameId: "f", steps: [{ action, expect: { uriChanged: true } }] } as any));
  }
  assert.throws(() => validateBatch({ expectedFrameId: "f", steps: [{ action: { kind: "activate", markId: 1 }, expect: {} }] }));
});

test("guarded microsteps rebind object identity when ephemeral marks reorder", async () => fixture(async (c, d) => {
  const observed = await c.observe();
  const effect = d.effect;
  d.effect = (a, ref) => { effect(a, ref); if (a.kind === "input") { d.state.nodes.reverse(); d.state.nodes.forEach((n, i) => { n.markId = i + 1; }); } };
  const result = await c.execute("batch", { expectedFrameId: observed.frame.frameId, steps: [
    { action: { kind: "activate", markId: 1 }, expect: { targetFocused: 1 } },
    { action: { kind: "input", markId: 1, text: "quantum" }, expect: { targetValue: { markId: 1, equals: "quantum" } } },
    { action: { kind: "activate", markId: 2 }, expect: { targetFocused: 2 } },
  ] });
  assert.equal(result.ok, true); assert.equal(d.dispatches, 3);
  assert.equal(result.frame.nodes.find(n => n.ref === "input")?.value, "quantum");
  assert.ok(result.frame.nodes.find(n => n.ref === "button")?.states.includes("focused"));
  assert.equal(result.affordanceNotes?.length, 3);
}));

test("silent no-op is falsified and the remaining batch is not dispatched", async () => fixture(async (c, d) => {
  const f = (await c.observe()).frame; d.effect = () => {};
  const batch = click(f.frameId); batch.steps.push(batch.steps[0]);
  const result = await c.execute("silent", batch);
  assert.equal(result.ok, false); assert.equal(result.receipts.length, 1); assert.equal(result.receipts[0].outcome, "SILENT_NO_OP");
  assert.equal(result.receipts[0].silentNoOpDetected, true); assert.equal(d.dispatches, 1);
}));

test("background analytics and pixel motion cannot satisfy a failed semantic guard", async () => fixture(async (c, d) => {
  const f = (await c.observe()).frame; d.effect = () => {};
  d.signalsValue = { network: [{ method: "POST", status: 204, resourceType: "fetch" }], storageChanged: true, visualDiffRatio: 0.5, targetVisualDiffRatio: 0 };
  const result = await c.execute("analytics", click(f.frameId));
  assert.equal(result.receipts[0].outcome, "POSTCONDITION_FAILED"); assert.equal(result.ok, false);
}));

test("an already-satisfied idempotent predicate is not a fabricated no-op failure", async () => fixture(async (c, d) => {
  d.state.nodes[1].states.push("focused"); const f = (await c.observe()).frame;
  d.effect = () => {};
  const result = await c.execute("already", click(f.frameId));
  assert.equal(result.receipts[0].outcome, "VERIFIED");
}));

test("delayed widget state is polled without replaying physical input", async () => fixture(async (c, d) => {
  const f = (await c.observe()).frame;
  d.effect = () => { setTimeout(() => { d.state.nodes[1].states.push("focused"); }, 80); };
  const batch = click(f.frameId); batch.steps[0].settleTimeoutMs = 300;
  const result = await c.execute("delayed", batch);
  assert.equal(result.ok, true); assert.equal(d.dispatches, 1); assert.ok(result.receipts[0].settledAfterMs >= 70);
}));

test("a stale frame or intervening layout change cannot authorize another control", async () => fixture(async (c, d) => {
  const f = (await c.observe()).frame; await c.observe();
  assert.equal((await c.execute("stale", click(f.frameId))).receipts[0].outcome, "STALE_TARGET");
  const g = (await c.observe()).frame; d.state.nodes[1].name = "Different action";
  assert.equal((await c.execute("changed", click(g.frameId))).receipts[0].outcome, "STALE_TARGET");
  assert.equal(d.dispatches, 0);
}));

test("occlusion permits one scroll/reobserve reflex, never a forced/repeated click", async () => fixture(async (c, d) => {
  d.state.nodes[1].hitTestClear = false; const f = (await c.observe()).frame;
  assert.equal((await c.execute("covered", click(f.frameId))).receipts[0].outcome, "OCCLUDED");
  assert.equal(d.dispatches, 0); assert.equal(d.reveals, 1);
  const g = (await c.observe()).frame;
  d.reveal = async () => { d.reveals++; d.state.nodes[1].hitTestClear = true; };
  assert.equal((await c.execute("revealed", click(g.frameId))).ok, true); assert.equal(d.dispatches, 1);
}));

test("settling timeout aborts rather than interpreting network activity as success", async () => fixture(async (c, d) => {
  const f = (await c.observe()).frame;
  d.settle = async () => ({ settled: false, elapsedMs: 100 });
  const result = await c.execute("timeout", click(f.frameId));
  assert.equal(result.receipts[0].outcome, "SETTLE_TIMEOUT"); assert.equal(result.ok, false);
}));

test("durable action identity rejects drift and suppresses resends after lost replies", async () => fixture(async (c, d, j, root) => {
  const f = (await c.observe()).frame, batch = click(f.frameId);
  const first = await c.execute("stable", batch);
  const second = await c.execute("stable", batch);
  assert.deepEqual(first, second); assert.equal(d.dispatches, 1);
  const replacement = new SurfaceController(d, j);
  assert.deepEqual(await replacement.execute("stable", batch), first);
  await assert.rejects(() => replacement.execute("stable", click("different")), /payload drift/);
  assert.throws(() => j.inspect("stable", click("different")), /payload drift/);
  assert.ok(j.db.prepare("SELECT COUNT(*) n FROM episodes").get()!.n);
}));

test("a crash between intent and receipt stays UNKNOWN and requires intervention", async () => fixture(async (c, d, j) => {
  const f = (await c.observe()).frame, batch = click(f.frameId);
  j.start("crash", batch);
  const replacement = new SurfaceController(d, j), result = await replacement.execute("crash", batch);
  assert.equal(result.receipts[0].outcome, "UNKNOWN"); assert.equal(result.interrupt?.signal, "SIG_SURFACE_INTERVENTION");
  assert.equal(d.dispatches, 0); assert.equal(result.liveness.paused, true);
  await assert.rejects(() => replacement.resume(result.interrupt!.id, result.frame.frameId), /explicit operator reconciliation/);
  const reconciled = await replacement.reconcile("crash", batch, result.interrupt!.id, result.frame.frameId);
  assert.equal(reconciled.ok, false); assert.equal(reconciled.receipts[0].outcome, "OPERATOR_RECONCILED");
  assert.equal(reconciled.interrupt, undefined);
  assert.equal((await replacement.execute("crash", batch)).receipts[0].outcome, "OPERATOR_RECONCILED"); assert.equal(d.dispatches, 0);
}));

test("a dispatch exception is uncertain, recorded, and never automatically replayed", async () => fixture(async (c, d) => {
  const f = (await c.observe()).frame, batch = click(f.frameId);
  d.effect = () => { throw new Error("lost transport acknowledgement"); };
  const result = await c.execute("lost", batch);
  assert.equal(result.receipts[0].outcome, "UNKNOWN"); assert.equal(result.interrupt?.reason, "UNKNOWN_ACTION");
  await c.execute("lost", batch); assert.equal(d.dispatches, 1);
}));

test("CAPTCHA handoff persists across turns, resumes only with fresh operator acknowledgement", async () => fixture(async (c, d, j) => {
  d.state.blocker = "CAPTCHA"; const interrupted = await c.observe(); await delay(5);
  assert.ok(interrupted.interrupt); assert.equal((await c.observe()).interrupt?.id, interrupted.interrupt.id);
  await assert.rejects(() => c.resume(interrupted.interrupt!.id, interrupted.frame.frameId), /stale/);
  const blocked = await c.observe(); await assert.rejects(() => c.resume(blocked.interrupt!.id, blocked.frame.frameId), /still present/);
  delete d.state.blocker;
  const ready = await c.observe(); assert.ok(ready.interrupt, "barrier disappearance does not auto-resume");
  const resumed = await c.resume(ready.interrupt!.id, ready.frame.frameId);
  assert.equal(resumed.interrupt, undefined); assert.equal(resumed.liveness.paused, false); assert.ok(resumed.liveness.pausedMs >= 5);
  assert.ok(j.db.prepare("SELECT 1 FROM episodes WHERE kind='INTERVENTION_MEMORY.resumed'").get());
}));

test("concurrent clients are serialized under one surface lease", async () => fixture(async (c, d) => {
  const f = (await c.observe()).frame;
  const results = await Promise.all([c.execute("one", click(f.frameId)), c.execute("two", click(f.frameId))]);
  assert.equal(results[0].ok, true); assert.equal(results[1].receipts[0].outcome, "STALE_TARGET"); assert.equal(d.dispatches, 1);
}));
