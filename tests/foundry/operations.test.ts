import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { Operations, unresolvedActions, actionEvidenceGate, type ActionRequest, type ActionReply, type ActionRPC } from "../../src/harness/foundry/operations/actions.ts";
import { pinOperations, validateOperations, validateValueSchema, type OperationsPolicy, type PinnedOperations } from "../../src/harness/foundry/operations/contracts.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import { contract, recipe, task } from "./fixtures.ts";
const signal = () => new AbortController().signal;
const answer = (r: ActionRequest, usage = 7): ActionReply => ({ schema: 1, key: r.key, inputHash: r.inputHash,
  status: "CONFIRMED", result: { observed: true }, usage: { capacity: usage }, externalId: "provider-resource-1" });
function policy(): OperationsPolicy {
  return { schema: 1, namespace: "project-account-v1", resources: { capacity: { unit: "integer-units", limit: 20 } },
    timeoutMs: 1000, maxBytes: 8192, pollMs: 10, maxModelRequests: 100, maxModelRequestBytes: 1000000,
    capabilities: { transition: { adapter: { argv: [process.execPath, "./adapter.mjs"] }, effect: "write",
      input: { type: "object", properties: { target: { type: "string" }, value: { type: "integer", minimum: 0, maximum: 50 } }, required: ["target", "value"] },
      identity: ["/target"], reserve: { capacity: 10 } } } };
}
async function fixture(fn: (s: Store, p: PinnedOperations, dir: string) => Promise<void>, edit?: (p: OperationsPolicy) => void) {
  const dir = mkdtempSync(join(tmpdir(), "future-operations-")); const s = await Store.open(join(dir, "state"));
  try {
    writeFileSync(join(dir, "adapter.mjs"), "// pinned trusted test adapter\n");
    s.initialize({ ...contract, limits: { ...contract.limits, timeoutMs: 60000 } }, { ...recipe, timeoutMs: 30000 });
    const p = policy(); edit?.(p); await fn(s, pinOperations(p, dir, process.execPath), dir);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
}
function capsule(s: Store, id = "a") { const q = new Scheduler(s); const run = q.start([task(id)]); const l = q.claim(run, "test")!; return q.capsule(l); }

test("operations schemas reject executable extensions, unbound writes and malformed amounts", () => {
  validateOperations(policy());
  for (const change of [(p: any) => p.capabilities.transition.identity = [],
    (p: any) => p.capabilities.transition.reserve.capacity = .5,
    (p: any) => p.resources.capacity.limit = Number.MAX_SAFE_INTEGER + 1,
    (p: any) => p.capabilities.transition.input = { type: "string", eval: "grant" }]) {
    const p = policy(); change(p); assert.throws(() => validateOperations(p));
  }
  assert.throws(() => validateValueSchema({ type: "object", required: ["absent"] }));
});
test("logical action identity and actual resource accounting survive different runs and reopen", async () => fixture(async (s, p) => {
  const calls: string[] = []; const rpc: ActionRPC = async (_name, r) => { calls.push(r.operation); return answer(r); };
  const a = new Operations(s, p, rpc); const first = await a.invoke(capsule(s), "transition", { target: "resource-1", value: 1 }, ["transition"], signal());
  const other = await Store.open(s.root);
  try {
    const b = new Operations(other, p, rpc);
    assert.deepEqual(await b.invoke(capsule(other, "b"), "transition", { target: "resource-1", value: 1 }, ["transition"], signal()), first);
    assert.deepEqual(calls, ["execute", "inspect"]);
    const row = other.db.prepare("SELECT held,spent FROM operations_resources").get()!;
    assert.equal(row.held, 0); assert.equal(row.spent, 7);
    await assert.rejects(() => b.invoke(capsule(other, "c"), "transition", { target: "resource-1", value: 2 }, ["transition"], signal()), /payload drift/);
  } finally { other.close(); }
}));
test("lost external response quarantines funds and retries only inspect", async () => fixture(async (s, p) => {
  const calls: string[] = []; const rpc: ActionRPC = async (_name, r) => {
    calls.push(r.operation); if (r.operation === "execute") throw Error("accepted externally, socket closed"); return answer(r, 6);
  };
  const a = new Operations(s, p, rpc), c = capsule(s);
  await assert.rejects(() => a.invoke(c, "transition", { target: "lost-response", value: 1 }, ["transition"], signal()), DeferredAttemptError);
  assert.equal(unresolvedActions(s, c.runId), 1);
  assert.deepEqual({ ...s.db.prepare("SELECT held,spent FROM operations_resources").get() }, { held: 10, spent: 0 });
  a.events.setMode("PAUSED"); await delay(15);
  await a.invoke(capsule(s, "b"), "transition", { target: "lost-response", value: 1 }, ["transition"], signal());
  assert.deepEqual(calls, ["execute", "inspect"]);
  assert.equal(unresolvedActions(s, c.runId), 0);
  assert.deepEqual({ ...s.db.prepare("SELECT held,spent FROM operations_resources").get() }, { held: 0, spent: 6 });
}));
test("concurrent independent connections reserve against one shared resource ceiling", async () => fixture(async (s, p) => {
  const other = await Store.open(s.root); let release!: () => void; const gate = new Promise<void>(r => release = r);
  try {
    const a = new Operations(s, p, async (_name, r) => { if (r.operation === "execute") await gate; return answer(r, 10); });
    const b = new Operations(other, p, async (_name, r) => answer(r, 10));
    const running = a.invoke(capsule(s), "transition", { target: "first", value: 1 }, ["transition"], signal());
    await b.invoke(capsule(other, "b"), "transition", { target: "second", value: 1 }, ["transition"], signal());
    await assert.rejects(() => b.invoke(capsule(other, "c"), "transition", { target: "third", value: 1 }, ["transition"], signal()), /resource budget/);
    release(); await running;
    assert.deepEqual({ ...s.db.prepare("SELECT held,spent FROM operations_resources").get() }, { held: 0, spent: 20 });
  } finally { release?.(); other.close(); }
}));
test("same identity cannot dispatch concurrently and missing actual cost stays UNKNOWN", async () => fixture(async (s, p) => {
  let release!: () => void; const gate = new Promise<void>(r => release = r); let executions = 0;
  const a = new Operations(s, p, async (_name, r) => {
    if (r.operation === "execute") { executions++; await gate; }
    const out = answer(r); delete out.usage; return out;
  });
  const first = a.invoke(capsule(s), "transition", { target: "same", value: 1 }, ["transition"], signal());
  await assert.rejects(() => a.invoke(capsule(s, "b"), "transition", { target: "same", value: 1 }, ["transition"], signal()), DeferredAttemptError);
  release(); await assert.rejects(() => first, DeferredAttemptError); assert.equal(executions, 1);
  assert.equal(s.db.prepare("SELECT held FROM operations_resources").get()!.held, 10);
  assert.equal(s.db.prepare("SELECT state FROM operations_actions").get()!.state, "UNKNOWN");
}));
test("grants, input schema, stale facts, revoked leases and adapter pins block mutation", async () => fixture(async (s, p, dir) => {
  let calls = 0; const a = new Operations(s, p, async (_name, r) => { calls++; return answer(r); });
  const c = capsule(s), input = { target: "x", value: 1 };
  await assert.rejects(() => a.invoke(c, "transition", input, [], signal()), /not granted/);
  await assert.rejects(() => a.invoke(c, "transition", { ...input, grant: true }, ["transition"], signal()), /unexpected/);
  await assert.rejects(() => a.invoke(c, "transition", input, ["transition"], signal()), /stale observation/);
  const evidence = s.artifact({ source: "trusted-observer", measured: true });
  a.observe("state-current", { version: 1 }, evidence, Date.now(), Date.now() + 60000);
  s.db.prepare("UPDATE tasks SET deadline=0 WHERE run=?").run(c.runId);
  await assert.rejects(() => a.invoke(c, "transition", input, ["transition"], signal()), /stale action/);
  writeFileSync(join(dir, "adapter.mjs"), "// changed implementation\n");
  await assert.rejects(() => a.invoke(capsule(s, "b"), "transition", input, ["transition"], signal()), /pin|changed/);
  assert.equal(calls, 0);
}, p => p.capabilities.transition.requires = ["state-current"]));
test("excess, fractional or unreserved usage cannot release a commitment", async () => {
  for (const usage of [{ capacity: 11 }, { capacity: 1.5 }, { capacity: 1, extra: 1 }]) await fixture(async (s, p) => {
    const a = new Operations(s, p, async (_name, r) => ({ ...answer(r), usage }));
    await assert.rejects(() => a.invoke(capsule(s), "transition", { target: "x", value: 1 }, ["transition"], signal()), DeferredAttemptError);
    assert.deepEqual({ ...s.db.prepare("SELECT held,spent FROM operations_resources").get() }, { held: 10, spent: 0 });
  });
});
test("draining preserves existing liabilities and admits only declared resolution capabilities", async () => fixture(async (s, p) => {
  const a = new Operations(s, p, async (_name, r) => answer(r)); a.events.setMode("DRAINING");
  await assert.rejects(() => a.invoke(capsule(s), "transition", { target: "new", value: 1 }, ["transition"], signal()), /not admitting/);
  await a.invoke(capsule(s, "b"), "resolution", { target: "existing", value: 1 }, ["resolution"], signal());
  assert.equal(s.db.prepare("SELECT spent FROM operations_resources").get()!.spent, 7);
}, p => p.capabilities.resolution = { ...p.capabilities.transition, purpose: "resolve" }));
test("read capabilities use observations without external commitment authority", async () => fixture(async (s, p) => {
  const a = new Operations(s, p, async (_name, r) => ({ schema: 1, key: r.key, inputHash: r.inputHash, status: "CONFIRMED", result: { value: 12 } }));
  const result: any = await a.invoke(capsule(s), "observe", { target: "x", value: 1 }, ["observe"], signal());
  assert.equal(result.trust, "OBSERVATION_NOT_ACCEPTANCE");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM operations_actions").get()!.n, 0);
}, p => p.capabilities.observe = { adapter: p.capabilities.transition.adapter, effect: "read", input: p.capabilities.transition.input }));

test("acceptance revalidates terminal receipt bytes and exact action binding", async () => fixture(async (s, p) => {
  const a = new Operations(s, p, async (_name, r) => answer(r)); const c = capsule(s);
  await a.invoke(c, "transition", { target: "x", value: 1 }, ["transition"], signal());
  assert.equal(actionEvidenceGate(s, c.runId, c.task.id).status, "PASS");
  const row = s.db.prepare("SELECT key,receipt FROM operations_actions").get()!;
  const wrong = s.artifact({ schema: 1, key: "another-action", inputHash: "another-input", status: "CONFIRMED", result: {}, usage: { capacity: 7 } });
  s.db.prepare("UPDATE operations_actions SET receipt=? WHERE key=?").run(wrong, row.key);
  assert.equal(actionEvidenceGate(s, c.runId).invalid, 1);
  s.db.prepare("UPDATE operations_actions SET receipt=? WHERE key=?").run(row.receipt, row.key);
  unlinkSync(join(s.root, "artifacts", `${row.receipt}.json`));
  assert.equal(actionEvidenceGate(s, c.runId).status, "BLOCKED");
}));
test("objective recovery cannot hide an unresolved action in an older run", async () => fixture(async (s, p) => {
  const a = new Operations(s, p, async () => { throw Error("unknown external result"); }), c = capsule(s);
  await assert.rejects(() => a.invoke(c, "transition", { target: "x", value: 1 }, ["transition"], signal()), DeferredAttemptError);
  const later = capsule(s, "b");
  s.db.exec("CREATE TABLE swarm_objective_revisions(objective TEXT,run TEXT)");
  s.db.prepare("INSERT INTO swarm_objective_revisions VALUES(?,?)").run("objective-1", c.runId);
  assert.equal(actionEvidenceGate(s, later.runId, undefined, "objective-1").unresolved, 1);
  assert.equal(unresolvedActions(s, later.runId, undefined, "objective-1"), 1);
}));
