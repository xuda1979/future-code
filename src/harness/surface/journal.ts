import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { SceneFrame, SurfaceBatch, SurfaceInterrupt, SurfaceResult } from "./protocol.ts";

export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Private, durable episodic memory. Store no cookies, credentials, raw typed
 * secrets or HTML here. Only one resident host may own a browser profile. */
export class SurfaceJournal {
  readonly db: DatabaseSync;
  readonly sessionId: string;
  constructor(root: string, sessionId: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.sessionId = sessionId;
    this.db = new DatabaseSync(join(root, "surface.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS actions(session TEXT,key TEXT,binding TEXT,state TEXT,result TEXT,PRIMARY KEY(session,key));
      CREATE TABLE IF NOT EXISTS episodes(id INTEGER PRIMARY KEY,session TEXT,kind TEXT,at REAL,value TEXT);
      CREATE TABLE IF NOT EXISTS sessions(session TEXT PRIMARY KEY,interrupt TEXT,paused_ms REAL NOT NULL DEFAULT 0);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS affordances(session TEXT,scope TEXT,role TEXT,name TEXT,verb TEXT,settle_ms REAL,samples INTEGER,
      PRIMARY KEY(session,scope,role,name,verb));`);
    this.db.prepare("INSERT OR IGNORE INTO sessions(session) VALUES(?)").run(sessionId);
  }
  start(key: string, input: unknown): { fresh: boolean; result?: SurfaceResult } {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw new Error("invalid surface action identity");
    const binding = hash(input), row = this.db.prepare("SELECT * FROM actions WHERE session=? AND key=?").get(this.sessionId, key);
    if (row) {
      if (row.binding !== binding) throw new Error("surface action payload drift");
      return { fresh: false, ...(row.result ? { result: JSON.parse(String(row.result)) } : {}) };
    }
    this.db.prepare("INSERT INTO actions VALUES(?,?,?,'DISPATCHING',NULL)").run(this.sessionId, key, binding);
    return { fresh: true };
  }
  inspect(key: string, input?: SurfaceBatch): SurfaceResult | null {
    const row = this.db.prepare("SELECT result,binding FROM actions WHERE session=? AND key=?").get(this.sessionId, key);
    if (row && input && row.binding !== hash(input)) throw new Error("surface inspect payload drift");
    return row?.result ? JSON.parse(String(row.result)) : null;
  }
  assertAction(key: string, input: SurfaceBatch): void {
    const row = this.db.prepare("SELECT binding FROM actions WHERE session=? AND key=?").get(this.sessionId, key);
    if (!row || row.binding !== hash(input)) throw new Error("unknown or changed surface reconciliation identity");
  }
  finish(key: string, result: SurfaceResult): void {
    this.episode("SURFACE_ACTION_RECEIPT", { key, result });
    this.db.prepare("UPDATE actions SET state='OBSERVED',result=? WHERE session=? AND key=?").run(JSON.stringify(result), this.sessionId, key);
  }
  episode(kind: string, value: unknown): void {
    this.db.prepare("INSERT INTO episodes(session,kind,at,value) VALUES(?,?,?,?)").run(this.sessionId, kind, Date.now(), JSON.stringify(value));
  }
  retire(frame: SceneFrame): void { this.episode("EPHEMERAL_SURFACE_STATE", frame); }
  interrupt(): SurfaceInterrupt | undefined {
    const row = this.db.prepare("SELECT interrupt FROM sessions WHERE session=?").get(this.sessionId);
    return row?.interrupt ? JSON.parse(String(row.interrupt)) : undefined;
  }
  pause(interrupt: SurfaceInterrupt): void {
    this.db.prepare("UPDATE sessions SET interrupt=? WHERE session=?").run(JSON.stringify(interrupt), this.sessionId);
    this.episode("INTERVENTION_MEMORY.interrupt", interrupt);
  }
  resume(frame: SceneFrame): void {
    const interrupt = this.interrupt();
    if (!interrupt) throw new Error("no pending surface intervention");
    this.db.prepare("UPDATE sessions SET interrupt=NULL,paused_ms=paused_ms+? WHERE session=?").run(Math.max(0, Date.now() - interrupt.since), this.sessionId);
    this.episode("INTERVENTION_MEMORY.resumed", { interrupt, afterFrameId: frame.frameId });
  }
  pausedMs(): number {
    const row = this.db.prepare("SELECT paused_ms FROM sessions WHERE session=?").get(this.sessionId)!;
    return Number(row.paused_ms) + (this.interrupt() ? Math.max(0, Date.now() - this.interrupt()!.since) : 0);
  }
  learn(scope: string, role: string, name: string, verb: string, settleMs: number): void {
    this.db.prepare(`INSERT INTO affordances VALUES(?,?,?,?,?,?,1) ON CONFLICT(session,scope,role,name,verb)
      DO UPDATE SET settle_ms=MAX(settle_ms,excluded.settle_ms),samples=samples+1`).run(this.sessionId, scope, role, name, verb, settleMs);
  }
  notes(scope: string): NonNullable<SurfaceResult["affordanceNotes"]> {
    return this.db.prepare("SELECT role,name,verb,settle_ms AS settleMs,samples FROM affordances WHERE session=? AND scope=? ORDER BY samples DESC LIMIT 8")
      .all(this.sessionId, scope).map(row => ({ ...row })) as unknown as NonNullable<SurfaceResult["affordanceNotes"]>;
  }
  close(): void { this.db.close(); }
}
