import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, task, signal, scripted, reply } from "./swarm-fixtures.ts";
import { runSwarm, integrateSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { HttpBrain } from "../../src/harness/foundry/swarm/model.ts";
import { SessionJournal, type ThreadState } from "../../src/harness/foundry/swarm/session.ts";
import { decodeResponse, decodeTurn } from "../../src/harness/foundry/swarm/response.ts";
import { FatalAttemptError } from "../../src/harness/foundry/errors.ts";
import { bytes } from "../../src/harness/foundry/swarm/context.ts";
import type { Protocol } from "../../src/harness/foundry/swarm/config.ts";
import { createServer } from "node:http";
import { once } from "node:events";

function malformed(): Response {
  return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: "",
    tool_calls: [
      { id: "valid", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/a.txt", content: "unadmitted\n" }) } },
      { id: "broken", type: "function", function: { name: "write_file", arguments: '{"path":"src/a.txt","content":' } },
    ] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
}

test("a malformed tool group is rejected without effects and repaired inside the same attempt", async () => fixture(async s => {
  const mock = scripted([
    () => malformed(),
    body => {
      const notice = JSON.parse(body.messages.at(-1).content);
      assert.equal(notice.modelResponseRejected.code, "TOOL_ARGUMENTS_JSON");
      assert.equal(notice.modelResponseRejected.effectsExecuted, false);
      assert.equal(body.messages.filter((m: any) => m.tool_calls || m.role === "tool").length, 0);
      assert.ok(!JSON.stringify(body.messages).includes("unadmitted"));
      assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind='tool.intent'").get()!.n, 0);
      return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    () => reply("implemented"),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS");
  assert.equal(result.attempts, 1);
  assert.equal(mock.bodies.length, 3);
  assert.equal(result.providerUsage.knownTokens, 45);
  assert.equal(result.providerUsage.unknownRequests, 0);
  assert.match((await integrateSwarm(s, result.id, signal())).commit, /^[a-f0-9]{40,64}$/);
}, s => { s.recipe.attempts = 1; }));

const write = () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
const state = (s: Store): ThreadState => s.readArtifact(String(s.db.prepare("SELECT state FROM agent_threads").get()!.state)) as unknown as ThreadState;
const count = (s: Store, kind: string) => Number(s.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE kind=?").get(kind)!.n);
const start = (s: Store) => {
  const q = new Scheduler(s), run = q.start([task()]), lease = q.claim(run, "worker")!;
  return { q, run, lease, capsule: q.capsule(lease) };
};
function raw(protocol: Protocol, content = "", calls: any[] = []): any {
  return protocol === "anthropic" ? { content: [...(content ? [{ type: "text", text: content }] : []),
    ...calls.map(c => ({ type: "tool_use", id: c.id, name: c.name, input: c.arguments }))],
    stop_reason: calls.length ? "tool_use" : "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }
    : { choices: [{ finish_reason: calls.length ? "tool_calls" : "stop", message: { content,
      tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } };
}

for (const protocol of ["chat-completions", "anthropic"] as const) {
  test(`${protocol} repairs a rejected response over actual HTTP`, async () => {
    let requests = 0;
    const server = createServer(async (req, res) => {
      let input = ""; for await (const part of req) input += part;
      const body = JSON.parse(input); requests++;
      const response = requests === 1 ? raw(protocol, " \n ") : requests === 2
        ? raw(protocol, "", [{ id: "write", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }])
        : raw(protocol, "implemented");
      if (requests === 2 && !JSON.stringify(body.messages).includes("EMPTY_RESPONSE")) {
        res.writeHead(400); res.end(); return;
      }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(response));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    try {
      await fixture(async s => {
        const result: any = await runSwarm(s, [task()], signal());
        assert.equal(result.status, "PASS"); assert.equal(requests, 3);
        assert.equal(result.providerUsage.knownTokens, 45);
        await integrateSwarm(s, result.id, signal());
      }, s => { s.agents.coder.protocol = protocol; s.agents.coder.url = `http://127.0.0.1:${address.port}/v1`; s.recipe.attempts = 1; });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}

test("deferred hedge publication cannot replace a winner or publish under a stale fence", async () => fixture(async (s, cfg) => {
  const { q, run, lease, capsule } = start(s), j = new SessionJournal(s);
  const rejected = await j.reserve(capsule, "provider", { task: "first" }, cfg.spec.budget, signal());
  const valid = await j.reserve(capsule, "provider", { task: "first" }, cfg.spec.budget, signal());
  j.complete(rejected, 15, await malformed().json());
  j.complete(valid, 15, raw("chat-completions", "valid"), 0, true);
  assert.equal(j.publishReply(rejected, 0), false);
  assert.deepEqual(j.cached(capsule, 0, { task: "first" }), raw("chat-completions", "valid"));
  const late = await j.reserve(capsule, "provider", { task: "second" }, cfg.spec.budget, signal());
  j.complete(late, 15, await malformed().json());
  assert.ok(q.fail(lease, "replace"));
  const replacement = q.capsule(q.claim(run, "replacement")!);
  assert.equal(j.publishReply(late, 1), false); assert.equal(j.hasReply(replacement, 1), false);
  assert.equal(j.usage(run).knownTokens, 45);
}));

test("missing usage on a rejected reply stays unknown and raw JSON transport errors are not repaired", async () => fixture(async (s, cfg) => {
  const { capsule } = start(s), j = new SessionJournal(s);
  const response = await malformed().json(); delete response.usage;
  const history = [{ role: "user" as const, content: "task" }];
  const invalid = new HttpBrain(j, (async () => Response.json(response)) as typeof fetch);
  assert.equal((await invalid.next(capsule, cfg.spec.agents.coder, history, cfg.spec.budget, 32768, signal())).turn.rejection?.code, "TOOL_ARGUMENTS_JSON");
  assert.equal(j.usage(capsule.runId).tokens, null); assert.equal(j.usage(capsule.runId).unknownRequests, 1);
  const brokenTransport = new HttpBrain(j, (async () => new Response('{"broken":')) as typeof fetch);
  await assert.rejects(brokenTransport.next(capsule, cfg.spec.agents.coder, history, cfg.spec.budget, 32768, signal(), 1), SyntaxError);
  assert.equal(j.hasReply(capsule, 1), false); assert.equal(j.usage(capsule.runId).unknownRequests, 2);
}));

for (const protocol of ["chat-completions", "anthropic"] as const) {
  test(`${protocol} rejects a whole duplicate-ID group, owns its raw receipt, then preserves native tool pairing`, async () => fixture(async (s, cfg) => {
    let calls = 0;
    const fetcher = (async (_url, init) => {
      const body = JSON.parse(init!.body as string); calls++;
      if (calls === 1) return Response.json(raw(protocol, "", [
        { id: "same", name: "write_file", arguments: { path: "src/a.txt", content: "bad\n" } },
        { id: "same", name: "delete_file", arguments: { path: "src/a.txt" } },
      ]));
      if (calls === 2) {
        const last = body.messages.at(-1).content;
        const notice = JSON.parse(typeof last === "string" ? last : last[0].text).modelResponseRejected;
        assert.equal(notice.code, "TOOL_CALL_IDS");
        assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_receipts WHERE task='a' AND hash=?")
          .get(notice.receipt)!.n, 1);
        assert.ok(JSON.stringify(s.readArtifact(notice.receipt)).includes("same"));
        assert.equal(count(s, "tool.intent") + count(s, "tool.batch.intent"), 0);
        return Response.json(raw(protocol, "", [{ id: "fixed", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]));
      }
      if (protocol === "anthropic") assert.equal(body.messages.at(-1).content[0].tool_use_id, "fixed");
      else assert.equal(body.messages.at(-1).tool_call_id, "fixed");
      return Response.json(raw(protocol, "implemented"));
    }) as typeof fetch;
    const result: any = await runSwarm(s, [task()], signal(), undefined, fetcher);
    assert.equal(result.status, "PASS"); assert.equal(calls, 3);
    assert.equal(result.providerUsage.knownTokens, 45);
    assert.equal(state(s).responseRejections, undefined);
    await integrateSwarm(s, result.id, signal());
  }, s => { s.agents.coder.protocol = protocol; s.recipe.attempts = 1; }));

  test(`${protocol} rejects blank output before finalization and can repair it`, async () => fixture(async s => {
    let n = 0;
    const fetcher = (async () => {
      n++;
      return Response.json(n === 1 ? raw(protocol, " \n ") : n === 2
        ? raw(protocol, "", [{ id: "fixed", name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }])
        : raw(protocol, "implemented"));
    }) as typeof fetch;
    const result: any = await runSwarm(s, [task()], signal(), undefined, fetcher);
    assert.equal(result.status, "PASS"); assert.equal(n, 3);
    assert.equal(count(s, "model.rejected"), 1); assert.equal(count(s, "worker.output"), 1);
  }, s => { s.agents.coder.protocol = protocol; s.recipe.attempts = 1; }));

  test(`${protocol} retains strict grammar validation without admitting malformed shapes`, () => {
    const valid = { id: "call", name: "write_file", arguments: { path: "src/a.txt", content: "42" } };
    for (const [calls, code] of [
      [[{ ...valid, arguments: [] }], "TOOL_ARGUMENTS_OBJECT"],
      [[{ ...valid, arguments: null }], "TOOL_ARGUMENTS_OBJECT"],
      [[{ ...valid, id: "" }], "TOOL_CALL_IDS"],
      [[{ ...valid, name: "" }], "TOOL_ARGUMENTS_OBJECT"],
      [Array.from({ length: 33 }, (_, n) => ({ ...valid, id: `id-${n}` })), "TOOL_CALL_LIMIT"],
    ] as const) {
      const response = raw(protocol, "", [...calls]);
      assert.throws(() => decodeTurn(protocol, response));
      const turn = decodeResponse(protocol, response);
      assert.equal(turn.rejection?.code, code); assert.equal(turn.tokens, 15);
      assert.equal(turn.message.calls, undefined);
    }
  });
}

test("three consecutive invalid replies stop once with known spend and no effects or output", async () => fixture(async s => {
  let requests = 0;
  const result: any = await runSwarm(s, [task()], signal(), undefined, (async () => { requests++; return malformed(); }) as typeof fetch);
  assert.equal(result.status, "FAIL"); assert.equal(result.attempts, 1); assert.equal(requests, 3);
  assert.equal(result.providerUsage.knownTokens, 45); assert.equal(result.providerUsage.unknownRequests, 0);
  assert.equal(state(s).responseRejections, 3); assert.equal(state(s).turns, 3);
  assert.equal(state(s).toolCalls, 0); assert.equal(state(s).output, null);
  assert.equal(count(s, "model.rejected"), 3); assert.equal(count(s, "worker.output"), 0);
  assert.match(String(s.db.prepare("SELECT error FROM tasks").get()!.error), /MODEL_RESPONSE_REPAIR_EXHAUSTED/);
}));

for (const budget of ["maxTurns", "maxRequests"] as const) {
  test(`${budget} applies to corrective requests without increasing tool budgets`, async () => fixture(async s => {
    let requests = 0;
    const result: any = await runSwarm(s, [task()], signal(), undefined, (async () => { requests++; return malformed(); }) as typeof fetch);
    assert.equal(result.status, "FAIL"); assert.equal(requests, 1); assert.equal(result.attempts, 1);
    assert.equal(state(s).turns, 1); assert.equal(state(s).toolCalls, 0);
  }, s => { s.budget[budget] = 1; }));
}

test("a valid turn clears the consecutive streak, while total turns still include rejections", async () => fixture(async s => {
  const mock = scripted([
    () => malformed(), () => malformed(),
    () => reply("", [{ name: "read_file", arguments: { path: "src/a.txt" } }]),
    () => malformed(), () => malformed(), () => write(), () => reply("implemented"),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(mock.bodies.length, 7);
  assert.equal(state(s).turns, 7); assert.equal(count(s, "model.rejected"), 4);
}));

for (const afterCommit of [false, true]) {
  test(`rejected reply survives a crash ${afterCommit ? "after" : "before"} its thread checkpoint and store reopen`, async () => fixture(async (s, cfg) => {
    const { q, run, lease, capsule } = start(s);
    const mock = scripted([() => malformed(), body => {
      assert.match(JSON.stringify(body.messages), /modelResponseRejected/); return write();
    }, () => reply("implemented")]);
    const driver = new SwarmDriver(s, cfg, mock.fetcher);
    const checkpoint = driver.journal.checkpoint.bind(driver.journal);
    driver.journal.checkpoint = (t, kind, payload) => {
      if (kind === "model.rejected") {
        if (afterCommit) checkpoint(t, kind, payload);
        throw new Error("injected checkpoint crash");
      }
      checkpoint(t, kind, payload);
    };
    await assert.rejects(driver.execute(capsule, signal()), /injected checkpoint crash/);
    assert.equal(mock.bodies.length, 1);
    assert.ok(q.fail(lease, "injected host crash"));
    const reopened = await Store.open(s.root);
    try {
      const result: any = await runSwarm(reopened, [], signal(), run, mock.fetcher);
      assert.equal(result.status, "PASS"); assert.equal(mock.bodies.length, 3);
      assert.equal(result.providerUsage.requests, 3); assert.equal(result.providerUsage.knownTokens, 45);
      assert.equal(count(reopened, "model.rejected"), 1);
      await integrateSwarm(reopened, result.id, signal());
    } finally { reopened.close(); }
  }));
}

test("rejection streak remains bounded across replacement workers", async () => fixture(async (s, cfg) => {
  const { q, run, lease, capsule } = start(s); let requests = 0;
  const fetcher = (async () => { requests++; return malformed(); }) as typeof fetch;
  const driver = new SwarmDriver(s, cfg, fetcher), checkpoint = driver.journal.checkpoint.bind(driver.journal);
  driver.journal.checkpoint = (t, kind, payload) => {
    checkpoint(t, kind, payload);
    if (kind === "model.rejected" && t.state.responseRejections === 2) throw new Error("replace worker");
  };
  await assert.rejects(driver.execute(capsule, signal()), /replace worker/);
  assert.ok(q.fail(lease, "replace worker"));
  const result: any = await runSwarm(s, [], signal(), run, fetcher);
  assert.equal(result.status, "FAIL"); assert.equal(requests, 3);
  assert.equal(state(s).responseRejections, 3);
}));

test("a corrected final summary still fails independent checks when source is unchanged", async () => fixture(async s => {
  const mock = scripted([() => malformed(), () => reply("completed, all tests pass")]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "FAIL"); assert.equal(mock.bodies.length, 2);
  await assert.rejects(integrateSwarm(s, result.id, signal()));
}, s => { s.recipe.attempts = 1; }));

test("healthy tasks keep two requests, their wire bytes and no repair notices", async () => fixture(async s => {
  const mock = scripted([() => write(), () => reply("implemented")]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(mock.bodies.length, 2);
  assert.equal(result.providerUsage.requestBytes, mock.bodies.reduce((n, body) => n + bytes(body), 0));
  assert.equal(count(s, "model.rejected"), 0);
  assert.ok(!JSON.stringify(mock.bodies).includes("modelResponseRejected"));
}));

test("truncation including a malformed tail remains terminal and retains known usage", async () => fixture(async (s, cfg) => {
  const { capsule } = start(s), journal = new SessionJournal(s);
  const response = await malformed().json(); response.choices[0].finish_reason = "length";
  const brain = new HttpBrain(journal, (async () => Response.json(response)) as typeof fetch);
  await assert.rejects(brain.next(capsule, cfg.spec.agents.coder, [{ role: "user", content: "task" }],
    cfg.spec.budget, 32768, signal()), FatalAttemptError);
  assert.equal(journal.usage(capsule.runId).knownTokens, 15); assert.equal(count(s, "tool.intent"), 0);
}));

test("refusals, unsupported features, invalid envelopes and invalid usage do not enter response repair", () => {
  const refusal = raw("chat-completions", ""); refusal.choices[0].message.refusal = "refused";
  assert.throws(() => decodeResponse("chat-completions", refusal), FatalAttemptError);
  assert.throws(() => decodeResponse("anthropic", { content: [{ type: "thinking", thinking: "hidden" }], stop_reason: "end_turn" }), FatalAttemptError);
  for (const protocol of ["chat-completions", "anthropic"] as const) {
    assert.throws(() => decodeResponse(protocol, {}));
    const response = raw(protocol, "");
    response.usage = protocol === "anthropic" ? { input_tokens: -1, output_tokens: 1 } : { prompt_tokens: -1, completion_tokens: 1 };
    assert.throws(() => decodeResponse(protocol, response), /usage/);
    const withoutUsage = raw(protocol); delete withoutUsage.usage;
    assert.equal(decodeResponse(protocol, withoutUsage).tokens, null);
  }
});

for (const fallbackValid of [true, false]) {
  test(`hedged routes ${fallbackValid ? "prefer a valid fallback" : "select one rejection"}, retain all spend and replay without another request`, async () => fixture(async (s, cfg) => {
    const { capsule } = start(s), journal = new SessionJournal(s);
    const profile = { ...cfg.spec.agents.coder, fallbacks: [{ url: "https://fallback.example/v1", model: "different-model" }] };
    let requests = 0;
    const brain = new HttpBrain(journal, (async url => {
      requests++; return String(url) === profile.url || !fallbackValid ? malformed() : reply("valid fallback");
    }) as typeof fetch);
    const history = [{ role: "user" as const, content: "task" }];
    const first = await brain.next(capsule, profile, history, cfg.spec.budget, 32768, signal());
    assert.equal(!!first.turn.rejection, !fallbackValid);
    if (fallbackValid) assert.equal(first.turn.message.content, "valid fallback");
    assert.equal(requests, 2); assert.equal(journal.usage(capsule.runId).knownTokens, 30);
    const replayed = await brain.next(capsule, profile, history, cfg.spec.budget, 32768, signal());
    assert.deepEqual(replayed, first); assert.equal(requests, 2);
  }));
}
