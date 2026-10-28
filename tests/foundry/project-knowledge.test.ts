import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { canonical, digest } from "../../src/harness/foundry/kernel.ts";
import { proposeClaim, adjudicateClaim, retractClaim } from "../../src/harness/foundry/claims.ts";
import { admitAdjudicationTask } from "../../src/harness/foundry/adjudication.ts";
import { requireAdmission, submitProposal } from "../../src/harness/foundry/proposals.ts";
import { SessionJournal } from "../../src/harness/foundry/swarm/session.ts";
import { SwarmDriver } from "../../src/harness/foundry/swarm/driver.ts";
import { recordDiagnostic } from "../../src/harness/foundry/swarm/diagnostics.ts";
import { failureMemory } from "../../src/harness/foundry/swarm/memory.ts";
import { ProjectKnowledge, KNOWLEDGE_NOTICE, type ExperienceInput, type KnowledgePack } from "../../src/harness/foundry/swarm/knowledge.ts";
import { validateSwarmSpec, type SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { validateToolProposal } from "../../src/harness/foundry/swarm/toolAdmission.ts";
import { runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import { handleSwarm } from "../../src/harness/foundry/swarm/cli.ts";
import type { Capsule, Json, Lease } from "../../src/harness/foundry/types.ts";
import { fixture, spec, task, scripted, reply, signal } from "./swarm-fixtures.ts";

const pack = (): KnowledgePack => ({ schema: 1, id: "expert-seeds", source: "Expert note with declared conditions",
  entries: [{ id: "baseline", kind: "procedure", trigger: "behavior src/a.txt", lesson: "Measure the baseline before making a change.",
    conditions: "Use the project's pinned behavior check; revalidate the method for new tasks.", phase: "any", tags: ["behavior", "src/a.txt", "跨领域"] }] });
function enable(s: SwarmSpec): void {
  s.projectKnowledge = { namespace: "project-one", maxCardsPerTask: 4, maxContextBytes: 4096, packs: [pack()] };
  s.agents.coder.tools.push("record_experience", "read_knowledge");
}
const experience = (id = "lesson"): ExperienceInput => ({ id, kind: "procedure", trigger: "behavior src/a.txt",
  lesson: "Inspect the input and run the configured check after a scoped correction.",
  conditions: "This fixture and its pinned check only; causal explanation remains unverified.",
  phase: "implementation", tags: ["behavior", "src/a.txt"], receipts: [] });
function start(s: Store) {
  const q = new Scheduler(s), run = q.start([task()]), lease = q.claim(run, "fixture")!;
  return { q, run, lease, c: q.capsule(lease) };
}
/** Synthetic trust-boundary fixture; runtime end-to-end tests below run real Git checks. */
function accept(s: Store, q: Scheduler, lease: Lease, c: Capsule, knowledge?: ProjectKnowledge,
  extra: Json = {}, onAccepted?: () => void): void {
  const artifact = { schema: 1, patchHash: s.artifact(""), summary: "synthetic", ...extra as any };
  const checks = s.contract().requiredChecks.map(id => ({ id, verdict: "PASS" }));
  if ((extra as any).claimJudgment) checks.push({ id: "claim-adjudication", verdict: "PASS" });
  const evidence = { contractHash: c.contractHash, recipeHash: c.recipeHash, verifierId: s.contract().verifierId,
    taskHash: digest(c.task), artifactHash: digest(artifact), verification: { artifactHash: digest(artifact), checks },
    metrics: { durationMs: 1, tokens: 0, costUsd: null } };
  assert.equal(q.finish(lease, artifact, evidence, { tokens: 0, costUsd: null }, Date.now(), (a, e) => {
    knowledge?.accepted(c, artifact, a, e); onAccepted?.();
  }), true);
}
const notice = (body: any): any => {
  const messages = body.messages.filter((m: any) => m.role === "user" && m.content.startsWith(KNOWLEDGE_NOTICE));
  assert.equal(messages.length, 1); return JSON.parse(messages[0].content.slice(KNOWLEDGE_NOTICE.length));
};

test("knowledge is opt-in, bounded, domain-neutral and rejects invented authority", async () => {
  const s = spec("/tmp/repo"); validateSwarmSpec(s);
  s.agents.coder.tools.push("record_experience"); assert.throws(() => validateSwarmSpec(s), /knowledge/);
  s.agents.coder.tools.pop(); enable(s); validateSwarmSpec(s);
  const wide = structuredClone(s); wide.projectKnowledge!.maxContextBytes = 16384;
  assert.throws(() => validateSwarmSpec(wide), /knowledge context/);
  const fake = structuredClone(s); (fake.projectKnowledge!.packs![0].entries[0] as any).verified = true;
  assert.throws(() => validateSwarmSpec(fake), /knowledge field/);
  const long = structuredClone(s); long.projectKnowledge!.packs![0].entries[0].lesson = "中".repeat(800);
  assert.throws(() => validateSwarmSpec(long), /byte bound/);
  await fixture(async (store, cfg) => {
    const driver = new SwarmDriver(store, cfg);
    assert.equal(driver.knowledge, null); assert.equal(driver.accepted, undefined);
    assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_knowledge_cards'").get(), undefined);
  });
});

test("packs are immutable, content-versioned, persistent and never promoted by attribution", async () => fixture(async (s, cfg) => {
  const knowledge = new ProjectKnowledge(s, cfg);
  const first: any = knowledge.importPack(pack()); const again: any = knowledge.importPack(pack());
  assert.deepEqual(first, again);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM project_knowledge_cards").get()!.n, 1);
  const changed = pack(); changed.entries[0].lesson = "A revised seed with different advice.";
  const second: any = knowledge.importPack(changed); assert.notEqual(second.version, first.version);
  assert.equal((knowledge.get(undefined, first.ids[0]) as any).lesson, pack().entries[0].lesson);
  assert.equal((knowledge.get(undefined, second.ids[0]) as any).trust, "EXPERT_SEED_UNVERIFIED");
  assert.throws(() => s.db.exec("UPDATE project_knowledge_cards SET phase='debugging'"), /append-only/);
  const other = await Store.open(s.root);
  try { assert.deepEqual(new ProjectKnowledge(other, cfg).search(undefined), knowledge.search(undefined)); }
  finally { other.close(); }
  const unrelated = structuredClone(cfg); unrelated.spec.project += "-different";
  assert.equal((new ProjectKnowledge(s, unrelated).search(undefined) as any).items.length, 0);
}, enable));

test("real R&D automatically stores failure/accepted transitions and reuses experience in another run", async () => fixture(async (s, cfg) => {
  const mock = scripted([
    body => {
      assert.equal(notice(body).items[0].trust, "EXPERT_SEED_UNVERIFIED");
      return reply("", [{ name: "run_check", arguments: { name: "behavior" } }]);
    },
    body => {
      assert.ok(notice(body).items.some((x: any) => x.trust === "OBSERVED_FAILURE_NOT_FALSIFICATION"));
      return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    () => reply("", [{ name: "record_experience", arguments: experience() }]),
    () => reply("ready"),
  ]);
  const first: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(first.status, "PASS"); assert.equal(mock.bodies.length, 4);
  const knowledge = new ProjectKnowledge(s, cfg), page: any = knowledge.search(undefined, { limit: 10 });
  assert.ok(page.items.some((x: any) => x.trust === "CHECKED_TRANSITION_NOT_CAUSAL_PROOF"));
  assert.ok(page.items.some((x: any) => x.trust === "UNVERIFIED_LESSON_ACCEPTED_SOURCE"));
  assert.ok(page.items.every((x: any) => x.trust !== "VALIDATED_CLAIM_WITH_CONDITIONS"));
  const transition = page.items.find((x: any) => x.kind === "transition");
  assert.equal((knowledge.get(undefined, transition.id) as any).evidence.rootCause, null);
  const failure = page.items.find((x: any) => x.kind === "failure");
  const fixtureHash = (knowledge.get(undefined, failure.id) as any).evidence.fixture;
  const later = scripted([
    body => {
      assert.ok(notice(body).items.some((x: any) => x.kind === "transition"));
      return reply("", [{ name: "read_knowledge", arguments: { id: failure.id } }]);
    },
    body => {
      const result = JSON.parse(body.messages.filter((m: any) => m.role === "tool").at(-1).content);
      assert.ok(result.knowledgeReceipt);
      return reply("", [{ name: "recall", arguments: { receipt: fixtureHash } }]);
    },
    body => {
      assert.match(body.messages.filter((m: any) => m.role === "tool").at(-1).content, /receipt not owned/);
      return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    () => reply("ready"),
  ]);
  const second: any = await runSwarm(s, [task()], signal(), undefined, later.fetcher);
  assert.equal(second.status, "PASS"); assert.equal(later.bodies.length, 4);
  assert.ok(s.db.prepare("SELECT COUNT(*) AS n FROM project_knowledge_uses WHERE run=?").get(second.id)!.n > 0);
}, enable));

test("failed/old-patch lessons remain local, while failure observations survive rejection", async () => fixture(async (s, cfg) => {
  const mock = scripted([
    () => reply("", [{ name: "record_experience", arguments: experience() }]),
    () => reply("", [{ name: "run_check", arguments: { name: "behavior" } }]),
    () => reply("ready"),
  ]);
  const result: any = await runSwarm(s, [task()], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "FAIL");
  const shared: any = new ProjectKnowledge(s, cfg).search(undefined, { limit: 10 });
  assert.ok(shared.items.some((i: any) => i.kind === "failure"));
  assert.ok(!shared.items.some((i: any) => ["experience", "transition"].includes(i.kind)));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM project_knowledge_exports").get()!.n, 0);
}, s => { enable(s); s.recipe.attempts = 1; }));

test("experience ids are replay-bound, own evidence, obey budgets and cannot widen tool authority", async () => fixture(async (s, cfg) => {
  const { q, lease, c } = start(s), knowledge = new ProjectKnowledge(s, cfg), journal = new SessionJournal(s, knowledge);
  const owned = journal.receipt(c, { observation: "raw evidence, not correctness" });
  const input = { ...experience(), receipts: [owned] };
  const first: any = knowledge.record(c, input, null);
  assert.equal((knowledge.record(c, input, null) as any).id, first.id);
  assert.throws(() => knowledge.record(c, { ...input, lesson: "rewritten" }, null), /drift/);
  assert.throws(() => knowledge.record(c, { ...experience("foreign"), receipts: ["f".repeat(64)] }, null), /unowned/);
  assert.throws(() => knowledge.record(c, { ...experience(), trust: "SUPPORTED" } as any, null), /knowledge field/);
  assert.throws(() => validateToolProposal(c, cfg, cfg.spec.agents.coder,
    { id: "bad", name: "record_experience", arguments: { ...experience(), status: "PASS" } as any }), /unexpected tool/);
  for (let i = 1; i < 4; i++) knowledge.record(c, experience(`lesson-${i}`), null);
  assert.throws(() => knowledge.record(c, experience("overflow"), null), /budget/);
  assert.equal(q.fail(lease, "fixture failure"), true);
  assert.throws(() => knowledge.record(c, input, null), /stale/);
}, enable));

test("failure recording is deduplicated and atomic with its source event and checkpoint", async () => fixture(async (s, cfg) => {
  const { c } = start(s), knowledge = new ProjectKnowledge(s, cfg), journal = new SessionJournal(s, knowledge);
  const t = journal.open(c, { history: [{ role: "user", content: "task" }], turns: 1, toolCalls: 0,
    patchHash: null, pending: null, output: null, feedbackHash: null, contextLimit: 8192 });
  const call = { id: "check", name: "run_check", arguments: { name: "behavior" } };
  const result = { code: 1, stderr: "private raw trace" }, receipt = journal.receipt(c, result);
  const f = recordDiagnostic(t, journal, cfg, call, result, receipt, null, true)!;
  const observe = knowledge.observe.bind(knowledge);
  knowledge.observe = (...args) => { observe(...args); throw new Error("simulated crash"); };
  assert.throws(() => journal.checkpoint(t, "tool.result", { memory: [failureMemory(f, 1)] }), /crash/);
  assert.equal(t.seq, 0); assert.equal(journal.page(c.runId, c.task.id).length, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM project_knowledge_cards WHERE kind='failure'").get()!.n, 0);
  knowledge.observe = observe;
  journal.checkpoint(t, "tool.result", { memory: [failureMemory(f, 1)] });
  journal.checkpoint(t, "tool.result", { memory: [failureMemory(f, 1)] });
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM project_knowledge_cards WHERE kind='failure'").get()!.n, 1);
  assert.doesNotMatch(canonical(knowledge.search(undefined)), /private raw trace/);
}, enable));

test("source acceptance and knowledge publication roll back together; superseded patch stays private", async () => fixture(async (s, cfg) => {
  const { q, lease, c } = start(s), knowledge = new ProjectKnowledge(s, cfg);
  const current: any = knowledge.record(c, experience(), null);
  const old: any = knowledge.record(c, experience("old"), s.artifact("obsolete patch"));
  assert.throws(() => accept(s, q, lease, c, knowledge, {}, () => { throw new Error("crash"); }), /crash/);
  assert.equal(s.db.prepare("SELECT status FROM tasks").get()!.status, "RUNNING");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM project_knowledge_exports").get()!.n, 0);
  accept(s, q, lease, c, knowledge);
  assert.equal((knowledge.get(undefined, current.id) as any).trust, "UNVERIFIED_LESSON_ACCEPTED_SOURCE");
  assert.throws(() => knowledge.get(undefined, old.id), /private/);
}, enable));

test("semantic promotion requires exact independent claim adjudication and withdrawal revokes its trust", async () => fixture(async (s, cfg) => {
  const { q, lease, c, run } = start(s), knowledge = new ProjectKnowledge(s, cfg);
  const input = experience(), payload = { id: "contextual-claim", statement: canonical({ lesson: input.lesson, conditions: input.conditions }),
    evidenceIds: [], dependencies: [] };
  const p = submitProposal(s, "CLAIM", payload, c, "fixture-model"); requireAdmission(s, p, () => {});
  const claim = proposeClaim(s, run, c.task.id, payload, p.id);
  assert.throws(() => knowledge.record(c, { ...input, id: "mismatch", lesson: "broader statement", claimId: claim.id }, null), /exact lesson/);
  const card: any = knowledge.record(c, { ...input, claimId: claim.id }, null);
  accept(s, q, lease, c, knowledge);
  assert.equal((knowledge.get(undefined, card.id) as any).trust, "UNVERIFIED_LESSON_ACCEPTED_SOURCE");
  const judge = { ...task("judge"), writeScope: [] };
  admitAdjudicationTask(s, run, c.task.id, "test-adjudication", judge);
  const judgmentLease = q.claim(run, "trusted-checker")!, judgmentCapsule = q.capsule(judgmentLease);
  accept(s, q, judgmentLease, judgmentCapsule, undefined, { claimJudgment: { claimId: claim.id, version: claim.version,
    statementHash: claim.statementHash, verdict: "SUPPORTED" } });
  const evidenceId = String(s.db.prepare("SELECT id FROM fabric_evidence WHERE run=? AND task=? AND source='foundry-independent-verifier'").get(run, judge.id)!.id);
  const supported = adjudicateClaim(s, run, claim.id, claim.version, evidenceId);
  assert.equal((knowledge.get(undefined, card.id) as any).trust, "VALIDATED_CLAIM_WITH_CONDITIONS");
  const later = start(s).c;
  assert.equal((knowledge.context(later, ["behavior"]) as any).items.find((i: any) => i.id === card.id).trust,
    "VALIDATED_CLAIM_WITH_CONDITIONS");
  retractClaim(s, run, claim.id, supported.version, "new contrary evidence");
  assert.equal((knowledge.get(undefined, card.id) as any).trust, "STALE_CLAIM_REVALIDATE");
  assert.equal((knowledge.context(later, ["behavior"]) as any).items.find((i: any) => i.id === card.id).trust,
    "STALE_CLAIM_REVALIDATE");
}, enable));

test("phase-aware literal retrieval has stable bounded UTF-8 pages and preserves contradictions", async () => fixture(async (s, cfg) => {
  const { q, lease, c } = start(s), knowledge = new ProjectKnowledge(s, cfg);
  const seed = (knowledge.search(undefined) as any).items[0];
  const proposal: any = knowledge.record(c, { ...experience(), contradicts: [seed.id] }, null);
  assert.equal((knowledge.search(undefined) as any).items[0].contested, undefined); // local proposal cannot contest shared seeds yet
  accept(s, q, lease, c, knowledge);
  const page: any = knowledge.search(undefined, { phase: "implementation", query: "behavior", limit: 10 });
  assert.ok(page.items.every((x: any) => ["implementation", "any"].includes(x.phase)));
  assert.ok(page.items.some((x: any) => x.id === seed.id && x.contested));
  assert.ok(page.items.some((x: any) => x.id === proposal.id && x.contested));
  const context: any = knowledge.context(start(s).c, ["behavior"]);
  assert.ok(context.items.some((x: any) => x.id === seed.id && x.contested && x.contradictions.includes(proposal.id)));
  assert.ok(context.items.some((x: any) => x.id === proposal.id && x.contested && x.contradictions.includes(seed.id)));
  const huge = pack(); huge.id = "utf8"; huge.entries = Array.from({ length: 12 }, (_, i) => ({ ...pack().entries[0], id: `seed-${i}`,
    lesson: "中文经验🐈".repeat(80), tags: ["utf8"], trigger: "utf8" }));
  knowledge.importPack(huge);
  const seen = new Set<string>(); let after = 0, hasMore: boolean;
  do {
    const next: any = knowledge.search(undefined, { query: "utf8", after, limit: 10 }, 1024);
    assert.ok(Buffer.byteLength(canonical(next)) <= 1024);
    for (const item of next.items) { assert.ok(!seen.has(item.id)); seen.add(item.id); assert.ok(item.trust); }
    after = next.nextAfter; hasMore = next.hasMore;
  } while (hasMore);
  assert.equal(seen.size, 12);
  assert.equal((knowledge.search(undefined, { query: "never-indexed" }) as any).items.length, 0);
  assert.throws(() => knowledge.search(undefined, { limit: 10000 }), /page/);
}, enable));

test("CLI imports/retirements are optional host actions and keep full history inspectable", async () => fixture(async (s, cfg, project) => {
  const imported = pack(); imported.id = "later-advice"; imported.entries[0].lesson = "New optional advice.";
  const path = join(project, "pack.json"); writeFileSync(path, JSON.stringify(imported));
  await assert.rejects(handleSwarm(["experience-import", "--root", s.root, "--spec", path]), /allow-exec/);
  const result: any = await handleSwarm(["experience-import", "--root", s.root, "--spec", path, "--allow-exec"]);
  const id = result.ids[0];
  assert.equal((await handleSwarm(["experience", "--root", s.root, "--hash", id]) as any).lesson, imported.entries[0].lesson);
  const exported: any = await handleSwarm(["experience-export", "--root", s.root, "--finding", "portable-method", "--hash", id]);
  assert.equal(exported.entries[0].id, `card-${id}`);
  const other = structuredClone(cfg); other.spec.project += "-unrelated";
  const destination = new ProjectKnowledge(s, other), restored: any = destination.importPack(exported);
  assert.equal((destination.get(undefined, restored.ids[0]) as any).trust, "EXPERT_SEED_UNVERIFIED");
  await handleSwarm(["experience-retire", "--root", s.root, "--hash", id, "--reason", "replaced by fresh evidence", "--allow-exec"]);
  const knowledge = new ProjectKnowledge(s, cfg);
  assert.ok(!(knowledge.search(undefined) as any).items.some((x: any) => x.id === id));
  assert.equal((knowledge.get(undefined, id) as any).trust, "DEPRECATED");
}, enable));

test("ranked context keeps five contradiction references in the minimum byte budget", async () => fixture(async (s, cfg) => {
  const { q, lease, c } = start(s), knowledge = new ProjectKnowledge(s, cfg);
  const target: any = knowledge.record(c, { ...experience("specific"), tags: ["behavior", "src/a.txt", "specific"],
    lesson: "Evidence must be read in context. ".repeat(50) }, null);
  const contradictions = [];
  for (let i = 0; i < 5; i++) contradictions.push((knowledge.record(c,
    { ...experience(`correction-${i}`), contradicts: [target.id] }, null) as any).id);
  accept(s, q, lease, c, knowledge);
  const context: any = knowledge.context(start(s).c, ["behavior", "specific"], "any", 1024);
  assert.ok(Buffer.byteLength(canonical(context)) <= 1024);
  assert.equal(context.items[0].id, target.id);
  assert.equal(context.items[0].contested, true);
  assert.deepEqual(new Set(context.items[0].contradictions), new Set(contradictions));
  assert.equal(context.items[0].trust, "UNVERIFIED_LESSON_ACCEPTED_SOURCE");
}, s => {
  enable(s); s.projectKnowledge!.namespace = "n".repeat(128); s.projectKnowledge!.maxCardsPerTask = 8;
}));

test("a saved model reply replays against its checkpoint even if knowledge arrives during a crash", async () => fixture(async (s, cfg) => {
  const { c } = start(s);
  const mock = scripted([
    () => reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]),
    body => { assert.ok(notice(body).items.some((i: any) => i.lesson === "Advice arrived while the request was interrupted.")); return reply("ready"); },
  ]);
  const driver = new SwarmDriver(s, cfg, mock.fetcher), checkpoint = driver.journal.checkpoint.bind(driver.journal);
  driver.journal.checkpoint = (t, kind, data) => { if (kind === "model.reply") throw new Error("crash before reply checkpoint"); checkpoint(t, kind, data); };
  await assert.rejects(driver.execute(c, signal()), /crash before reply/);
  assert.equal(mock.bodies.length, 1);
  const advice = pack(); advice.entries[0].lesson = "Advice arrived while the request was interrupted.";
  new ProjectKnowledge(s, cfg).importPack(advice);
  const resumed = new SwarmDriver(s, cfg, mock.fetcher), result = await resumed.execute(c, signal());
  assert.equal(mock.bodies.length, 2); // no duplicate external-model request
  assert.ok((await resumed.verify(c, result, signal())).checks.every(check => check.verdict === "PASS"));
}, enable));

test("corrupt evidence and a forged lexical index fail closed instead of becoming learned advice", async () => fixture(async (s, cfg) => {
  const knowledge = new ProjectKnowledge(s, cfg), seed = (knowledge.search(undefined) as any).items[0];
  s.db.prepare("INSERT INTO project_knowledge_terms VALUES(?,?,?)").run(knowledge.project, "forged-token", seed.id);
  assert.throws(() => knowledge.search(undefined, { query: "forged-token" }), /term index/);
  const { q, lease, c } = start(s), id = (knowledge.record(c, experience(), null) as any).id;
  accept(s, q, lease, c, knowledge);
  const row = s.db.prepare("SELECT evidence FROM project_knowledge_exports WHERE card=?").get(id)!;
  writeFileSync(join(s.root, "artifacts", `${row.evidence}.json`), JSON.stringify({ forged: true }));
  assert.throws(() => knowledge.get(undefined, id), /integrity/);
}, enable));
