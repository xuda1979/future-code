import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/harness/foundry/store.ts";
import { Scheduler } from "../../src/harness/foundry/scheduler.ts";
import { readyCandidates, rebuildSchedulerIndex } from "../../src/harness/foundry/schedulerIndex.ts";
import { fixture, task } from "./swarm-fixtures.ts";

const reference = `SELECT t.id,t.spec,t.fence,n.priority,n.rank,n.budget
  FROM scheduler_nodes n JOIN tasks t ON t.run=n.run AND t.id=n.task
  LEFT JOIN task_waits w ON w.run=t.run AND w.task=t.id
  LEFT JOIN fabric_allocations a ON a.run=t.run AND a.task=t.id
  WHERE n.run=? AND n.remaining=0 AND t.status='READY' AND (w.wake IS NULL OR w.wake<=?)
  ORDER BY n.priority DESC,COALESCE(a.score,0) DESC,n.rank DESC,t.id LIMIT ? OFFSET ?`;

test("indexed dispatch preserves priority, allocation, rank, waits, and pagination across state transitions", async () => fixture(async (s, cfg) => {
  const q = new Scheduler(s), run = q.start([
    { ...task("urgent"), priority: 100 }, task("a"), task("b"), task("child", ["a"]), task("delayed"), task("retired"),
  ]), now = Date.now();
  s.transaction(() => {
    s.db.prepare("UPDATE fabric_allocations SET score=1000 WHERE run=? AND task='b'").run(run);
    s.db.prepare("UPDATE tasks SET status='PASS' WHERE run=? AND id='retired'").run(run);
    s.db.prepare("INSERT INTO task_waits VALUES(?,?,?,'provider','later')").run(run, "delayed", now + 1000);
  });
  const compare = () => {
    for (const at of [now, now + 2000]) for (const offset of [0, 1, 3]) {
      const expected = s.db.prepare(reference).all(run, at, 2, offset).map(row => ({ ...row }));
      assert.deepEqual(readyCandidates(s, run, at, 2, offset), expected);
    }
  };
  compare();
  assert.deepEqual(readyCandidates(s, run, now, 10).map(r => r.id), ["urgent", "b", "a"]);
  assert.throws(() => s.transaction(() => {
    s.db.prepare("UPDATE tasks SET status='RUNNING' WHERE run=? AND id='a'").run(run);
    s.db.prepare("UPDATE fabric_allocations SET score=-1000 WHERE run=? AND task='b'").run(run);
    throw new Error("rollback");
  }), /rollback/);
  compare();
  const second = await Store.open(s.root);
  try {
    second.transaction(() => {
      second.db.prepare("UPDATE tasks SET status='RUNNING' WHERE run=? AND id='a'").run(run);
      second.db.prepare("DELETE FROM fabric_allocations WHERE run=? AND task='b'").run(run);
    });
    compare();
    rebuildSchedulerIndex(s, run, cfg.spec.recipe);
    compare();
  } finally { second.close(); }
}));

test("the actual candidate query uses ordered index traversal without sorting the ready set", async t => fixture(async s => {
  const q = new Scheduler(s), run = q.start([task("a"), task("b")]);
  const prepare = s.db.prepare.bind(s.db), queries: string[] = [];
  t.mock.method(s.db, "prepare", (sql: string) => { queries.push(sql); return prepare(sql); });
  readyCandidates(s, run, Date.now(), 1);
  const query = queries.find(sql => sql.includes("t.fence") && sql.includes("ORDER BY"))!;
  assert.ok(query, "observe the production candidate query");
  const plan = prepare("EXPLAIN QUERY PLAN " + query).all(run, Date.now(), 1, 0).map(row => String(row.detail));
  assert.ok(plan.some(line => /scheduler_nodes_dispatch.*run=.*dispatch_status=.*remaining=/.test(line)), plan.join("\n"));
  assert.ok(plan.every(line => !/TEMP B-TREE|SCAN n\b/.test(line)), plan.join("\n"));
  const ranks = prepare("EXPLAIN QUERY PLAN SELECT MAX(rank) FROM scheduler_nodes WHERE run=?").all(run);
  assert.ok(ranks.some(row => String(row.detail).includes("scheduler_nodes_rank")), "allocation normalization has a rank index");
}));

test("legacy stores backfill dispatch status and allocation scores and keep resumable state", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-upgrade-"));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(root, "state.sqlite"));
  db.exec(`CREATE TABLE tasks(run TEXT NOT NULL,id TEXT NOT NULL,spec TEXT NOT NULL,status TEXT NOT NULL,
    fence INTEGER NOT NULL DEFAULT 0,owner TEXT,deadline REAL,artifact TEXT,evidence TEXT,error TEXT,PRIMARY KEY(run,id));
    CREATE TABLE scheduler_nodes(run TEXT NOT NULL,task TEXT NOT NULL,remaining INTEGER NOT NULL,
    priority REAL NOT NULL,rank REAL NOT NULL,budget INTEGER NOT NULL,PRIMARY KEY(run,task));
    CREATE TABLE fabric_allocations(run TEXT NOT NULL,task TEXT NOT NULL,criticality REAL NOT NULL,
    uncertainty REAL NOT NULL,evidence_strength REAL NOT NULL,experience_yield REAL NOT NULL,novelty REAL NOT NULL,
    repeated_failure REAL NOT NULL,resource_spent REAL NOT NULL,score REAL NOT NULL,updated REAL NOT NULL,PRIMARY KEY(run,task));
    CREATE TABLE spawn_edges(run TEXT NOT NULL,parent TEXT NOT NULL,child TEXT NOT NULL,request_key TEXT NOT NULL,
      depth INTEGER NOT NULL,created REAL NOT NULL,PRIMARY KEY(run,child));
    CREATE INDEX spawn_edges_parent ON spawn_edges(run,parent);
    INSERT INTO tasks(run,id,spec,status,fence) VALUES('old','ready','{}','READY',7),('old','done','{}','PASS',2);
    INSERT INTO scheduler_nodes VALUES('old','ready',0,0,1,4096),('old','done',0,0,1,4096);
    INSERT INTO fabric_allocations VALUES('old','ready',0,0,0,0,0,0,0,8,1);`);
  db.close();
  const store = await Store.open(root);
  try {
    assert.deepEqual(readyCandidates(store, "old", Date.now(), 2).map(row => [row.id, row.fence]), [["ready", 7]]);
    assert.equal(store.db.prepare("SELECT allocation_score FROM scheduler_nodes WHERE run='old' AND task='ready'").get()!.allocation_score, 8);
    assert.equal(store.db.prepare("SELECT status,fence FROM tasks WHERE run='old' AND id='done'").get()!.status, "PASS");
    assert.deepEqual(store.db.prepare("PRAGMA index_info(spawn_edges_parent)").all().map(row => row.name), ["run", "parent", "child"]);
    const reopened = await Store.open(root);
    try { assert.equal(readyCandidates(reopened, "old", Date.now(), 2).length, 1); }
    finally { reopened.close(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
