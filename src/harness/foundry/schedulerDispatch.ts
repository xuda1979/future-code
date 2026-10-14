import type { Store } from "./store.ts";

/** Rebuildable ordering hints, never execution authority. The transaction that
 * changes a task or allocation also changes the ordered dispatch index. */
export function installSchedulerDispatch(store: Store): void {
  store.transaction(() => {
    // The child suffix also satisfies ORDER BY child. Without it SQLite may
    // choose the run/child primary key and scan unrelated families to sort.
    const family = store.db.prepare("PRAGMA index_info(spawn_edges_parent)").all().map(r => String(r.name));
    if (family.join(",") !== "run,parent,child") store.db.exec(`
      DROP INDEX IF EXISTS spawn_edges_parent;
      CREATE INDEX spawn_edges_parent ON spawn_edges(run,parent,child);`);
    const columns = new Set(store.db.prepare("PRAGMA table_info(scheduler_nodes)").all().map(r => String(r.name)));
    const upgrade = !columns.has("dispatch_status") || !columns.has("allocation_score");
    if (!columns.has("dispatch_status")) store.db.exec("ALTER TABLE scheduler_nodes ADD COLUMN dispatch_status TEXT NOT NULL DEFAULT 'READY'");
    if (!columns.has("allocation_score")) store.db.exec("ALTER TABLE scheduler_nodes ADD COLUMN allocation_score REAL NOT NULL DEFAULT 0");
    if (upgrade) store.db.exec(`UPDATE scheduler_nodes SET
      dispatch_status=COALESCE((SELECT status FROM tasks WHERE run=scheduler_nodes.run AND id=scheduler_nodes.task),'MISSING'),
      allocation_score=COALESCE((SELECT score FROM fabric_allocations WHERE run=scheduler_nodes.run AND task=scheduler_nodes.task),0)`);
    store.db.exec(`
      CREATE INDEX IF NOT EXISTS scheduler_nodes_dispatch ON scheduler_nodes(
        run,dispatch_status,remaining,priority DESC,allocation_score DESC,rank DESC,task);
      CREATE INDEX IF NOT EXISTS scheduler_nodes_rank ON scheduler_nodes(run,rank DESC);
      CREATE TRIGGER IF NOT EXISTS scheduler_dispatch_task_update AFTER UPDATE OF status ON tasks
      BEGIN
        UPDATE scheduler_nodes SET dispatch_status=NEW.status WHERE run=NEW.run AND task=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS scheduler_dispatch_task_delete AFTER DELETE ON tasks
      BEGIN
        DELETE FROM scheduler_nodes WHERE run=OLD.run AND task=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS scheduler_dispatch_allocation_insert AFTER INSERT ON fabric_allocations
      BEGIN
        UPDATE scheduler_nodes SET allocation_score=NEW.score WHERE run=NEW.run AND task=NEW.task;
      END;
      CREATE TRIGGER IF NOT EXISTS scheduler_dispatch_allocation_update AFTER UPDATE OF score,run,task ON fabric_allocations
      BEGIN
        UPDATE scheduler_nodes SET allocation_score=0
          WHERE run=OLD.run AND task=OLD.task AND (OLD.run<>NEW.run OR OLD.task<>NEW.task);
        UPDATE scheduler_nodes SET allocation_score=NEW.score
          WHERE run=NEW.run AND task=NEW.task AND allocation_score<>NEW.score;
      END;
      CREATE TRIGGER IF NOT EXISTS scheduler_dispatch_allocation_delete AFTER DELETE ON fabric_allocations
      BEGIN
        UPDATE scheduler_nodes SET allocation_score=0 WHERE run=OLD.run AND task=OLD.task;
      END;
    `);
  });
}
