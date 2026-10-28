import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { createApiRecoveryPlanner } from "../../src/harness/foundry/swarm/recovery.ts";
import { superviseSwarm } from "../../src/harness/foundry/swarm/supervisor.ts";
import { fixture, reply, signal, task } from "./swarm-fixtures.ts";

const decline = { decision: "decline", reason: "No safe replan", tasks: [], addressedFindings: [] };
function context(store: Store) {
  return { objectiveId: "recover", goal: "repair", runId: new Scheduler(store).start([task()]),
    reason: "check failed", revision: 1, tasks: [task()], failures: [] };
}
function planReply(protocol: string, input = decline) {
  return protocol === "anthropic" ? Response.json({ content: [{ type: "tool_use", id: "recovery",
    name: "propose_recovery_plan", input }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } }) :
    reply("", [{ name: "propose_recovery_plan", arguments: input }]);
}
function expireCooldowns(store: Store) {
  store.db.exec("UPDATE agent_cooldowns SET until_ms=0; UPDATE agent_provider_health SET retry_at=0;");
}

for (const protocol of ["chat-completions", "anthropic"] as const) {
  test(`${protocol} recovery uses the configured fallback and replays after restart without retrying the primary`, async () => fixture(async (s, cfg) => {
    const ctx = context(s), calls: any[] = [];
    const fetcher = (async (url, init) => {
      const body = JSON.parse(init!.body as string); calls.push({ url: String(url), body });
      return String(url).includes("fallback") ? planReply(protocol) : new Response(null, { status: 503 });
    }) as typeof fetch;
    assert.equal(await createApiRecoveryPlanner(s, cfg, fetcher)(ctx, signal()), null);
    assert.deepEqual(calls.map(c => c.body.model), ["fixture-model", "fixture-model"]);
    const requests = s.db.prepare("SELECT request,bytes FROM agent_requests ORDER BY started,id").all();
    assert.equal(requests.length, 2);
    for (const row of requests) assert.equal(row.bytes, Buffer.byteLength(JSON.stringify(s.readArtifact(row.request))));
    const reopened = await Store.open(s.root);
    try {
      assert.equal(await createApiRecoveryPlanner(reopened, cfg, (async () => {
        throw new Error("accepted fallback must replay before any network request");
      }) as typeof fetch)(ctx, signal()), null);
      assert.equal(new SessionJournal(reopened).usage(ctx.runId).requests, 2);
    } finally { reopened.close(); }
  }, spec => {
    spec.agents.coder.protocol = protocol;
    spec.agents.coder.fallbacks = [{ url: "https://fallback.example/v1", model: "fixture-model" }];
  }));
}

test("recovery skips a cooling primary and uses a same-model fallback", async () => fixture(async (s, cfg) => {
  const ctx = context(s), journal = new SessionJournal(s), calls: string[] = [];
  journal.cooldown(digest({ quotaPool: cfg.spec.agents.coder.url + "#" + cfg.spec.agents.coder.model }), 5000);
  assert.equal(await createApiRecoveryPlanner(s, cfg, (async url => {
    calls.push(String(url)); return planReply("chat-completions");
  }) as typeof fetch)(ctx, signal()), null);
  assert.deepEqual(calls, ["https://fallback.example/v1"]);
  assert.equal(journal.usage(ctx.runId).requests, 1);
}, spec => { spec.agents.coder.fallbacks = [{ url: "https://fallback.example/v1", model: "fixture-model" }]; }));

test("invalid primary receipts cannot poison a same-model fallback's replay even in a shared quota pool", async () => fixture(async (s, cfg) => {
  const ctx = context(s); let calls = 0;
  const planner = createApiRecoveryPlanner(s, cfg, (async url => {
    calls++;
    return String(url).includes("fallback") ? planReply("chat-completions") : reply("invalid primary reply");
  }) as typeof fetch);
  assert.equal(await planner(ctx, signal()), null);
  assert.equal(calls, 4);
  assert.equal(await planner(ctx, signal()), null);
  assert.equal(calls, 4);
}, spec => {
  spec.agents.coder.quotaPool = "shared";
  spec.agents.coder.fallbacks = [{ url: "https://fallback.example/v1", model: "fixture-model", quotaPool: "shared" }];
}));

test("a hung primary recovery request times out and fails over without leaving an active reservation", async () => fixture(async (s, cfg) => {
  const ctx = context(s);
  assert.equal(await createApiRecoveryPlanner(s, cfg, (async url => String(url).includes("fallback") ?
    planReply("chat-completions") : new Promise<Response>(() => {})) as typeof fetch)(ctx, signal()), null);
  const usage = new SessionJournal(s).usage(ctx.runId);
  assert.equal(usage.requests, 2);
  assert.equal(usage.unknownRequests, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_requests WHERE status='ACTIVE'").get()!.n, 0);
}, spec => {
  spec.budget.requestTimeoutMs = 20;
  spec.agents.coder.fallbacks = [{ url: "https://fallback.example/v1", model: "fixture-model" }];
}));

for (const protocol of ["chat-completions", "anthropic"] as const) {
  test(`${protocol} truncated recovery output must be corrected before it can become a plan`, async () => fixture(async (s, cfg) => {
    const ctx = context(s); let calls = 0;
    assert.equal(await createApiRecoveryPlanner(s, cfg, (async () => {
      const response = planReply(protocol);
      if (++calls === 1) {
        const raw: any = await response.json();
        if (protocol === "anthropic") raw.stop_reason = "max_tokens";
        else raw.choices[0].finish_reason = "length";
        return Response.json(raw);
      }
      return response;
    }) as typeof fetch)(ctx, signal()), null);
    assert.equal(calls, 2);
  }, spec => { spec.agents.coder.protocol = protocol; }));
}

test("all unavailable recovery routes persist cooldowns, then resume when an endpoint returns", async () => fixture(async (s, cfg) => {
  const ctx = context(s); let calls = 0;
  const down = (async url => {
    calls++;
    if (String(url).includes("fallback")) throw Object.assign(new Error("offline"), { code: "ECONNRESET" });
    return new Response(null, { status: 503, headers: { "retry-after": "120" } });
  }) as typeof fetch;
  await assert.rejects(createApiRecoveryPlanner(s, cfg, down)(ctx, signal()), e => {
    assert.ok(e instanceof DeferredAttemptError);
    assert.ok(e.wakeAt < Date.now() + 5000, "earliest recovering route owns the retry deadline"); return true;
  });
  assert.equal(calls, 2);
  const reopened = await Store.open(s.root);
  try {
    await assert.rejects(createApiRecoveryPlanner(reopened, cfg, down)(ctx, signal()), DeferredAttemptError);
    assert.equal(calls, 2, "blocked admission spends no request");
    expireCooldowns(reopened);
    assert.equal(await createApiRecoveryPlanner(reopened, cfg, (async () => {
      calls++; return planReply("chat-completions");
    }) as typeof fetch)(ctx, signal()), null);
    assert.equal(calls, 3);
  } finally { reopened.close(); }
}, spec => { spec.agents.coder.fallbacks = [{ url: "https://fallback.example/v1", model: "fixture-model" }]; }));

test("invalid recovery output receives bounded changed-input repair and replays the accepted repair", async () => fixture(async (s, cfg) => {
  const ctx = context(s), bodies: any[] = [];
  const planner = createApiRecoveryPlanner(s, cfg, (async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    return bodies.length === 1 ? reply("missing required tool") : planReply("chat-completions");
  }) as typeof fetch);
  assert.equal(await planner(ctx, signal()), null);
  assert.equal(bodies.length, 2);
  assert.notDeepEqual(bodies[0], bodies[1], "repair must change the rejected request");
  const packet = JSON.parse(bodies[1].messages[1].content);
  assert.equal(packet.responseRepair.attempt, 1);
  assert.match(packet.responseRepair.rejectedResponse, /^[a-f0-9]{64}$/);
  assert.equal(await planner(ctx, signal()), null);
  assert.equal(bodies.length, 2);
}));

test("recovery response repair resumes across a transport outage and restart without repeating invalid requests", async () => fixture(async (s, cfg) => {
  const ctx = context(s), bodies: any[] = [];
  await assert.rejects(createApiRecoveryPlanner(s, cfg, (async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    if (bodies.length === 1) return reply("missing required tool");
    throw new TypeError("fetch failed");
  }) as typeof fetch)(ctx, signal()), DeferredAttemptError);
  assert.equal(bodies.length, 2);
  const reopened = await Store.open(s.root);
  try {
    expireCooldowns(reopened);
    assert.equal(await createApiRecoveryPlanner(reopened, cfg, (async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      assert.deepEqual(body, bodies[1], "resume must use the correction, not the rejected original request");
      return planReply("chat-completions");
    }) as typeof fetch)(ctx, signal()), null);
    assert.equal(new SessionJournal(reopened).usage(ctx.runId).requests, 3);
  } finally { reopened.close(); }
}));

test("a received JSON null remains a durable invalid receipt across recovery restart", async () => fixture(async (s, cfg) => {
  const ctx = context(s), bodies: any[] = [];
  await assert.rejects(createApiRecoveryPlanner(s, cfg, (async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    if (bodies.length === 1) return Response.json(null);
    throw new TypeError("fetch failed");
  }) as typeof fetch)(ctx, signal()), DeferredAttemptError);
  assert.equal(bodies.length, 2);
  const reopened = await Store.open(s.root);
  try {
    expireCooldowns(reopened);
    assert.equal(await createApiRecoveryPlanner(reopened, cfg, (async (_url, init) => {
      assert.deepEqual(JSON.parse(init!.body as string), bodies[1]);
      return planReply("chat-completions");
    }) as typeof fetch)(ctx, signal()), null);
    assert.equal(new SessionJournal(reopened).usage(ctx.runId).requests, 3);
  } finally { reopened.close(); }
}));

test("operator cancellation during recovery stops failover without opening a provider outage", async () => fixture(async (s, cfg) => {
  const ctx = context(s), controller = new AbortController(); let calls = 0;
  await assert.rejects(createApiRecoveryPlanner(s, cfg, (async () => {
    calls++; controller.abort(new Error("operator paused"));
    return new Promise<Response>(() => {});
  }) as typeof fetch)(ctx, controller.signal), /operator paused/);
  assert.equal(calls, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_provider_health").get()!.n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_requests WHERE status='ACTIVE'").get()!.n, 0);
}, spec => { spec.agents.coder.fallbacks = [{ url: "https://fallback.example/v1", model: "fixture-model" }]; }));

test("three invalid recovery outputs exhaust the repair limit durably", async () => fixture(async (s, cfg) => {
  const ctx = context(s); let calls = 0;
  const planner = createApiRecoveryPlanner(s, cfg, (async () => { calls++; return reply("invalid"); }) as typeof fetch);
  await assert.rejects(planner(ctx, signal()), /RECOVERY_RESPONSE_REPAIR_EXHAUSTED/);
  assert.equal(calls, 3);
  await assert.rejects(planner(ctx, signal()), /RECOVERY_RESPONSE_REPAIR_EXHAUSTED/);
  assert.equal(calls, 3, "replay cannot reset the response repair budget");
}));

test("recovery repair preserves request budgets and operator cancellation", async () => fixture(async (s, cfg) => {
  const ctx = context(s); let calls = 0;
  const limited = { ...cfg, spec: { ...cfg.spec, budget: { ...cfg.spec.budget, maxRequests: 1 } } };
  await assert.rejects(createApiRecoveryPlanner(s, limited, (async () => {
    calls++; return reply("invalid");
  }) as typeof fetch)(ctx, signal()), /RUN_REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(calls, 1);
  const cancelled = new AbortController(); cancelled.abort(new Error("operator paused"));
  await assert.rejects(createApiRecoveryPlanner(s, cfg)(ctx, cancelled.signal), /operator paused/);
  assert.equal(calls, 1);
}));

test("supervision recovers through a healthy fallback and finishes only after independent acceptance", { timeout: 60000 }, async t => fixture(async (s, cfg) => {
  let workerCalls = 0, recoveryCalls = 0;
  const result: any = await superviseSwarm(s, { id: "fallback-objective", goal: "Implement and verify", tasks: [task()] },
    t.signal, undefined, (async (url, init) => {
      const body = JSON.parse(init!.body as string);
      const recovery = body.tools?.some((t: any) => t.function?.name === "propose_recovery_plan");
      if (recovery) {
        recoveryCalls++;
        if (!String(url).includes("fallback")) return new Response(null, { status: 503 });
        const packet = JSON.parse(body.messages[1].content);
        return planReply("chat-completions", { decision: "replan", reason: "Implement the missing patch",
          tasks: [{ ...task(), goal: "Repair the missing implementation" }],
          addressedFindings: packet.hostReflection.findings.map((f: any) => f.code) } as any);
      }
      workerCalls++;
      if (workerCalls === 1) return reply("done without a patch");
      return workerCalls === 2 ? reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]) : reply("done");
    }) as typeof fetch);
  assert.equal(result.status, "PASS");
  assert.equal(result.objective.state, "COMPLETE");
  assert.equal(result.objective.revision, 1);
  assert.equal(result.objective.evidenceGate.status, "PASS");
  assert.ok(result.completion.attestation);
  assert.equal(recoveryCalls, 2);
  assert.equal(workerCalls, 3);
}, spec => {
  spec.recipe.attempts = 1;
  spec.supervision = { maxReplans: 1, reportEveryMs: 10, checkpointEveryMs: 600000 };
  spec.agents.coder.fallbacks = [{ url: "https://fallback.example/v1", model: "fixture-model" }];
}));
