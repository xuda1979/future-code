import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  isRemoteResponseProgress,
  RemoteResponseWatchdog,
} from "../../src/remote/responseLiveness.ts";

test("explicit provider retry waits survive long outages, and losing the notices still reconnects/exhausts", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: string[] = [];
  const watchdog = new RemoteResponseWatchdog({ isCompacting: () => false,
    onReconnect: attempt => events.push(`reconnect:${attempt}`), onExhausted: () => events.push("exhausted") },
  { responseTimeoutMs: 30, reconnectGraceMs: 30, maxReconnects: 1 });
  watchdog.start();
  const notice = { type: "system", subtype: "api_retry", attempt: 4, retry_delay_ms: 65000.25 } as any;
  assert.equal(isRemoteResponseProgress(notice), false);
  for (let i = 0; i < 8; i++) { t.mock.timers.tick(20); watchdog.retryWait(notice); }
  assert.deepEqual(events, []); assert.equal(watchdog.isWaiting, true);
  t.mock.timers.tick(30); assert.deepEqual(events, ["reconnect:1"]);
  // A known wait may keep the turn alive but must not replenish reconnects.
  watchdog.retryWait(notice);
  t.mock.timers.tick(30); assert.deepEqual(events, ["reconnect:1", "exhausted"]);
  assert.equal(watchdog.isWaiting, false);
});

test("status chatter and malformed retry-looking notices cannot extend the remote deadline", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: string[] = [];
  const watchdog = new RemoteResponseWatchdog({ isCompacting: () => false,
    onReconnect: () => events.push("reconnect"), onExhausted: () => events.push("exhausted") },
  { responseTimeoutMs: 30, reconnectGraceMs: 30, maxReconnects: 1 });
  watchdog.start();
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(10);
    for (const notice of [
      { type: "system", subtype: "status", attempt: 1, retry_delay_ms: 60000 },
      { type: "system", subtype: "api_retry", attempt: 0, retry_delay_ms: 60000 },
      { type: "system", subtype: "api_retry", attempt: 1, retry_delay_ms: Infinity },
    ]) watchdog.retryWait(notice as any);
  }
  assert.deepEqual(events, ["reconnect", "exhausted"]);
});

test("transport/status/background chatter do not count as foreground response progress", () => {
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
    type: "system",
    subtype: "status",
    status: "compacting",
  } as any), false);
  assert.equal(isRemoteResponseProgress({
    type: "system",
    subtype: "task_progress",
    task_id: "background-1",
  } as any), false);
  assert.equal(isRemoteResponseProgress({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "working" }] },
  } as any), true);
  assert.equal(isRemoteResponseProgress({
    type: "stream_event",
    event: { type: "message_start", message: {} },
  } as any), false);
  assert.equal(isRemoteResponseProgress({
    type: "stream_event",
    event: { type: "message_delta", usage: { output_tokens: 1 } },
  } as any), false);
  assert.equal(isRemoteResponseProgress({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "work" } },
  } as any), true);
  assert.equal(isRemoteResponseProgress({
    type: "stream_event",
    event: { type: "content_block_start", content_block: { type: "tool_use", id: "x", name: "Read" } },
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


test("compaction mode changes re-arm the correct silence window without heartbeat progress", async () => {
  const events: string[] = [];
  let compacting = false;
  let reconnected!: () => void;
  const reconnectPromise = new Promise<void>(resolve => { reconnected = resolve; });
  const watchdog = new RemoteResponseWatchdog(
    {
      isCompacting: () => compacting,
      onReconnect: attempt => { events.push(`reconnect:${attempt}`); reconnected(); },
      onExhausted: () => events.push("exhausted"),
    },
    {
      responseTimeoutMs: 20,
      compactionTimeoutMs: 80,
      reconnectGraceMs: 80,
      maxReconnects: 1,
    },
  );

  watchdog.start();
  compacting = true;
  watchdog.modeChanged();
  await delay(35);
  assert.deepEqual(events, [], "compaction should use the extended window");

  // Repeated status='compacting' messages deliberately do not call modeChanged
  // or progress, so they cannot keep a dead foreground turn alive forever.
  await Promise.race([
    reconnectPromise,
    delay(500).then(() => { throw new Error("compaction watchdog did not reconnect"); }),
  ]);
  assert.deepEqual(events, ["reconnect:1"]);
  watchdog.complete();
});

test("leaving compaction restores the normal foreground timeout", async () => {
  const events: string[] = [];
  let compacting = true;
  let reconnected!: () => void;
  const reconnectPromise = new Promise<void>(resolve => { reconnected = resolve; });
  const watchdog = new RemoteResponseWatchdog(
    {
      isCompacting: () => compacting,
      onReconnect: attempt => { events.push(`reconnect:${attempt}`); reconnected(); },
      onExhausted: () => events.push("exhausted"),
    },
    {
      responseTimeoutMs: 20,
      compactionTimeoutMs: 200,
      reconnectGraceMs: 100,
      maxReconnects: 1,
    },
  );

  watchdog.start();
  compacting = false;
  watchdog.modeChanged();
  await Promise.race([
    reconnectPromise,
    delay(500).then(() => { throw new Error("normal timeout was not restored"); }),
  ]);
  assert.deepEqual(events, ["reconnect:1"]);
  watchdog.complete();
});
