import { test } from "node:test";
import assert from "node:assert/strict";
import { bytes, compactHistory, retireToolPreviews, type Message } from "../../src/harness/foundry/swarm/context.ts";
import { HttpBrain, requestBody } from "../../src/harness/foundry/swarm/model.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { canonical } from "../../src/harness/foundry/kernel.ts";
import { fixture, task, signal, reply } from "./swarm-fixtures.ts";

test("escape-heavy tool arguments retire as complete exchanges under the actual provider envelope", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]);
  const c = q.capsule(q.claim(run, "context-test")!);
  const journal = new SessionJournal(s);
  const profile = cfg.spec.agents.coder, budget = cfg.spec.budget;
  const history: Message[] = [
    { role: "user", content: "immutable objective and acceptance" },
    { role: "assistant", content: "", calls: [{ id: "large", name: "write_file",
      arguments: { path: "src/a.txt", content: '"'.repeat(10000) } }] },
    { role: "tool", callId: "large", content: '{"written":true}' },
    { role: "assistant", content: "Inspect the next experiment result." },
  ];
  const before = structuredClone(history);
  // This envelope fits the internal Message representation, but tool arguments
  // are JSON strings on chat-completions wire and therefore escaped again.
  const limit = bytes(requestBody(profile, [], budget)) + bytes(history) + 512;
  assert.ok(bytes(requestBody(profile, history, budget)) > limit);
  let requests = 0;
  const brain = new HttpBrain(journal, (async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init!.body));
    assert.ok(Buffer.byteLength(JSON.stringify(body), "utf8") <= limit);
    assert.equal(body.messages[1].content, history[0].content);
    assert.ok(body.messages.some((m: any) => String(m.content).includes("retired-context-v2")));
    assert.ok(!body.messages.some((m: any) => m.tool_calls?.some((call: any) => call.id === "large")));
    return reply("Continue with the preserved experiment frontier.");
  }) as typeof fetch);
  const result = await brain.next(c, profile, history, budget, limit, signal());
  assert.equal(requests, 1);
  assert.equal(result.history.at(-1)?.content, history.at(-1)?.content);
  const replay = new HttpBrain(new SessionJournal(s), brain.fetcher)
    .replay(c, profile, history, budget, limit, 0);
  assert.deepEqual(replay, result);
  assert.equal(requests, 1, "durable replay consumes no new model request");
  assert.deepEqual(history, before, "request projection must not rewrite durable history");
}));

test("a newest complete exchange that cannot fit fails before any provider request", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]);
  const c = q.capsule(q.claim(run, "context-overflow-test")!);
  const profile = cfg.spec.agents.coder, budget = cfg.spec.budget;
  const history: Message[] = [
    { role: "user", content: "pinned acceptance" },
    { role: "assistant", content: "", calls: [{ id: "latest", name: "write_file",
      arguments: { path: "src/a.txt", content: '"'.repeat(10000) } }] },
    { role: "tool", callId: "latest", content: '{"written":true}' },
  ];
  const before = structuredClone(history);
  const limit = bytes(requestBody(profile, [], budget)) + bytes(history) + 512;
  let requests = 0;
  const brain = new HttpBrain(new SessionJournal(s), (async () => { requests++; return reply(); }) as typeof fetch);
  await assert.rejects(brain.next(c, profile, history, budget, limit, signal()), /CONTEXT_OVERFLOW/);
  assert.equal(requests, 0);
  assert.deepEqual(history, before);
}));

test("normal fitting requests keep their exact history and provider prefix", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]);
  const c = q.capsule(q.claim(run, "context-prefix-test")!);
  const profile = cfg.spec.agents.coder, budget = cfg.spec.budget;
  const history: Message[] = [
    { role: "user", content: "immutable task" },
    { role: "assistant", content: "one observation", calls: [{ id: "read", name: "read_file", arguments: { path: "src/a.txt" } }] },
    { role: "tool", callId: "read", content: '{"content":"42"}' },
  ];
  const expected = requestBody(profile, history, budget);
  const brain = new HttpBrain(new SessionJournal(s), (async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init!.body)), expected);
    return reply();
  }) as typeof fetch);
  const result = await brain.next(c, profile, history, budget, 65536, signal());
  assert.deepEqual(result.history, history);
}));

test("preview fallback keeps concise observations and never grows a tool result", () => {
  const receipt = "a".repeat(64);
  const small: Message = { role: "tool", callId: "small", receipt, content: '{"error":"file missing"}' };
  const boundary: Message = { role: "tool", callId: "edge", receipt, content: "x".repeat(140) };
  const large: Message = { role: "tool", callId: "large", receipt, content: "raw log ".repeat(1000) };
  const history: Message[] = [{ role: "user", content: "task" }, small, large, boundary];
  const projected = retireToolPreviews(history);
  assert.equal(projected[1], small);
  assert.equal(projected[3], boundary, "a raw-shorter pointer can be larger after JSON escaping");
  for (let i = 0; i < history.length; i++) assert.ok(bytes(projected[i]) <= bytes(history[i]));
  assert.equal(JSON.parse(projected[2].content).receipt, receipt);
  assert.equal(JSON.parse(projected[2].content).retired, true);
  assert.ok(bytes(projected) < bytes(history));
  assert.deepEqual(retireToolPreviews(projected), projected);
});

test("wire-aware retirement keeps complete tool groups for both provider protocols", async () => fixture(async (_s, cfg) => {
  for (const protocol of ["chat-completions", "anthropic"] as const) {
    const profile = { ...cfg.spec.agents.coder, protocol };
    const history: Message[] = [{ role: "user", content: "immutable task" }];
    for (let i = 0; i < 40; i++) {
      history.push({ role: "assistant", content: "hypothesis " + i,
        calls: [{ id: "c" + i, name: "read_file", arguments: { path: "src/a.txt" } }] });
      history.push({ role: "tool", callId: "c" + i, content: "observation " + i + "🐈".repeat(10) });
    }
    const measure = (messages: Message[]) => bytes(requestBody(profile, messages, cfg.spec.budget));
    const limit = bytes(requestBody(profile, [], cfg.spec.budget)) + 2400;
    const projected = compactHistory(history, limit, null, null, measure);
    assert.ok(measure(projected) <= limit);
    const calls = projected.flatMap(m => m.calls?.map(call => call.id) ?? []);
    assert.ok(calls.length > 0);
    assert.deepEqual(projected.filter(m => m.role === "tool").map(m => m.callId), calls);
    assert.equal(calls.at(-1), "c39");
    assert.deepEqual(history[0], projected[0]);
  }
}));

test("a successful pre-upgrade conservative request replays its pending response unchanged", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]);
  const c = q.capsule(q.claim(run, "legacy-context-replay")!);
  const journal = new SessionJournal(s);
  const profile = cfg.spec.agents.coder, budget = cfg.spec.budget;
  const history: Message[] = [{ role: "user", content: "immutable objective" }];
  for (let i = 0; i < 12; i++) history.push({ role: "assistant", content: "finding " + i + ": " + "x".repeat(200) });
  const overhead = bytes(requestBody(profile, [], budget));
  const limit = overhead + 1200 + 512;
  // This is the pre-upgrade projection algorithm, including its 512-byte
  // protocol reserve. Persist its successful response before upgrading.
  const legacyHistory = compactHistory(history, limit - overhead - 512);
  const legacyBody = requestBody(profile, legacyHistory, budget);
  assert.ok(bytes(legacyBody) <= limit);
  assert.ok(bytes(requestBody(profile, history, budget)) > limit);
  const exact = compactHistory(history, limit, null, null,
    messages => bytes(requestBody(profile, messages, budget)));
  assert.notDeepEqual(exact, legacyHistory, "fixture must exercise a changed suffix choice");
  const id = await journal.reserve(c, "legacy-context-provider", legacyBody, budget, signal());
  journal.complete(id, 15, await reply("Pending old response.").json(), 0);
  let requests = 0;
  const brain = new HttpBrain(new SessionJournal(s), (async () => {
    requests++; throw new Error("A pending response must replay without a provider call");
  }) as typeof fetch);
  const replay = brain.replay(c, profile, history, budget, limit, 0);
  assert.ok(replay);
  assert.deepEqual(replay.history, legacyHistory);
  assert.equal(replay.turn.message.content, "Pending old response.");
  assert.deepEqual(await brain.next(c, profile, history, budget, limit, signal()), replay);
  assert.equal(requests, 0);
  assert.equal(journal.usage(run).requests, 1);
}));

test("pending legacy all-pointer replies replay by exact hash and changed inputs still reject", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([task()]);
  const c = q.capsule(q.claim(run, "legacy-preview-replay")!);
  const journal = new SessionJournal(s);
  const profile = cfg.spec.agents.coder, budget = cfg.spec.budget;
  const calls = Array.from({ length: 16 }, (_, i) => ({
    id: "read-" + i, name: "read_file", arguments: { path: "src/a.txt" },
  }));
  const history: Message[] = [
    { role: "user", content: "immutable acceptance and objective" },
    { role: "assistant", content: "", calls },
    ...calls.map((call, i): Message => {
      const content = i === 0 ? "short diagnostic" : "full observation ".repeat(200);
      return { role: "tool", callId: call.id, content,
        receipt: journal.receipt(c, { content }) };
    }),
  ];
  const before = structuredClone(history);
  const overhead = bytes(requestBody(profile, [], budget));
  const remaining = 8000, limit = overhead + remaining + 512;
  assert.throws(() => compactHistory(history, remaining), /CONTEXT_OVERFLOW/);
  // Reproduce the previous release's forced retirement policy exactly, even
  // for small diagnostics, then persist an interrupted-but-completed RPC.
  const forced = history.map(m => m.role === "tool" && m.receipt ? {
    ...m, content: canonical({ receipt: m.receipt, retired: true, instruction: "Use recall for full evidence." }),
  } : m);
  const legacyHistory = compactHistory(forced, remaining);
  const legacyBody = requestBody(profile, legacyHistory, budget);
  assert.ok(bytes(legacyBody) <= limit);
  assert.notDeepEqual(retireToolPreviews(history), forced);
  const id = await journal.reserve(c, "legacy-preview-provider", legacyBody, budget, signal());
  journal.complete(id, 15, await reply("Completed before upgrade.").json(), 0);
  let requests = 0;
  const brain = new HttpBrain(new SessionJournal(s), (async () => {
    requests++; throw new Error("Cached replies must not submit a replacement request");
  }) as typeof fetch);
  const replay = brain.replay(c, profile, history, budget, limit, 0);
  assert.ok(replay);
  assert.deepEqual(replay.history, legacyHistory);
  assert.equal(replay.turn.message.content, "Completed before upgrade.");
  assert.deepEqual(await brain.next(c, profile, history, budget, limit, signal()), replay);
  const changed = structuredClone(history);
  changed[0].content += " CHANGED OBJECTIVE";
  assert.throws(() => brain.replay(c, profile, changed, budget, limit, 0), /model replay input drift/);
  assert.throws(() => brain.replay(c, { ...profile, system: profile.system + " CHANGED SYSTEM" },
    history, budget, limit, 0), /model replay input drift/);
  assert.throws(() => brain.replay(c, profile, history, budget, 65536, 0), /model replay input drift/);
  assert.equal(requests, 0);
  assert.equal(journal.usage(run).requests, 1);
  assert.deepEqual(history, before);
}));
