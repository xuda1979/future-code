import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  isRemoteResponseProgress,
  RemoteResponseWatchdog,
} from "../../src/remote/responseLiveness.ts";

test("transport echo/init do not count as foreground response progress", () => {
  assert.equal(isRemoteResponseProgress({
    type: "user",
    uuid: "echo",
    message: { role: "user", content: "continue" },
  } as any), false);
  assert.equal(isRemoteResponseProgress({
    type: "system",
    subtype: "init",
  } as any), false);
  assert.equal(isRemoteResponseProgress({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "working" }] },
  } as any), true);
  assert.equal(isRemoteResponseProgress({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "x", content: "done" }],
    },
  } as any), true);
});

test("silent foreground turn reconnects once then exhausts instead of hanging", async () => {
  const events: string[] = [];
  let exhausted!: () => void;
  const exhaustedPromise = new Promise<void>(resolve => { exhausted = resolve; });
  const watchdog = new RemoteResponseWatchdog(
    {
      isCompacting: () => false,
      onReconnect: attempt => events.push(`reconnect:${attempt}`),
      onExhausted: () => { events.push("exhausted"); exhausted(); },
    },
    {
      responseTimeoutMs: 10,
      reconnectGraceMs: 10,
      compactionTimeoutMs: 20,
      maxReconnects: 1,
    },
  );

  watchdog.start();
  await Promise.race([
    exhaustedPromise,
    delay(500).then(() => { throw new Error("watchdog did not exhaust"); }),
  ]);

  assert.deepEqual(events, ["reconnect:1", "exhausted"]);
  assert.equal(watchdog.isWaiting, false);
});

test("semantic progress after reconnect resets the liveness window", async () => {
  const events: string[] = [];
  let reconnected!: () => void;
  const reconnectPromise = new Promise<void>(resolve => { reconnected = resolve; });
  const watchdog = new RemoteResponseWatchdog(
    {
      isCompacting: () => false,
      onReconnect: attempt => { events.push(`reconnect:${attempt}`); reconnected(); },
      onExhausted: () => events.push("exhausted"),
    },
    {
      responseTimeoutMs: 20,
      reconnectGraceMs: 100,
      compactionTimeoutMs: 100,
      maxReconnects: 1,
    },
  );

  watchdog.start();
  await Promise.race([
    reconnectPromise,
    delay(500).then(() => { throw new Error("watchdog did not reconnect"); }),
  ]);

  watchdog.progress();
  await delay(5);
  watchdog.complete();

  assert.deepEqual(events, ["reconnect:1"]);
  assert.equal(watchdog.isWaiting, false);
});

test("permission wait pauses and resumes foreground liveness", async () => {
  const events: string[] = [];
  let reconnected!: () => void;
  const reconnectPromise = new Promise<void>(resolve => { reconnected = resolve; });
  const watchdog = new RemoteResponseWatchdog(
    {
      isCompacting: () => false,
      onReconnect: attempt => { events.push(`reconnect:${attempt}`); reconnected(); },
      onExhausted: () => events.push("exhausted"),
    },
    {
      responseTimeoutMs: 20,
      reconnectGraceMs: 100,
      compactionTimeoutMs: 100,
      maxReconnects: 1,
    },
  );

  watchdog.start();
  watchdog.pause();
  await delay(40);
  assert.deepEqual(events, []);

  watchdog.resume();
  await Promise.race([
    reconnectPromise,
    delay(500).then(() => { throw new Error("watchdog did not resume"); }),
  ]);
  assert.deepEqual(events, ["reconnect:1"]);
  watchdog.complete();
});
