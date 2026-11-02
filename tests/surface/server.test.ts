import { test } from "node:test";
import assert from "node:assert/strict";
import { surfaceServer } from "../../adapters/surface/server.ts";
import { surfaceOperation } from "../../adapters/surface/operations.ts";
import { fixture } from "./fixtures.ts";
import { surfacePolicy } from "../../adapters/surface/capabilities.ts";
import { validateOperations, validateValue } from "../../src/harness/foundry/operations/contracts.ts";

test("generated surface capabilities validate under the existing operations contract", () => {
  const policy = surfacePolicy("operator-session"); validateOperations(policy);
  validateValue({ sessionId: "operator-session" }, policy.capabilities.surface_observe.input);
  assert.throws(() => validateValue({ sessionId: "other-session" }, policy.capabilities.surface_observe.input), /enum/);
  assert.ok(!policy.capabilities.surface_act.adapter.envAllow?.includes("SURFACE_OPERATOR_TOKEN"));
  assert.deepEqual(policy.capabilities.surface_act.identity, ["/sessionId", "/transitionId"]);
});

test("resident host authenticates, separates operator handoff and bridges existing operations", async () => fixture(async (c, d) => {
  const token = "worker-".padEnd(32, "a"), operator = "operator-".padEnd(32, "b");
  const server = surfaceServer(c, token, operator);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/`;
  try {
    const denied = await fetch(new URL("observe", endpoint), { method: "POST", body: "{}" }); assert.equal(denied.status, 401);
    const read = await surfaceOperation({ schema: 1, operation: "read", key: "read", inputHash: "h", input: {} }, endpoint, token);
    const frame = (read.result as any).surface.frame;
    const request = { schema: 1 as const, operation: "execute" as const, key: "action", inputHash: "h", input: {
      expectedFrameId: frame.frameId, steps: [{ action: { kind: "activate", markId: 2 }, expect: { targetFocused: 2 }, settleTimeoutMs: 100 }] } };
    const first = await surfaceOperation(request, endpoint, token);
    assert.equal(first.status, "CONFIRMED"); assert.equal((first.result as any).surface.ok, true);
    const inspected = await surfaceOperation({ ...request, operation: "inspect" }, endpoint, token);
    assert.deepEqual(inspected, first); assert.equal(d.dispatches, 1);
    d.state.blocker = "CAPTCHA";
    const blocked = await surfaceOperation({ schema: 1, operation: "read", key: "read2", inputHash: "h", input: {} }, endpoint, token);
    const surface = (blocked.result as any).surface;
    const noResume = await fetch(new URL("resume", endpoint), { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    assert.equal(noResume.status, 401);
    delete d.state.blocker;
    const ready = await surfaceOperation({ schema: 1, operation: "read", key: "read3", inputHash: "h", input: {} }, endpoint, token);
    const resumed = await fetch(new URL("resume", endpoint), { method: "POST", headers: { authorization: `Bearer ${operator}` },
      body: JSON.stringify({ interruptId: surface.interrupt.id, expectedFrameId: (ready.result as any).surface.frame.frameId }) });
    assert.equal(resumed.status, 200); assert.equal((await resumed.json()).liveness.paused, false);
    await assert.rejects(() => surfaceOperation(request, "https://external.example/", token), /loopback/);
    await assert.rejects(() => surfaceOperation(request, endpoint, "short"), /loopback/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test("interrupted writes stay pending and inspection after handoff never executes the suffix", async () => fixture(async (c, d) => {
  const token = "w".repeat(32), operator = "o".repeat(32), server = surfaceServer(c, token, operator);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/`;
  try {
    const initial = await c.observe();
    d.effect = () => { d.state.blocker = "HUMAN_CONFIRMATION"; };
    const request = { schema: 1 as const, operation: "execute" as const, key: "gated", inputHash: "hash", input: {
      expectedFrameId: initial.frame.frameId, steps: [{ action: { kind: "activate", markId: 2 }, expect: { targetFocused: 2 }, settleTimeoutMs: 100 }] } };
    const blocked = await surfaceOperation(request, endpoint, token); assert.equal(blocked.status, "PENDING");
    const observed = await c.observe(); delete d.state.blocker;
    await c.resume(observed.interrupt!.id, observed.frame.frameId);
    const resolved = await surfaceOperation({ ...request, operation: "inspect" }, endpoint, token);
    assert.equal(resolved.status, "CONFIRMED"); assert.equal((resolved.result as any).surface.ok, false); assert.equal(d.dispatches, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));
