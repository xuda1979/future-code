import test from "node:test";
import assert from "node:assert/strict";
import { ProjectKnowledge, KNOWLEDGE_NOTICE, taskKnowledgeTerms, type KnowledgePack } from "../../src/harness/foundry/swarm/knowledge.ts";
import { runSwarm } from "../../src/harness/foundry/swarm/host.ts";
import type { SwarmSpec } from "../../src/harness/foundry/swarm/config.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { Store } from "../../src/harness/foundry/store.ts";
import { canonical } from "../../src/harness/foundry/kernel.ts";
import { fixture, task, scripted, reply, signal } from "./swarm-fixtures.ts";

function enable(s: SwarmSpec): void {
  s.projectKnowledge = { namespace: "selection", maxCardsPerTask: 8, maxContextBytes: 4096 };
  s.agents.coder.tools.push("read_knowledge", "record_experience");
}
function seed(id: string, tags: string[], lesson = `Advice for ${id}.`): KnowledgePack {
  return { schema: 1, id, source: "Selection regression fixture", entries: [{ id, kind: "reference",
    trigger: tags.join(" "), tags, lesson, conditions: "Revalidate with the pinned project check.", phase: "any" }] };
}
function lease(s: Store, goal: string) {
  const q = new Scheduler(s), run = q.start([{ ...task(), goal }]);
  return q.capsule(q.claim(run, "selection-fixture")!);
}

test("automatic context retrieves an older specific lesson behind forty newer broad matches", async () => fixture(async (s, cfg) => {
  const knowledge = new ProjectKnowledge(s, cfg);
  const target: any = knowledge.importPack(seed("calibration", ["calibration", "offset", "src/a.txt"]));
  for (let i = 0; i < 40; i++) knowledge.importPack(seed(`routine-${i}`, ["behavior"]));
  // Keep the chronological tool API as a useful negative control and browsing contract.
  const query = "calibration offset src/a.txt src behavior";
  assert.ok(!(knowledge.search(undefined, { query, limit: 3 }) as any).items.some((i: any) => i.id === target.ids[0]));
  let firstContext: any;
  const mock = scripted([
    body => {
      const message = body.messages.find((m: any) => m.role === "user" && m.content.startsWith(KNOWLEDGE_NOTICE));
      firstContext = JSON.parse(message.content.slice(KNOWLEDGE_NOTICE.length));
      return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    () => reply("ready"),
  ]);
  const result: any = await runSwarm(s, [{ ...task(), goal: "Correct the calibration offset." }], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(mock.bodies.length, 2);
  assert.equal(firstContext.items[0].id, target.ids[0]);
  assert.equal(firstContext.items[0].trust, "EXPERT_SEED_UNVERIFIED");
}, enable));

test("query terms give every source space, deduplicate and remain bounded", async () => fixture(async (s) => {
  const c = lease(s, Array.from({ length: 80 }, (_, i) => `goal${i}`).join(" "));
  c.task.writeScope = Array.from({ length: 40 }, (_, i) => `write/${i}`);
  c.task.readScope = Array.from({ length: 40 }, (_, i) => `read/${i}`);
  const terms = taskKnowledgeTerms(c, ["check-name", "goal0", "check-name"]);
  assert.equal(terms.length, 32); assert.equal(new Set(terms).size, terms.length);
  for (const term of ["goal0", "write/0", "read/0", "check-name"]) assert.ok(terms.includes(term));
}, enable));

test("selection adds complementary evidence before more cards covering the same terms", async () => fixture(async (s, cfg) => {
  const knowledge = new ProjectKnowledge(s, cfg), c = lease(s, "alpha beta gamma delta");
  const complementary: any = knowledge.importPack(seed("complementary", ["delta"]));
  const redundant: string[] = [];
  for (let i = 0; i < 3; i++) redundant.push((knowledge.importPack(seed(`overlap-${i}`, ["alpha", "beta", "gamma"])) as any).ids[0]);
  const context: any = knowledge.context(c, []);
  assert.equal(context.items[0].id, redundant[2]);
  assert.equal(context.items[1].id, complementary.ids[0]);
  assert.equal(context.items[2].id, redundant[1]);
  // Explicit search is still a stable chronological page, including after an insert.
  const first: any = knowledge.search(c, { query: c.task.goal, limit: 2 });
  knowledge.importPack(seed("arrived-later", ["alpha"]));
  const next: any = knowledge.search(c, { query: c.task.goal, limit: 2, after: first.nextAfter });
  assert.deepEqual(next.items.map((i: any) => i.id), [redundant[0], complementary.ids[0]]);
  assert.equal(next.hasMore, false);
}, enable));

test("privacy, retirement, project and phase filters apply before the ranked candidate limit", async () => fixture(async (s, cfg) => {
  const knowledge = new ProjectKnowledge(s, cfg), c = lease(s, "alpha beta gamma delta");
  const shared: any = knowledge.importPack(seed("shared", ["alpha"]));
  const privateInput = { id: "private", kind: "hypothesis" as const, trigger: "alpha beta gamma delta",
    tags: ["alpha", "beta", "gamma", "delta"], lesson: "Private unaccepted research.", conditions: "This task only.", phase: "any" as const, receipts: [] };
  const own: any = knowledge.record(c, privateInput, null);
  const foreign = lease(s, c.task.goal), hidden: any = knowledge.record(foreign, privateInput, null);
  const elsewhere = structuredClone(cfg); elsewhere.spec.project += "-elsewhere";
  new ProjectKnowledge(s, elsewhere).importPack(seed("other-project", privateInput.tags));
  for (let i = 0; i < 34; i++) {
    const wrongPhase = seed(`research-${i}`, privateInput.tags); wrongPhase.entries[0].phase = "research";
    knowledge.importPack(wrongPhase);
    const retired: any = knowledge.importPack(seed(`retired-${i}`, privateInput.tags));
    knowledge.retire(retired.ids[0], "Retired fixture.");
  }
  const context: any = knowledge.context(c, [], "debugging");
  assert.deepEqual(context.items.map((i: any) => i.id), [own.id, shared.ids[0]]);
  assert.equal(context.items[0].trust, "UNVERIFIED_LOCAL_HYPOTHESIS");
  assert.equal(context.selection.candidatesExamined, 2);
  assert.ok(!canonical(context).includes(hidden.id));
  assert.equal(s.db.prepare("SELECT 1 FROM project_knowledge_uses WHERE run=? AND card=?").get(c.runId, hidden.id), undefined);
}, enable));

test("candidate metadata is capped, only selected sources are opened, and reopening preserves selection", async () => fixture(async (s, cfg) => {
  const knowledge = new ProjectKnowledge(s, cfg), c = lease(s, "alpha");
  const ids = new Set<string>();
  for (let i = 0; i < 80; i++) ids.add((knowledge.importPack(seed(`history-${i}`, ["alpha"])) as any).ids[0]);
  const read = s.readArtifact.bind(s), opened: string[] = [];
  s.readArtifact = id => { if (ids.has(id)) opened.push(id); return read(id); };
  const context: any = knowledge.context(c, []);
  assert.equal(context.items.length, 3); assert.equal(opened.length, 3);
  assert.equal(context.selection.candidatesExamined, 32);
  assert.equal(context.selection.candidateLimitReached, true);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM project_knowledge_uses WHERE run=?").get(c.runId)!.n, 3);
  const reopened = await Store.open(s.root);
  try { assert.deepEqual(new ProjectKnowledge(reopened, cfg).context(c, []), context); }
  finally { reopened.close(); }
}, enable));

test("UTF-8 byte bounds retain exact references and trust when previews do not fit", async () => fixture(async (s, cfg) => {
  const knowledge = new ProjectKnowledge(s, cfg), c = lease(s, "alpha");
  for (let i = 0; i < 4; i++) knowledge.importPack(seed(`long-${i}`, ["alpha"], "中文经验🐈".repeat(120)));
  const context: any = knowledge.context(c, [], "any", 1024);
  assert.ok(Buffer.byteLength(canonical(context)) <= 1024);
  assert.ok(context.items.length > 0 && context.items.length <= 3);
  for (const item of context.items) {
    assert.equal(item.previewOmitted, true); assert.equal(item.lesson, undefined);
    assert.equal(item.trust, "EXPERT_SEED_UNVERIFIED");
    assert.equal((knowledge.get(c, item.id) as any).lesson, "中文经验🐈".repeat(120));
  }
  assert.throws(() => knowledge.context(c, [], "any", 1023), /budget/);
  assert.throws(() => knowledge.context(c, [], "invented" as any), /phase/);
}, enable));

test("forged term identities fail closed even when the match count stays the same", async () => fixture(async (s, cfg) => {
  const knowledge = new ProjectKnowledge(s, cfg), c = lease(s, "alpha beta");
  const imported: any = knowledge.importPack(seed("indexed", ["alpha"]));
  s.db.prepare("DELETE FROM project_knowledge_terms WHERE project=? AND card=?").run(knowledge.project, imported.ids[0]);
  s.db.prepare("INSERT INTO project_knowledge_terms VALUES(?,?,?)").run(knowledge.project, "beta", imported.ids[0]);
  assert.throws(() => knowledge.context(c, []), /term index differs/);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM project_knowledge_uses").get()!.n, 0);
}, enable));

test("unmatched tasks receive no arbitrary fallback cards and stale leases cannot retrieve", async () => fixture(async (s, cfg) => {
  const knowledge = new ProjectKnowledge(s, cfg), c = lease(s, "different");
  knowledge.importPack(seed("unrelated", ["alpha"]));
  assert.equal((knowledge.context(c, []) as any).items.length, 0);
  c.fence++;
  assert.throws(() => knowledge.context(c, []), /stale knowledge lease/);
}, enable));

test("long goals cannot displace scope and check terms from automatic retrieval", async () => fixture(async (s, cfg) => {
  const knowledge = new ProjectKnowledge(s, cfg);
  const target: any = knowledge.importPack(seed("scoped", ["src/a.txt", "behavior"]));
  for (let i = 0; i < 4; i++) knowledge.importPack(seed(`broad-${i}`, ["background"]));
  let firstContext: any;
  const mock = scripted([
    body => {
      const message = body.messages.find((m: any) => m.role === "user" && m.content.startsWith(KNOWLEDGE_NOTICE));
      firstContext = JSON.parse(message.content.slice(KNOWLEDGE_NOTICE.length));
      return reply("", [{ name: "write_file", arguments: { path: "src/a.txt", content: "42\n" } }]);
    },
    () => reply("ready"),
  ]);
  const result: any = await runSwarm(s, [{ ...task(), goal: `${"background ".repeat(80)}Implement the requested change.` }], signal(), undefined, mock.fetcher);
  assert.equal(result.status, "PASS"); assert.equal(mock.bodies.length, 2);
  assert.equal(firstContext.items[0].id, target.ids[0]);
}, enable));
