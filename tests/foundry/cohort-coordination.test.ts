import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { canonical, digest } from "../../src/harness/foundry/kernel.ts";
import { DeferredAttemptError } from "../../src/harness/foundry/continuation.ts";
import type { Capsule, Json, Lease, Task } from "../../src/harness/foundry/types.ts";
import { CohortBoard, type FindingInput } from "../../src/harness/foundry/swarm/cohorts.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { validateSwarmSpec, type SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { validateToolProposal } from "../../src/harness/foundry/swarm/toolAdmission.ts";
import { runSwarm, swarmStatus } from "../../src/harness/foundry/swarm/host.ts";
import { fixture, spec, task, signal, scripted, reply } from "./swarm-fixtures.ts";

function enable(s: SwarmSpec): void {
  s.coordination = { cohorts: { constructive: { maxConcurrent: 1 }, adversarial: { maxConcurrent: 1 } },
    maxFindingsPerTask: 4, maxDigestBytes: 4096 };
  s.agents.coder.cohort = "constructive";
  s.agents.coder.tools.push("publish_finding", "read_findings");
  s.agents.critic = { ...s.agents.coder, cohort: "adversarial", tools: [...s.agents.coder.tools] };
}
function start(s: Store, tasks: Task[]) {
  // These fixtures do not inspect siblings' files. Avoid the fixture's broad
  // default read lock so capacity tests exercise genuinely independent tasks.
  const q = new Scheduler(s); const run = q.start(tasks.map(t => ({ ...t, readScope: [] })));
  const leases = tasks.map(() => q.claim(run, "fixture")!).filter(Boolean);
  return { q, run, leases, capsules: leases.map(l => q.capsule(l)) };
}
function note(id = "finding", audience: FindingInput["audience"] = "shared", receipts: string[] = []): FindingInput {
  return { id, audience, kind: "hypothesis", summary: "A promising alternative still needs independent validation.", receipts };
}
/** Trusted synthetic evidence fixture. This does not run a model or a real check. */
function accept(s: Store, q: Scheduler, l: Lease, c: Capsule, board: CohortBoard,
  patchHash = s.artifact(""), callback?: () => void): void {
  const artifact: Json = { schema: 1, patchHash, summary: "fixture" };
  const evidence: Json = { contractHash: c.contractHash, recipeHash: c.recipeHash,
    verifierId: s.contract().verifierId, taskHash: digest(c.task), artifactHash: digest(artifact),
    verification: { artifactHash: digest(artifact), checks: s.contract().requiredChecks.map(id => ({ id, verdict: "PASS" })) },
    metrics: { durationMs: 1, tokens: 0, costUsd: null } };
  assert.equal(q.finish(l, artifact, evidence, { tokens: 0, costUsd: null }, Date.now(), (a, e) => {
    board.accepted(c, artifact, a, e); callback?.();
  }), true);
}

test("cohort policy is opt-in, pinned and rejects undeclared sharing authority", () => {
  const s = spec("/tmp/project"); validateSwarmSpec(s);
  s.agents.coder.tools.push("publish_finding"); assert.throws(() => validateSwarmSpec(s), /cohort/);
  s.agents.coder.tools.pop(); enable(s); validateSwarmSpec(s);
  const invalid = structuredClone(s); invalid.agents.critic.cohort = "unknown";
  assert.throws(() => validateSwarmSpec(invalid), /cohort/);
  const tooLarge = structuredClone(s); tooLarge.coordination!.maxDigestBytes = 65536;
  assert.throws(() => validateSwarmSpec(tooLarge), /digest/);
  const overCapacity = structuredClone(s); overCapacity.coordination!.cohorts.constructive.maxConcurrent = 9;
  assert.throws(() => validateSwarmSpec(overCapacity), /concurrency/);
});

test("legacy drivers do not install or advertise a cohort board", async () => fixture(async (s, cfg) => {
  const driver = new SwarmDriver(s, cfg);
  assert.equal(driver.cohorts, null); assert.equal(driver.accepted, undefined);
  assert.equal(s.db.prepare("SELECT name FROM sqlite_master WHERE name='swarm_cohort_findings'").get(), undefined);
}));

test("cohort capacity is transactional across handles and preserves an alternate group", async () => fixture(async (s, cfg) => {
  const { capsules: [a, b, c] } = start(s, [task("a"), task("b"), { ...task("c"), agent: "critic" }]);
  const one = new CohortBoard(s, cfg); one.claim(a!);
  const other = await Store.open(s.root);
  try {
    const two = new CohortBoard(other, cfg);
    assert.throws(() => two.claim(b!), error => error instanceof DeferredAttemptError && error.kind === "cohort-capacity");
    two.claim(c!); // A busy constructive cohort does not consume the critic's cap.
    one.release(a!); two.claim(b!);
    assert.equal(other.db.prepare("SELECT COUNT(*) AS n FROM swarm_cohort_leases").get()!.n, 2);
  } finally { other.close(); }
}, enable));

test("obsolete cohort fences neither consume capacity nor release the replacement", async () => fixture(async (s, cfg) => {
  const { q, run, leases: [l], capsules: [c] } = start(s, [task()]);
  const board = new CohortBoard(s, cfg); board.claim(c!); q.fail(l!, "retry");
  const next = q.capsule(q.claim(run, "replacement")!); board.claim(next); board.release(c!);
  assert.equal(s.db.prepare("SELECT fence FROM swarm_cohort_leases").get()!.fence, next.fence);
  assert.throws(() => board.publish(c!, note(), null), /stale/);
}, enable));

test("capacity deferral happens before model spend and durable thread creation", async () => fixture(async (s, cfg) => {
  const { q, leases, capsules } = start(s, [task("a"), task("b")]);
  const driver = new SwarmDriver(s, cfg, (async () => { throw new Error("no model call allowed"); }) as typeof fetch);
  driver.cohorts!.claim(capsules[0]!);
  let deferred: DeferredAttemptError | undefined;
  try { await driver.execute(capsules[1]!, signal()); } catch (error) { deferred = error as DeferredAttemptError; }
  assert.ok(deferred instanceof DeferredAttemptError); q.defer(leases[1]!, deferred);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_requests").get()!.n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_threads").get()!.n, 0);
  assert.equal(s.db.prepare("SELECT kind FROM task_waits WHERE task='b'").get()!.kind, "cohort-capacity");
}, enable));

test("findings are immutable, idempotent, bounded and cannot invent receipts or trust", async () => fixture(async (s, cfg) => {
  const { capsules: [c] } = start(s, [task()]); const board = new CohortBoard(s, cfg);
  const input = note(); const first: any = board.publish(c!, input, null);
  assert.equal((board.publish(c!, input, null) as any).seq, first.seq);
  assert.throws(() => board.publish(c!, { ...input, summary: "changed" }, null), /drift/);
  assert.throws(() => board.publish(c!, note("fake", "cohort", ["0".repeat(64)]), null), /unowned/);
  assert.throws(() => board.publish(c!, { ...note("trusted"), status: "SUPPORTED" } as any, null), /authority/);
  assert.throws(() => board.publish(c!, { ...note("long"), summary: "中".repeat(1000) }, null), /bytes/);
  for (let i = 1; i < 4; i++) board.publish(c!, note(`f${i}`), null);
  assert.throws(() => board.publish(c!, note("overflow"), null), /budget/);
  assert.throws(() => s.db.exec("UPDATE swarm_cohort_findings SET audience='cohort'"), /append-only/);
  assert.throws(() => validateToolProposal(c!, cfg, cfg.spec.agents.coder,
    { id: "bad", name: "read_findings", arguments: { audience: "all-private-history" } }), /enum/);
}, enable));

test("shared visibility begins at atomic acceptance, with its own late-arrival cursor", async () => fixture(async (s, cfg) => {
  const { q, leases, capsules } = start(s, [task("a"), { ...task("b"), agent: "critic" }]);
  const board = new CohortBoard(s, cfg); board.publish(capsules[0]!, note(), null);
  const before: any = board.read(capsules[1]!, "shared"); assert.equal(before.findings.length, 0);
  assert.equal((board.read(capsules[1]!, "cohort") as any).findings.length, 0);
  assert.equal((board.read(capsules[0]!, "cohort") as any).findings.length, 1);
  accept(s, q, leases[0]!, capsules[0]!, board);
  const after: any = board.read(capsules[1]!, "shared", before.nextAfter);
  assert.equal(after.findings.length, 1); assert.equal(after.findings[0].sourceAcceptance, "TASK_CHECKS_PASSED");
  assert.equal(after.findings[0].summaryTrust, "UNVERIFIED");
  assert.equal((board.read(capsules[1]!, "shared", after.nextAfter) as any).findings.length, 0);
}, enable));

test("superseded patches cannot become cross-cohort evidence", async () => fixture(async (s, cfg) => {
  const { q, leases, capsules } = start(s, [task("a"), { ...task("b"), agent: "critic" }]);
  const board = new CohortBoard(s, cfg); board.publish(capsules[0]!, note(), null);
  accept(s, q, leases[0]!, capsules[0]!, board, s.artifact("a newer patch"));
  assert.equal((board.read(capsules[1]!, "shared") as any).findings.length, 0);
}, enable));

test("a failed source leaves its shared finding unpublished", async () => fixture(async (s, cfg) => {
  const { q, leases, capsules } = start(s, [task("a"), { ...task("b"), agent: "critic" }]);
  const board = new CohortBoard(s, cfg); board.publish(capsules[0]!, note(), null);
  q.fail(leases[0]!, "independent check failed", undefined, Date.now(), { retryable: false });
  assert.equal((board.read(capsules[1]!, "shared") as any).findings.length, 0);
}, enable));

test("export failure rolls back acceptance and promotion together", async () => fixture(async (s, cfg) => {
  const { q, leases: [l], capsules: [c] } = start(s, [task()]);
  const board = new CohortBoard(s, cfg); board.publish(c!, note(), null);
  assert.throws(() => accept(s, q, l!, c!, board, undefined, () => { throw new Error("simulated crash"); }), /crash/);
  assert.equal(s.db.prepare("SELECT status FROM tasks").get()!.status, "RUNNING");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM swarm_cohort_exports").get()!.n, 0);
  accept(s, q, l!, c!, board);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM swarm_cohort_exports").get()!.n, 1);
}, enable));

test("shared receipts expand only the published note and corrupt source evidence fails closed", async () => fixture(async (s, cfg) => {
  const { q, leases, capsules } = start(s, [task("a"), { ...task("b"), agent: "critic" }]);
  const journal = new SessionJournal(s); const privateReceipt = journal.receipt(capsules[0]!, { privateTranscript: "private" });
  const board = new CohortBoard(s, cfg, journal); board.publish(capsules[0]!, note("f", "shared", [privateReceipt]), null);
  accept(s, q, leases[0]!, capsules[0]!, board);
  const page: any = board.read(capsules[1]!, "shared");
  assert.match(canonical(journal.recall(capsules[1]!, page.findings[0].findingReceipt)), /promising alternative/);
  assert.throws(() => journal.recall(capsules[1]!, privateReceipt), /not owned/);
  const original = s.db.prepare("SELECT artifact FROM tasks WHERE id='a'").get()!.artifact;
  s.db.prepare("UPDATE tasks SET artifact=? WHERE id='a'").run(s.artifact({ summary: "substitute" }));
  assert.throws(() => board.read(capsules[1]!, "shared"), /source binding/);
  s.db.prepare("UPDATE tasks SET artifact=? WHERE id='a'").run(original);
  const evidence = s.db.prepare("SELECT evidence FROM tasks WHERE id='a'").get()!.evidence;
  writeFileSync(join(s.root, "artifacts", `${evidence}.json`), "{}");
  assert.throws(() => board.read(capsules[1]!, "shared"), /integrity/);
}, enable));

test("finding digest obeys the admitted context envelope and preserves a recallable note", async () => fixture(async (s, cfg) => {
  const { capsules: [c] } = start(s, [task()]); const board = new CohortBoard(s, cfg);
  board.publish(c!, { ...note(), summary: "中".repeat(650) }, null);
  const page: any = board.read(c!, "cohort", 0, 20, 4096);
  assert.ok(Buffer.byteLength(canonical(page)) <= 1024); assert.equal(page.findings[0].summaryTruncated, true);
  assert.equal((board.journal.recall(c!, page.findings[0].findingReceipt, 0, 8192) as any).bytes > 1900, true);
}, enable));

test("driver tools publish after a patch, export on PASS and inform another cohort", async () => fixture(async (s, cfg) => {
  const api = scripted([
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    () => reply("", [{ name: "publish_finding", arguments: note() }]),
    () => reply("implemented"),
    body => { assert.match(body.messages[1].content, /adversarial/); return reply("", [{ name: "read_findings", arguments: { audience: "shared" } }]); },
    body => { assert.match(body.messages.at(-1).content, /TASK_CHECKS_PASSED/); assert.match(body.messages.at(-1).content, /UNVERIFIED/); return reply("reviewed"); },
  ]);
  const result: any = await runSwarm(s, [task("a"), { ...task("b", ["a"]), agent: "critic" }], signal(), undefined, api.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(api.bodies.length, 5);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM swarm_cohort_leases").get()!.n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM swarm_cohort_exports").get()!.n, 1);
  const status: any = swarmStatus(s, result.id);
  assert.equal(status.coordination.sharedExports, 1);
  assert.equal(status.coordination.cohorts.length, 2);
  assert.ok(status.coordination.cohorts.every((c: any) => c.activeExecutions === 0));
}, enable));

test("3,000 task instances use indexed bounded digests, without a live model claim", async () => fixture(async (s, cfg) => {
  const tasks = Array.from({ length: 3000 }, (_, i) => ({ ...task(`t${String(i).padStart(4, "0")}`), writeScope: [], readScope: [] }));
  const q = new Scheduler(s); const run = q.start(tasks); const board = new CohortBoard(s, cfg);
  for (let i = 0; i < tasks.length - 1; i++) {
    const l = q.claim(run, "synthetic")!; const c = q.capsule(l);
    board.publish(c, note(), null); accept(s, q, l, c, board);
  }
  const c = q.capsule(q.claim(run, "reader")!); const page: any = board.read(c, "shared", 0, 20);
  assert.ok(page.findings.length > 0 && page.findings.length <= 20); assert.equal(page.hasMore, true);
  assert.ok(Buffer.byteLength(canonical(page)) <= 4096);
  const plan = s.db.prepare("EXPLAIN QUERY PLAN SELECT seq FROM swarm_cohort_exports WHERE run=? AND seq>? ORDER BY seq LIMIT ?")
    .all(run, 0, 21).map(row => row.detail).join(" ");
  assert.match(plan, /SEARCH.*swarm_cohort_shared_page/);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM agent_requests").get()!.n, 0);
}, enable));
