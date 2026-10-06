import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, task, signal, reply } from "./swarm-fixtures.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { runHealth } from "../../src/harness/foundry/health.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { HttpBrain } from "../../src/harness/foundry/swarm/model.ts";
import { runSwarm, integrateSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { createApiRecoveryPlanner } from "../../src/harness/foundry/swarm/recovery.ts";
import { retryAfterMs } from "../../src/harness/foundry/swarm/providerRecovery.ts";

const history = [{ role: "user" as const, content: "task" }];
const pool = (cfg: any) => digest({ quotaPool: cfg.spec.agents.coder.quotaPool ??
  cfg.spec.agents.coder.url + "#" + cfg.spec.agents.coder.model });
function start(s: Store, ids = ["a"]) {
  const q = new Scheduler(s);
  const run = q.start(ids.map(id => ({ ...task(id), readScope: [] })));
  const leases = q.claimMany(run, "worker", ids.length);
  return { q, run, leases, capsules: leases.map(l => q.capsule(l)) };
}
function expireCooldown(s: Store, provider: string) {
  s.db.prepare("UPDATE agent_cooldowns SET until_ms=0 WHERE provider=?").run(provider);
  s.db.prepare("UPDATE agent_provider_health SET retry_at=0 WHERE provider=?").run(provider);
}

test("Retry-After supports seconds and dates, rejects invalid values and has a finite ceiling", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(retryAfterMs("120", now), 120000);
  assert.equal(retryAfterMs(new Date(now + 120000).toUTCString(), now), 120000);
  assert.equal(retryAfterMs("0", now), 0);
  assert.equal(retryAfterMs("999999999999", now), 86400000);
  for (const value of [null, "", "-1", "NaN", "Infinity", "garbage"]) assert.equal(retryAfterMs(value, now), null);
});

test("long provider cooldown yields immediately, survives reopen and spends no request on blocked admission", async () => fixture(async (s, cfg) => {
  const { q, run, leases, capsules } = start(s);
  let calls = 0;
  const journal = new SessionJournal(s);
  const brain = new HttpBrain(journal, (async () => {
    calls++; return new Response(null, { status: 429, headers: { "retry-after": "120" } });
  }) as typeof fetch);
  const before = Date.now();
  let deferred: DeferredAttemptError | undefined;
  await assert.rejects(brain.next(capsules[0], cfg.spec.agents.coder, history, cfg.spec.budget, 32768, signal()), error => {
    assert.ok(error instanceof DeferredAttemptError); deferred = error;
    assert.ok(error.wakeAt >= before + 120000); return true;
  });
  assert.equal(calls, 1);
  assert.ok(q.defer(leases[0], deferred!));
  assert.equal(q.claim(run, "premature"), null);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status IN ('FAIL','EXPIRED')").get()!.n, 0);
  const reopened = await Store.open(s.root);
  try {
    const other = new SessionJournal(reopened);
    await assert.rejects(other.reserveRun(run, "__recovery__", pool(cfg), {}, cfg.spec.budget, signal()), DeferredAttemptError);
    assert.equal(other.usage(run).requests, 1);
    assert.equal(runHealth(reopened, run).provider!.coolingPools, 1);
  } finally { reopened.close(); }
}));

test("a recovering quota pool admits one probe across connections and wakes deferred peers after success", async () => fixture(async (s, cfg) => {
  const { q, run, leases, capsules } = start(s, ["a", "b"]);
  const journal = new SessionJournal(s); const provider = pool(cfg);
  const failed = await journal.reserve(capsules[0], provider, {}, cfg.spec.budget, signal());
  journal.complete(failed, null, { httpStatus: 503 }); journal.providerFailure(failed, null, 503);
  expireCooldown(s, provider);
  const probe = await journal.reserve(capsules[0], provider, {}, cfg.spec.budget, signal());
  const other = await Store.open(s.root);
  try {
    await assert.rejects(new SessionJournal(other).reserve(capsules[1], provider, {}, cfg.spec.budget, signal()), error => {
      assert.ok(error instanceof DeferredAttemptError); assert.ok(q.defer(leases[1], error)); return true;
    });
    assert.equal(journal.usage(run).requests, 2);
    assert.equal(q.claim(run, "blocked"), null);
    journal.complete(probe, 1, { ok: true }); journal.providerSuccess(probe);
    assert.equal(q.claim(run, "resumed")!.taskId, "b");
    assert.equal(s.db.prepare("SELECT failures FROM agent_provider_health WHERE provider=?").get(provider)!.failures, 0);
  } finally { other.close(); }
}));

test("late successes cannot erase a newer outage and failure receipts are idempotent", async () => fixture(async (s, cfg) => {
  const { capsules } = start(s, ["a", "b"]); const j = new SessionJournal(s); const provider = pool(cfg);
  const late = await j.reserve(capsules[0], provider, {}, cfg.spec.budget, signal());
  const failing = await j.reserve(capsules[1], provider, {}, cfg.spec.budget, signal());
  j.complete(failing, null, { httpStatus: 429 }); const wake = j.providerFailure(failing, "120", 429);
  assert.equal(j.providerFailure(failing, "120", 429), wake);
  j.complete(late, 1, { ok: true }); j.providerSuccess(late);
  const state = s.db.prepare("SELECT failures,retry_at FROM agent_provider_health WHERE provider=?").get(provider)!;
  assert.equal(state.failures, 1); assert.equal(state.retry_at, wake);
}));

test("probe success before continuation persistence cannot lose a peer's wakeup", async () => fixture(async (s, cfg) => {
  const { q, run, leases, capsules } = start(s, ["a", "b"]); const j = new SessionJournal(s); const provider = pool(cfg);
  const failed = await j.reserve(capsules[0], provider, {}, cfg.spec.budget, signal());
  j.complete(failed, null, null); j.providerFailure(failed); expireCooldown(s, provider);
  const probe = await j.reserve(capsules[0], provider, {}, cfg.spec.budget, signal());
  let deferred: DeferredAttemptError | undefined;
  await assert.rejects(j.reserve(capsules[1], provider, {}, cfg.spec.budget, signal()), error => {
    assert.ok(error instanceof DeferredAttemptError); deferred = error; return true;
  });
  j.complete(probe, 1, { ok: true }); j.providerSuccess(probe);
  assert.ok(q.defer(leases[1], deferred!));
  assert.equal(q.claim(run, "resumed")!.taskId, "b");
}));

test("an expired crashed probe can be replaced while its spend remains unknown", async () => fixture(async (s, cfg) => {
  const { capsules } = start(s); const j = new SessionJournal(s); const provider = pool(cfg);
  const fail = await j.reserve(capsules[0], provider, {}, cfg.spec.budget, signal());
  j.complete(fail, null, null); j.providerFailure(fail); expireCooldown(s, provider);
  const lost = await j.reserve(capsules[0], provider, {}, cfg.spec.budget, signal());
  s.db.prepare("UPDATE agent_requests SET deadline=0 WHERE id=?").run(lost);
  const replacement = await j.reserve(capsules[0], provider, {}, cfg.spec.budget, signal());
  assert.notEqual(replacement, lost);
  assert.equal(s.db.prepare("SELECT status FROM agent_requests WHERE id=?").get(lost)!.status, "UNKNOWN");
  assert.equal(j.usage(capsules[0].runId).requests, 3);
  j.complete(replacement, 1, { ok: true }); j.providerSuccess(replacement);
}));

test("successful probes reset consecutive-failure backoff rather than counting lifetime requests", async () => fixture(async (s, cfg) => {
  const { capsules } = start(s); const j = new SessionJournal(s); const provider = pool(cfg);
  for (let i = 0; i < 10; i++) {
    const id = await j.reserve(capsules[0], provider, { i }, cfg.spec.budget, signal());
    j.complete(id, 1, { ok: true }); j.providerSuccess(id);
  }
  for (let i = 0; i < 2; i++) {
    const fail = await j.reserve(capsules[0], provider, {}, cfg.spec.budget, signal());
    j.complete(fail, null, null); const before = Date.now(); const wake = j.providerFailure(fail);
    const expected = 1000 * 2 ** i;
    assert.ok(wake >= before + expected && wake <= Date.now() + expected);
    expireCooldown(s, provider);
  }
  expireCooldown(s, provider);
  const probe = await j.reserve(capsules[0], provider, {}, cfg.spec.budget, signal());
  j.complete(probe, 1, { ok: true }); j.providerSuccess(probe);
  const again = await j.reserve(capsules[0], provider, {}, cfg.spec.budget, signal());
  j.complete(again, null, null); j.providerFailure(again);
  assert.equal(s.db.prepare("SELECT failures FROM agent_provider_health WHERE provider=?").get(provider)!.failures, 1);
}));

test("a cooled primary route is skipped while a healthy fallback can complete and replay", async () => fixture(async (s, cfg) => {
  const { capsules } = start(s); const j = new SessionJournal(s);
  j.cooldown(pool(cfg), 5000); const calls: string[] = [];
  const profile = { ...cfg.spec.agents.coder, fallbacks: [{ url: "https://fallback.example/v1", model: cfg.spec.agents.coder.model }] };
  const brain = new HttpBrain(j, (async url => { calls.push(String(url)); return reply("fallback"); }) as typeof fetch);
  assert.equal((await brain.next(capsules[0], profile, history, cfg.spec.budget, 32768, signal())).turn.message.content, "fallback");
  assert.deepEqual(calls, [profile.fallbacks[0].url]);
  await brain.next(capsules[0], profile, history, cfg.spec.budget, 32768, signal());
  assert.equal(calls.length, 1); assert.equal(j.usage(capsules[0].runId).requests, 1);
}));

test("request deadlines bound a fetch adapter that ignores abort without counting operator cancellation as an outage", async () => fixture(async (s, cfg) => {
  const { capsules } = start(s); const j = new SessionJournal(s);
  const brain = new HttpBrain(j, (async () => new Promise<Response>(() => {})) as typeof fetch);
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(brain.next(capsules[0], cfg.spec.agents.coder, history,
    { ...cfg.spec.budget, requestTimeoutMs: 20 }, 32768, signal()), DeferredAttemptError); }
  finally { clearInterval(keepAlive); }
  assert.equal(j.usage(capsules[0].runId).unknownRequests, 1);
  assert.equal(s.db.prepare("SELECT failures FROM agent_provider_health WHERE provider=?").get(pool(cfg))!.failures, 1);
  expireCooldown(s, pool(cfg));
  const cancel = new AbortController(); const timer = setTimeout(() => cancel.abort(), 10);
  try { await assert.rejects(brain.next(capsules[0], cfg.spec.agents.coder, history, cfg.spec.budget, 32768, cancel.signal)); }
  finally { clearTimeout(timer); }
  assert.equal(s.db.prepare("SELECT failures FROM agent_provider_health WHERE provider=?").get(pool(cfg))!.failures, 1);
}));

test("a stalled response body and cancellation hook cannot keep a request alive past its deadline", async () => fixture(async (s, cfg) => {
  const { capsules } = start(s); const j = new SessionJournal(s);
  const brain = new HttpBrain(j, (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":')); },
    cancel() { return new Promise(() => {}); },
  }))) as typeof fetch);
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(brain.next(capsules[0], cfg.spec.agents.coder, history,
    { ...cfg.spec.budget, requestTimeoutMs: 20 }, 32768, signal()), DeferredAttemptError); }
  finally { clearInterval(keepAlive); }
  assert.equal(j.usage(capsules[0].runId).unknownRequests, 1);
}));

test("a hedge winner is returned even when the losing adapter ignores cancellation", async () => fixture(async (s, cfg) => {
  const { capsules } = start(s); const j = new SessionJournal(s);
  const profile = { ...cfg.spec.agents.coder, hedgeAfterMs: 10,
    fallbacks: [{ url: "https://fallback.example/v1", model: cfg.spec.agents.coder.model }] };
  const brain = new HttpBrain(j, (async url => String(url).includes("fallback") ? reply("winner") :
    new Promise<Response>(() => {})) as typeof fetch);
  const out = await brain.next(capsules[0], profile, history, cfg.spec.budget, 32768, signal());
  assert.equal(out.turn.message.content, "winner");
  assert.equal(j.usage(capsules[0].runId).requests, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_requests WHERE status='ACTIVE'").get()!.n, 0);
}));

test("recovery planning shares provider cooldown and never caches an HTTP error as a plan", async () => fixture(async (s, cfg) => {
  const { run } = start(s); let calls = 0;
  const context = { objectiveId: "recover", goal: "repair", runId: run, reason: "check failed", revision: 1, tasks: [task()], failures: [] };
  const planner = createApiRecoveryPlanner(s, cfg, (async () => {
    calls++; return calls === 1 ? new Response(null, { status: 503, headers: { "retry-after": "120" } }) :
      reply("", [{ name: "propose_recovery_plan", arguments: { decision: "decline", reason: "No safe replan", tasks: [], addressedFindings: [] } }]);
  }) as typeof fetch);
  await assert.rejects(planner(context, signal()), error => {
    assert.ok(error instanceof DeferredAttemptError); assert.ok(error.wakeAt > Date.now() + 100000); return true;
  });
  await assert.rejects(planner(context, signal()), DeferredAttemptError); assert.equal(calls, 1);
  expireCooldown(s, pool(cfg)); assert.equal(await planner(context, signal()), null);
  assert.equal(await planner(context, signal()), null); assert.equal(calls, 2);
}));

test("healthy work finishes during an outage and the deferred task resumes with independent task and integration checks", async t => fixture(async (s, cfg) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let primary = 0; let backup = 0; let observedIndependentProgress = false;
  const fetcher = (async (url: any, init: any) => {
    const isBackup = String(url).includes("backup");
    if (isBackup) backup++; else if (++primary === 1) return new Response(null, { status: 503 });
    const body = JSON.parse(init.body);
    return body.messages.some((m: any) => m.role === "tool") ? reply("done") : reply("", [{
      name: "write_file", arguments: { path: isBackup ? "src/b.txt" : "src/a.txt", content: "42\n" },
    }]);
  }) as typeof fetch;
  const result = await runSwarm(s, [{ ...task("a"), readScope: [] }, { ...task("b"), agent: "backup", readScope: [] }],
    signal(), undefined, fetcher, health => {
      if (!observedIndependentProgress && health.waiting === 1 && health.counts.PASS === 1 && health.provider!.coolingPools === 1) {
        observedIndependentProgress = true;
        t.mock.timers.tick(health.provider!.nextRetryAt! - Date.now());
      }
    }) as any;
  assert.equal(result.status, "PASS"); assert.ok(observedIndependentProgress);
  assert.equal(primary, 3); assert.equal(backup, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status IN ('FAIL','EXPIRED')").get()!.n, 0);
  const integrated = await integrateSwarm(s, result.id, signal());
  const reports = s.readArtifact(integrated.checksHash) as any[];
  assert.deepEqual(reports.map(item => [item.name, item.code]), [["behavior", 0], ["b-behavior", 0]]);
}, spec => {
  spec.agents.backup = { ...spec.agents.coder, url: "https://backup.example/v1", checks: ["b-behavior"] };
  spec.checks["b-behavior"] = { argv: [process.execPath, "-e", "if(require('node:fs').readFileSync('src/b.txt','utf8').trim()!=='42')process.exit(1)"], replaySafe: true };
  spec.integrationChecks = ["behavior", "b-behavior"];
  spec.supervision = { reportEveryMs: 10, checkpointEveryMs: 1000 };
}));
