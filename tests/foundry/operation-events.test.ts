import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { runTasks } from "../../src/harness/foundry/runtime.ts";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { OperationsEvents } from "../../src/harness/foundry/operations/events.ts";
import { contract, recipe, task } from "./fixtures.ts";

async function fixture(work: (store: Store, events: OperationsEvents) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), "future-operation-events-"));
  const store = await Store.open(root);
  store.initialize(contract, recipe);
  try { await work(store, new OperationsEvents(store, "project-a")); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}
const event = () => ({ source: "authorized-ingress", id: "external-1", type: "changed", payload: { value: 4 } });

test("event identity survives delivery retries and rejects changed inputs", () => fixture((store, events) => {
  const input = event(); const first = events.enqueue(input, 100);
  input.payload.value = 99;
  const second = events.enqueue(event(), 999);
  assert.equal(second.key, first.key);
  assert.equal(second.availableAt, 100);
  assert.equal(second.receivedAt, 100);
  assert.deepEqual(second.payload, { value: 4 });
  assert.throws(() => events.enqueue(input, 999), /event identity/);
  assert.throws(() => events.enqueue({ ...event(), type: "other" }), /event identity/);
  assert.throws(() => events.enqueue({ ...event(), availableAt: 100 }), /event identity/);
  assert.equal(new OperationsEvents(store, "project-b").enqueue(event(), 100).key === first.key, false);
  assert.throws(() => events.enqueue({ ...event(), authorize: true } as any), /event fields/);
  assert.throws(() => events.enqueue({ ...event(), payload: "x".repeat(65537) }), /payload/);
  assert.throws(() => events.due(undefined, 0), /limit/);
}));

test("timers are durable events and cannot dispatch before their due time", () => fixture((store, events) => {
  const first = events.enqueue({ ...event(), availableAt: 500 }, 100);
  assert.deepEqual(events.due(undefined, 20, 499), []);
  assert.throws(() => events.dispatch(first.key, [task()], 499), /not due/);
  assert.equal(events.due("changed", 20, 500)[0].key, first.key);
  assert.deepEqual(events.due("unrelated", 20, 1000), []);
  const active = events.dispatch(first.key, [task()], 500);
  assert.equal(active.status, "DISPATCHED");
  assert.equal(new Scheduler(store).status(active.run!), "RUNNING");
  assert.equal(events.due(undefined, 20, 1000).length, 0);
}));

test("independent connections dispatch one stable run and bind the exact task plan", () => fixture(async (store, events) => {
  const second = await Store.open(store.root);
  try {
    const peer = new OperationsEvents(second, "project-a");
    const queued = events.enqueue(event());
    const first = events.dispatch(queued.key, [task()]);
    const adopted = peer.dispatch(queued.key, [task()]);
    assert.equal(adopted.run, first.run);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n, 1);
    assert.equal(events.incomplete()[0].run, first.run);
    assert.throws(() => peer.dispatch(queued.key, [{ ...task(), input: { value: 7 } }]), /plan/);
    assert.throws(() => new OperationsEvents(second, "other").get(queued.key), /unknown event/);
  } finally { second.close(); }
}));

test("prepared event admission survives a crash before Scheduler.start", () => fixture((store, events) => {
  const queued = events.enqueue(event());
  const start = Scheduler.prototype.start;
  try {
    Scheduler.prototype.start = function () { throw new Error("simulated pre-start crash"); };
    assert.throws(() => events.dispatch(queued.key, [task()]), /simulated/);
  } finally { Scheduler.prototype.start = start; }
  const prepared = events.get(queued.key);
  assert.equal(prepared.status, "PREPARED");
  assert.ok(prepared.run && prepared.planHash);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 0);
  events.setMode("PAUSED");
  assert.throws(() => events.dispatch(queued.key, [task()]), /paused/);
  events.setMode("DRAINING");
  assert.equal(events.dispatch(queued.key, [task()]).run, prepared.run);
}));

test("a crash after run creation is adopted even while paused", () => fixture((store, events) => {
  const queued = events.enqueue(event());
  const start = Scheduler.prototype.start;
  try {
    Scheduler.prototype.start = function (...args: Parameters<typeof start>) {
      start.apply(this, args); throw new Error("simulated post-start crash");
    };
    assert.throws(() => events.dispatch(queued.key, [task()]), /simulated/);
  } finally { Scheduler.prototype.start = start; }
  const prepared = events.get(queued.key);
  assert.equal(prepared.status, "PREPARED");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 1);
  events.setMode("PAUSED");
  assert.equal(events.dispatch(queued.key, [task()]).run, prepared.run);
  assert.equal(events.get(queued.key).status, "DISPATCHED");
}));

test("service mode survives restart and draining cannot acquire new events", () => fixture(async (store, events) => {
  const first = events.enqueue(event()); events.dispatch(first.key, [task()]);
  const next = events.enqueue({ ...event(), id: "external-2" });
  events.setMode("DRAINING");
  assert.equal(events.dispatch(first.key, [task()]).run, events.get(first.key).run);
  assert.throws(() => events.dispatch(next.key, [task()]), /not active/);
  const second = await Store.open(store.root);
  try {
    assert.equal(new OperationsEvents(second, "project-a").mode(), "DRAINING");
  } finally { second.close(); }
  events.setMode("PAUSED");
  assert.equal(events.dispatch(first.key, [task()]).run, events.get(first.key).run);
  assert.throws(() => events.dispatch(next.key, [task()]), /not active/);
  events.setMode("ACTIVE");
  assert.equal(events.dispatch(next.key, [task()]).status, "DISPATCHED");
  assert.throws(() => events.setMode("COMPLETE" as any), /mode/);
}));

test("event completion requires independently accepted task evidence and rechecks it", () => fixture(async (store, events) => {
  const first = events.dispatch(events.enqueue(event()).key, [task()]);
  assert.throws(() => events.complete(first.key), /run is not PASS/);
  store.db.prepare("UPDATE runs SET status='PASS' WHERE id=?").run(first.run);
  assert.throws(() => events.complete(first.key), /task evidence/);
  store.db.prepare("UPDATE runs SET status='RUNNING' WHERE id=?").run(first.run);
  await runTasks(store, [], {
    workerId: contract.workerId, verifierId: contract.verifierId,
    async execute() { return { artifact: { answer: 4 } }; },
    async verify(_c, result) { return { artifactHash: digest(result.artifact), checks: [{ id: "behavior", verdict: "PASS" }] }; },
  }, { resumeRun: first.run! });
  assert.equal(events.complete(first.key).status, "COMPLETE");
  assert.equal(events.incomplete().length, 0);
  assert.equal(events.complete(first.key).status, "COMPLETE");
  const forged = store.artifact({ invented: true });
  store.db.prepare("UPDATE tasks SET evidence=? WHERE run=?").run(forged, first.run);
  assert.throws(() => events.complete(first.key), /evidence/);
}));

test("obligations persist through pause with immutable evidence and bounded pagination", () => fixture(async (store, events) => {
  const evidenceHash = store.artifact({ observation: "accepted commitment" });
  const resolved = store.artifact({ observation: "independent settlement evidence" });
  const a = events.addObligation({ id: "a", dueAt: 200, detail: "Complete accepted work", evidenceHash }, 100);
  events.addObligation({ id: "b", dueAt: 300, detail: "Complete later work", evidenceHash }, 100);
  assert.equal(events.addObligation({ id: "a", dueAt: 200, detail: "Complete accepted work", evidenceHash }, 999).createdAt, a.createdAt);
  assert.throws(() => events.addObligation({ id: "a", dueAt: 400, detail: "Complete accepted work", evidenceHash }), /obligation identity/);
  assert.throws(() => events.addObligation({ id: "missing", dueAt: 200, detail: "work", evidenceHash: "0".repeat(64) }), /ENOENT|artifact/);
  events.setMode("PAUSED");
  assert.equal(events.outstanding(undefined, 1).items[0].id, "a");
  const page = events.outstanding(undefined, 1);
  assert.equal(events.outstanding(page.nextAfter!, 1).items[0].id, "b");
  const peer = await Store.open(store.root);
  try { assert.equal(new OperationsEvents(peer, "project-a").outstanding().items.length, 2); }
  finally { peer.close(); }
  assert.throws(() => events.resolveObligation("a", "0".repeat(64)), /ENOENT|artifact/);
  assert.equal(events.resolveObligation("a", resolved).status, "RESOLVED");
  assert.equal(events.resolveObligation("a", resolved).status, "RESOLVED");
  assert.throws(() => events.resolveObligation("a", evidenceHash), /resolution/);
  assert.equal(events.outstanding().items.length, 1);
  assert.equal(events.outstanding(page.nextAfter!, 1).items[0].id, "b");
  assert.equal(new OperationsEvents(store, "project-b").outstanding().items.length, 0);
  assert.equal(events.state(1, 400).mode, "PAUSED");
}));

test("due obligations create bounded duplicate-free notifications and survive reopen", () => fixture(async (store, events) => {
  const evidenceHash = store.artifact({ accepted: true });
  const resolutionHash = store.artifact({ settled: true });
  events.addObligation({ id: "first", dueAt: 100, detail: "Existing commitment", evidenceHash }, 1);
  events.addObligation({ id: "second", dueAt: 200, detail: "Next commitment", evidenceHash }, 1);
  events.addObligation({ id: "resolved", dueAt: 50, detail: "Already settled", evidenceHash }, 1);
  events.resolveObligation("resolved", resolutionHash, 40);
  assert.equal(events.nextDeadline(0), 100);
  assert.deepEqual(events.queueDueObligations(1, 99), []);
  const first = events.queueDueObligations(1, 300);
  assert.equal(first.length, 1);
  assert.equal(first[0].type, "obligation.due");
  assert.deepEqual(first[0].payload, { id: "first", evidenceHash, dueAt: 100 });
  const second = await Store.open(store.root);
  try {
    const peer = new OperationsEvents(second, "project-a");
    const next = peer.queueDueObligations(1, 300);
    assert.equal(next.length, 1);
    assert.deepEqual(next[0].payload, { id: "second", evidenceHash, dueAt: 200 });
    assert.deepEqual(peer.queueDueObligations(1, 999), []);
    assert.equal(peer.nextDeadline(300), null);
  } finally { second.close(); }
  assert.equal(events.due("obligation.due", 20, 999).length, 2);
  assert.equal(events.outstanding().items.length, 2);
  assert.throws(() => events.queueDueObligations(0), /limit/);
}));

test("next deadline considers future events and unqueued open obligations", () => fixture((store, events) => {
  const evidenceHash = store.artifact({ accepted: true });
  assert.equal(events.nextDeadline(0), null);
  events.enqueue({ ...event(), availableAt: 500 }, 0);
  events.addObligation({ id: "earlier", dueAt: 100, detail: "Timed work", evidenceHash }, 0);
  assert.equal(events.nextDeadline(0), 100);
  events.queueDueObligations(20, 100);
  assert.equal(events.nextDeadline(100), 500);
  assert.equal(events.nextDeadline(500), null);
  assert.throws(() => events.nextDeadline(-1), /time/);
}));

test("a resolution between due selection and enqueue prevents a stale notification", () => fixture((store, events) => {
  const evidenceHash = store.artifact({ accepted: true });
  const resolutionHash = store.artifact({ settled: true });
  events.addObligation({ id: "racing", dueAt: 100, detail: "Existing work", evidenceHash }, 0);
  const transaction = store.transaction.bind(store);
  let first = true;
  store.transaction = fn => {
    if (first) { first = false; events.resolveObligation("racing", resolutionHash, 100); }
    return transaction(fn);
  };
  try { assert.deepEqual(events.queueDueObligations(20, 100), []); }
  finally { store.transaction = transaction; }
  assert.equal(events.due("obligation.due", 20, 999).length, 0);
}));

test("only an explicit trusted resolution route admits new work while draining", () => fixture((store, events) => {
  const event = events.enqueue({ source: "host", id: "settlement", type: "obligation.due", payload: {} });
  events.setMode("DRAINING");
  assert.throws(() => events.dispatch(event.key, [task()]), /not active/);
  assert.throws(() => events.dispatch(event.key, [task()], Date.now(), "true" as any), /resolution/);
  events.setMode("PAUSED");
  assert.throws(() => events.dispatch(event.key, [task()], Date.now(), true), /not active/);
  events.setMode("DRAINING");
  assert.equal(events.dispatch(event.key, [task()], Date.now(), true).status, "DISPATCHED");
}));
