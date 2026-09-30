import test from "node:test";
import assert from "node:assert/strict";
import { PermissionResponseDeliveryQueue } from "../../src/remote/permissionDelivery.ts";

test("permission response is retained after a successful socket send for reconnect replay", () => {
  const queue = new PermissionResponseDeliveryQueue<{ requestId: string }>();
  const sent: string[] = [];

  queue.enqueue("req-1", { requestId: "req-1" });
  const first = queue.flush(payload => {
    sent.push(payload.requestId);
    return true;
  });
  const second = queue.flush(payload => {
    sent.push(payload.requestId);
    return true;
  });

  assert.deepEqual(first.delivered, ["req-1"]);
  assert.deepEqual(second.delivered, ["req-1"]);
  assert.deepEqual(sent, ["req-1", "req-1"]);
  assert.equal(queue.has("req-1"), true);
});

test("permission response survives an unavailable transport and delivers later", () => {
  const queue = new PermissionResponseDeliveryQueue<{ requestId: string }>();
  queue.enqueue("req-2", { requestId: "req-2" });

  const failed = queue.flush(() => false);
  assert.deepEqual(failed.delivered, []);
  assert.deepEqual(failed.retained, ["req-2"]);

  const delivered = queue.flush(() => true);
  assert.deepEqual(delivered.delivered, ["req-2"]);
  assert.equal(queue.has("req-2"), true);
});

test("server cancellation is the terminal signal that removes a retained decision", () => {
  const queue = new PermissionResponseDeliveryQueue<{ requestId: string }>();
  queue.enqueue("req-3", { requestId: "req-3" });
  queue.flush(() => true);

  queue.cancel("req-3");

  assert.equal(queue.has("req-3"), false);
  assert.equal(queue.size, 0);
  assert.deepEqual(queue.flush(() => true).delivered, []);
});
