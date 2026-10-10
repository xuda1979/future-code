import type { Store } from "../store.ts";
import { invariant } from "../kernel.ts";

// Rebuildable projections of agent_requests. Empty task/fence=0 is the run total;
// real requests always have a nonempty task, including host recovery requests.
const columns = ["requests", "bytes", "tokens", "missing", "active", "done", "unknown"];
const runStatements = new WeakMap<Store, ReturnType<Store["db"]["prepare"]>>();
function values(row: "NEW" | "OLD"): string[] {
  return ["1", `${row}.bytes`, `COALESCE(${row}.tokens,0)`, `${row}.tokens IS NULL`,
    `${row}.status='ACTIVE'`, `${row}.status='DONE'`, `${row}.status='UNKNOWN'`];
}
function add(row: "NEW" | "OLD"): string {
  const contribution = values(row).join(",");
  return `INSERT INTO agent_request_totals(run,task,fence,${columns.join(",")})
    SELECT ${row}.run,'',0,${contribution}
    UNION ALL SELECT ${row}.run,${row}.task,${row}.fence,${contribution}
    WHERE 1 ON CONFLICT(run,task,fence) DO UPDATE SET
    ${columns.map(c => `${c}=${c}+excluded.${c}`).join(",")};`;
}
function subtract(): string {
  return `UPDATE agent_request_totals SET ${columns.map((c, i) => `${c}=${c}-(${values("OLD")[i]})`).join(",")}
    WHERE run=OLD.run AND ((task='' AND fence=0) OR (task=OLD.task AND fence=OLD.fence));`;
}

/** Rebuild once on upgrade or explicitly after repairing a derived index.
 * Counts include unknown, timed-out, speculative and late requests: no refund. */
export function rebuildRequestAccounting(store: Store): void {
  store.transaction(() => {
    store.db.exec(`DELETE FROM agent_request_totals;
      INSERT INTO agent_request_totals
      SELECT run,'',0,COUNT(*),SUM(bytes),SUM(COALESCE(tokens,0)),SUM(tokens IS NULL),
        SUM(status='ACTIVE'),SUM(status='DONE'),SUM(status='UNKNOWN')
      FROM agent_requests GROUP BY run;
      INSERT INTO agent_request_totals
      SELECT run,task,fence,COUNT(*),SUM(bytes),SUM(COALESCE(tokens,0)),SUM(tokens IS NULL),
        SUM(status='ACTIVE'),SUM(status='DONE'),SUM(status='UNKNOWN')
      FROM agent_requests GROUP BY run,task,fence;`);
    store.setMeta("extension.requestAccounting", 1);
  });
}
export function installRequestAccounting(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS agent_request_totals(
    run TEXT NOT NULL,task TEXT NOT NULL,fence INTEGER NOT NULL,
    requests INTEGER NOT NULL CHECK(requests>=0),bytes INTEGER NOT NULL CHECK(bytes>=0),
    tokens INTEGER NOT NULL CHECK(tokens>=0),missing INTEGER NOT NULL CHECK(missing>=0),
    active INTEGER NOT NULL CHECK(active>=0),done INTEGER NOT NULL CHECK(done>=0),unknown INTEGER NOT NULL CHECK(unknown>=0),
    PRIMARY KEY(run,task,fence));
    CREATE INDEX IF NOT EXISTS agent_requests_expiration ON agent_requests(status,deadline);
    CREATE TRIGGER IF NOT EXISTS agent_request_total_insert AFTER INSERT ON agent_requests BEGIN ${add("NEW")} END;
    CREATE TRIGGER IF NOT EXISTS agent_request_total_update AFTER UPDATE ON agent_requests BEGIN ${subtract()} ${add("NEW")} END;
    CREATE TRIGGER IF NOT EXISTS agent_request_total_delete AFTER DELETE ON agent_requests BEGIN ${subtract()} END;`);
  if (store.getMeta("extension.requestAccounting") !== 1) rebuildRequestAccounting(store);
}
export function runRequestTotals(store: Store, run: string): Record<string, number> {
  let statement = runStatements.get(store);
  if (!statement) {
    statement = store.db.prepare("SELECT requests,bytes,tokens,missing,active,done,unknown FROM agent_request_totals WHERE run=? AND task='' AND fence=0");
    runStatements.set(store, statement);
  }
  const row = statement.get(run);
  if (row) return row;
  invariant(!store.db.prepare("SELECT 1 FROM agent_requests WHERE run=? LIMIT 1").get(run),
    "REQUEST_ACCOUNTING_MISSING: rebuild the derived request totals before admitting work");
  return { requests: 0, bytes: 0, tokens: 0, missing: 0, active: 0, done: 0, unknown: 0 };
}
/** O(number of objective revisions), independent of request history size. */
export function objectiveRequestTotals(store: Store, objective: string): { requests: number; bytes: number } {
  const missing = store.db.prepare(`SELECT 1 FROM (
    SELECT run FROM swarm_objective_revisions WHERE objective=?
    UNION SELECT run FROM swarm_objectives WHERE id=? AND run IS NOT NULL
  ) lineage LEFT JOIN agent_request_totals t ON t.run=lineage.run AND t.task='' AND t.fence=0
  WHERE t.run IS NULL AND EXISTS(SELECT 1 FROM agent_requests r WHERE r.run=lineage.run) LIMIT 1`).get(objective, objective);
  invariant(!missing, "REQUEST_ACCOUNTING_MISSING: rebuild objective request totals before admitting work");
  return store.db.prepare(`SELECT COALESCE(SUM(requests),0) AS requests,COALESCE(SUM(bytes),0) AS bytes
    FROM agent_request_totals WHERE task='' AND fence=0 AND run IN (
      SELECT run FROM swarm_objective_revisions WHERE objective=?
      UNION SELECT run FROM swarm_objectives WHERE id=? AND run IS NOT NULL
    )`).get(objective, objective) as { requests: number; bytes: number };
}
