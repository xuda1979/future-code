import { test } from "node:test";
import assert from "node:assert/strict";
import { AdaptiveBatchSizing } from "../../src/harness/foundry/swarm/adaptiveBatchSizing.ts";

test("byte-safe batching starts at full width without warmup", () => {
  const sizing = new AdaptiveBatchSizing();
  assert.equal(sizing.width("host", "read", 32), 32);
  assert.equal(sizing.width("host", "workspace-write", 7), 7);
  assert.equal(sizing.width("host", "read", 0), 1);
});
test("RPC failures halve the window per worker and effect class", () => {
  const sizing = new AdaptiveBatchSizing();
  const feedback = sizing.observe("host", "workspace-write", { calls: 16, durationMs: 300,
    byteSafeMax: 16, timeoutMs: 1000, ok: false });
  assert.equal(feedback.target, 8);
  assert.equal(feedback.failures, 1);
  assert.equal(sizing.width("host", "read", 16), 16);
  assert.equal(sizing.width("other", "workspace-write", 16), 16);
  for (let i = 0; i < 2; i++) sizing.observe("host", "workspace-write", {
    calls: 8, durationMs: 10, byteSafeMax: 16, timeoutMs: 1000, ok: true });
  assert.equal(sizing.width("host", "workspace-write", 16), 12);
});
test("latency shrinks then recovers under the pinned cap", () => {
  const sizing = new AdaptiveBatchSizing();
  assert.equal(sizing.observe("host", "read", { calls: 16, durationMs: 900,
    byteSafeMax: 16, timeoutMs: 1000, ok: true }).target, 8);
  for (let i = 0; i < 6; i++) sizing.observe("host", "read", { calls: 1, durationMs: 10,
    byteSafeMax: 16, timeoutMs: 1000, ok: true });
  assert.equal(sizing.width("host", "read", 16), 8);
  for (let i = 0; i < 8; i++) sizing.observe("host", "read", { calls: 8, durationMs: 10,
    byteSafeMax: 16, timeoutMs: 1000, ok: true });
  assert.equal(sizing.width("host", "read", 16), 16);
  assert.equal(sizing.width("host", "read", 3), 3);
});
