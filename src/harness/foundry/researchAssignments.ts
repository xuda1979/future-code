import type { Store } from "./store.ts";
import { invariant } from "./kernel.ts";

/** Rebuildable projection of immutable task requirements. Status stays in tasks;
 * this index never owns dispatch, leases, acceptance or a second execution DAG. */
export function installResearchAssignments(store: Store): void {
  store.transaction(() => {
    const installed = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_assignments'").get();
    store.db.exec(`CREATE TABLE IF NOT EXISTS research_assignments(
      run TEXT NOT NULL, template TEXT NOT NULL, task TEXT NOT NULL, PRIMARY KEY(run,template,task));
      CREATE INDEX IF NOT EXISTS research_assignments_task ON research_assignments(run,task);
      CREATE TRIGGER IF NOT EXISTS research_assignments_insert AFTER INSERT ON tasks BEGIN
        INSERT OR IGNORE INTO research_assignments SELECT NEW.run,j.value,NEW.id
          FROM json_each(NEW.spec,'$.research') j WHERE j.type='text'; END;
      CREATE TRIGGER IF NOT EXISTS research_assignments_delete AFTER DELETE ON tasks BEGIN
        DELETE FROM research_assignments WHERE run=OLD.run AND task=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS research_assignments_update AFTER UPDATE OF spec,run,id ON tasks BEGIN
        DELETE FROM research_assignments WHERE run=OLD.run AND task=OLD.id;
        INSERT OR IGNORE INTO research_assignments SELECT NEW.run,j.value,NEW.id
          FROM json_each(NEW.spec,'$.research') j WHERE j.type='text'; END;`);
    if (!installed) store.db.exec(`INSERT OR IGNORE INTO research_assignments
      SELECT t.run,j.value,t.id FROM tasks t,json_each(t.spec,'$.research') j WHERE j.type='text'`);
  });
}

/** Explicit repair from authoritative tasks; no model transcript is required. */
export function rebuildResearchAssignments(store: Store, run: string): void {
  store.transaction(() => {
    invariant(store.db.prepare("SELECT 1 FROM runs WHERE id=?").get(run), "unknown research run");
    store.db.prepare("DELETE FROM research_assignments WHERE run=?").run(run);
    store.db.prepare(`INSERT INTO research_assignments SELECT t.run,j.value,t.id
      FROM tasks t,json_each(t.spec,'$.research') j WHERE t.run=? AND j.type='text'`).run(run);
    store.event("research.assignments.rebuilt", {}, run);
  });
}
