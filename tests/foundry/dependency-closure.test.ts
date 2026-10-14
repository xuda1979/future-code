import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { orderedTasks } from "../../src/harness/foundry/swarm/workspace.ts";
import { fixture, task } from "./swarm-fixtures.ts";

test("scoped patch planning visits only its dependency and nested spawned-child closure", async t => fixture(async s => {
  const q = new Scheduler(s), run = q.start([
    task("base"), task("root", ["base"]), task("root.kid", ["base"]), task("root.kid.grand", ["base"]),
    task("unrelated"), task("unrelated.kid"),
  ]);
  // Projection fixture only: orderedTasks checks status, while readPatchArtifact
  // separately validates real acceptance evidence before any patch is applied.
  s.transaction(() => {
    s.db.prepare("UPDATE tasks SET status='PASS',artifact='fixture' WHERE run=?").run(run);
    const edge = s.db.prepare("INSERT INTO spawn_edges VALUES(?,?,?,?,?,?)");
    edge.run(run, "root", "root.kid", "one", 1, 1);
    edge.run(run, "root.kid", "root.kid.grand", "two", 2, 1);
    edge.run(run, "unrelated", "unrelated.kid", "three", 1, 1);
  });
  const prepare = s.db.prepare.bind(s.db), queries: string[] = [];
  t.mock.method(s.db, "prepare", (sql: string) => { queries.push(sql); return prepare(sql); });
  assert.deepEqual(orderedTasks(s, run, ["root"]).map(t => t.id), ["base", "root.kid.grand", "root.kid", "root"]);
  assert.ok(queries.filter(sql => sql.includes("FROM spawn_edges")).every(sql => sql.includes("parent=?")),
    "a scoped workspace must not read every spawned edge in its run");
  const children = queries.find(sql => sql.includes("FROM spawn_edges"))!;
  const plan = prepare("EXPLAIN QUERY PLAN " + children).all(run, "root");
  assert.ok(plan.some(row => /spawn_edges_parent.*run=.*parent=/.test(String(row.detail))),
    "child ordering must not make SQLite scan other parents");
  queries.length = 0;
  assert.deepEqual(orderedTasks(s, run, []), []); assert.equal(queries.length, 0);
  const all = orderedTasks(s, run).map(t => t.id);
  assert.equal(all.length, 6); assert.ok(all.indexOf("unrelated.kid") < all.indexOf("unrelated"));
  s.db.prepare("UPDATE tasks SET status='READY' WHERE run=? AND id='root.kid.grand'").run(run);
  assert.throws(() => orderedTasks(s, run, ["root"]), /unverified patch dependency/);
  assert.throws(() => orderedTasks(s, run, ["missing"]), /unverified patch dependency/);
}));
