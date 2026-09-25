import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { canonical, digest, invariant, validateContract, validateRecipe } from "./kernel.ts";
import type { Contract, Json, Recipe, PinnedCommand } from "./types.ts";

// Runtime-selected built-ins: Bun has bun:sqlite; Node >=22.13 has node:sqlite.
// Keep this module free of a new npm dependency and of engine-specific TS types.
type Row = Record<string, any>;
type Statement = { run(...args: any[]): any; get(...args: any[]): Row | undefined; all(...args: any[]): Row[] };
type DB = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };
export class Store {
  readonly root: string;
  readonly db: DB;
  private constructor(root: string, db: DB) { this.root = root; this.db = db; }
  static async open(root: string): Promise<Store> {
    root = resolve(root); mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "artifacts"), { recursive: true, mode: 0o700 });
    const engine = (globalThis as any).Bun ? "bun:sqlite" : "node:sqlite";
    const sqlite = await import(engine);
    const db: DB = engine === "bun:sqlite" ? new sqlite.Database(join(root, "state.sqlite"), { create: true }) : new sqlite.DatabaseSync(join(root, "state.sqlite"));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recipes(hash TEXT PRIMARY KEY, parent TEXT, json TEXT NOT NULL, admitted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, recipe TEXT NOT NULL, contract TEXT NOT NULL, started REAL NOT NULL, ended REAL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(run TEXT NOT NULL, id TEXT NOT NULL, spec TEXT NOT NULL, status TEXT NOT NULL, fence INTEGER NOT NULL DEFAULT 0, owner TEXT, deadline REAL, artifact TEXT, evidence TEXT, error TEXT, PRIMARY KEY(run,id));
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(run,status);
      CREATE TABLE IF NOT EXISTS attempts(run TEXT NOT NULL, task TEXT NOT NULL, fence INTEGER NOT NULL, started REAL NOT NULL, ended REAL, status TEXT NOT NULL, tokens REAL, cost REAL, duration REAL, PRIMARY KEY(run,task,fence));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, kind TEXT NOT NULL, run TEXT, task TEXT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempt_telemetry(run TEXT NOT NULL, task TEXT NOT NULL, fence INTEGER NOT NULL,
        context_bytes INTEGER, progress_count INTEGER NOT NULL DEFAULT 0, last_progress_at REAL, failure_fingerprint TEXT,
        PRIMARY KEY(run,task,fence));
      CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY, json TEXT NOT NULL, hash TEXT NOT NULL, promoted INTEGER NOT NULL DEFAULT 0);`);
    return new Store(root, db);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      invariant(!(result && typeof (result as any).then === "function"), "async work inside transaction is forbidden");
      this.db.exec("COMMIT"); return result;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  getMeta<T>(key: string): T | undefined {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key); return r ? JSON.parse(r.value) : undefined;
  }
  setMeta(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, canonical(value));
  }
  event(kind: string, payload: unknown, run: string | null = null, task: string | null = null): void {
    this.db.prepare("INSERT INTO events(at,kind,run,task,payload) VALUES(?,?,?,?,?)").run(Date.now(), kind, run, task, canonical(payload));
  }
  initialize(contract: Contract, recipe: Recipe, commands?: { worker: PinnedCommand; checker: PinnedCommand }, extensions: Record<string, Json> = {}): string {
    validateContract(contract); validateRecipe(contract, recipe);
    canonical(extensions);
    invariant(Object.keys(extensions).every(k => k.startsWith("extension.")), "reserved metadata key");
    if (commands) invariant(digest(commands.worker) === contract.workerId && digest(commands.checker) === contract.verifierId, "adapter identity mismatch");
    return this.transaction(() => {
      invariant(!this.getMeta("contract"), "already initialized; contracts cannot be overwritten");
      const hash = digest(recipe);
      if (commands) this.setMeta("commands", commands);
      for (const [key, value] of Object.entries(extensions)) this.setMeta(key, value);
      this.setMeta("contract", contract); this.setMeta("contractHash", digest(contract)); this.setMeta("active", hash);
      this.db.prepare("INSERT INTO recipes(hash,parent,json,admitted) VALUES(?,NULL,?,1)").run(hash, canonical(recipe));
      this.event("harness.created", { contractHash: digest(contract), recipeHash: hash }); return hash;
    });
  }
  contract(): Contract {
    const c = this.getMeta<Contract>("contract"); invariant(c, "not initialized"); validateContract(c);
    invariant(digest(c) === this.getMeta("contractHash"), "contract integrity failure"); return c;
  }
  active(): string { const h = this.getMeta<string>("active"); invariant(h, "not initialized"); return h; }
  recipe(hash = this.active()): Recipe {
    const row = this.db.prepare("SELECT json FROM recipes WHERE hash=?").get(hash); invariant(row, "unknown recipe");
    const p = JSON.parse(row.json); invariant(digest(p) === hash, "recipe integrity failure"); validateRecipe(this.contract(), p); return p;
  }
  propose(changes: Partial<Recipe>): string {
    return this.transaction(() => {
      const parent = this.active(); const candidate = { ...this.recipe(parent), ...changes };
      validateRecipe(this.contract(), candidate); const hash = digest(candidate);
      invariant(hash !== parent, "no-op candidate");
      const old = this.db.prepare("SELECT parent FROM recipes WHERE hash=?").get(hash);
      invariant(!old || old.parent === parent, "candidate exists under another parent; evaluate a fresh configuration");
      this.db.prepare("INSERT OR IGNORE INTO recipes(hash,parent,json) VALUES(?,?,?)").run(hash, parent, canonical(candidate));
      this.event("candidate.proposed", { parent, hash, changes }); return hash;
    });
  }
  artifact(value: Json): string {
    const text = canonical(value); const hash = digest(value); const path = join(this.root, "artifacts", `${hash}.json`);
    const temporary = join(this.root, "artifacts", `.pending-${randomUUID()}`);
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      // Link publishes only complete bytes and never overwrites an existing hash.
      try { linkSync(temporary, path); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      invariant(digest(JSON.parse(readFileSync(path, "utf8"))) === hash, "artifact integrity failure");
      if (process.platform !== "win32") {
        const dir = openSync(join(this.root, "artifacts"), "r");
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
    } finally { unlinkSync(temporary); }
    return hash;
  }
  readArtifact(hash: string): Json {
    invariant(/^[a-f0-9]{64}$/.test(hash), "invalid artifact id");
    const value = JSON.parse(readFileSync(join(this.root, "artifacts", `${hash}.json`), "utf8"));
    invariant(digest(value) === hash, "artifact integrity failure"); return value;
  }
  events(after = 0, limit = 100): Row[] {
    invariant(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 1000, "invalid event page");
    return this.db.prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?").all(after, limit).map(r => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  close(): void { this.db.close(); }
}
