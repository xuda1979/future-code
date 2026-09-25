import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { canonical, digest, invariant } from "../kernel.ts";
import { FatalAttemptError } from "../errors.ts";
import { Store } from "../store.ts";
import type { Capsule, Json, Verification } from "../types.ts";
import type { Call, Message } from "./context.ts";
import type { SwarmBudget } from "./config.ts";

export interface PatchArtifact { schema: 1; patchHash: string; summary: string }
export interface ThreadState {
  history: Message[];
  turns: number;
  toolCalls: number;
  patchHash: string | null;
  pending: Call | null;
  output: PatchArtifact | null;
  feedbackHash: string | null;
}
export interface Thread { capsule: Capsule; seq: number; state: ThreadState }
const json = (value: unknown): Json => JSON.parse(canonical(value));

/** Same Foundry database and artifact store, not a second scheduler. */
export class SessionJournal {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_threads(run TEXT NOT NULL, task TEXT NOT NULL, binding TEXT NOT NULL,
        fence INTEGER NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(run,task));
      CREATE TABLE IF NOT EXISTS agent_events(run TEXT NOT NULL, task TEXT NOT NULL, seq INTEGER NOT NULL,
        at REAL NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run,task,seq));
      CREATE TRIGGER IF NOT EXISTS agent_events_immutable_update BEFORE UPDATE ON agent_events BEGIN SELECT RAISE(ABORT,'append-only agent events'); END;
      CREATE TRIGGER IF NOT EXISTS agent_events_immutable_delete BEFORE DELETE ON agent_events BEGIN SELECT RAISE(ABORT,'append-only agent events'); END;
      CREATE TABLE IF NOT EXISTS agent_receipts(run TEXT NOT NULL, task TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(run,task,hash));
      CREATE TABLE IF NOT EXISTS agent_feedback(run TEXT NOT NULL, task TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(run,task));
      CREATE TABLE IF NOT EXISTS agent_requests(id TEXT PRIMARY KEY, run TEXT NOT NULL, task TEXT NOT NULL,
        fence INTEGER NOT NULL, provider TEXT NOT NULL, bytes INTEGER NOT NULL, request TEXT NOT NULL,
        started REAL NOT NULL, deadline REAL NOT NULL, status TEXT NOT NULL, tokens INTEGER, response TEXT);
      CREATE INDEX IF NOT EXISTS agent_requests_run ON agent_requests(run,task,fence);
      CREATE INDEX IF NOT EXISTS agent_requests_live ON agent_requests(provider,status,deadline);
      CREATE TABLE IF NOT EXISTS agent_replies(run TEXT NOT NULL, task TEXT NOT NULL, step INTEGER NOT NULL, body TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(run,task,step));
      CREATE TABLE IF NOT EXISTS agent_cooldowns(provider TEXT PRIMARY KEY, until_ms REAL NOT NULL);
    `);
  }
  assertLease(c: Capsule, now = Date.now()): void {
    const task = this.store.db.prepare("SELECT status,fence,deadline FROM tasks WHERE run=? AND id=?").get(c.runId, c.task.id);
    const run = this.store.db.prepare("SELECT recipe,contract FROM runs WHERE id=?").get(c.runId);
    invariant(task?.status === "RUNNING" && task.fence === c.fence && task.deadline > now &&
      run?.recipe === c.recipeHash && run?.contract === c.contractHash, "stale agent lease");
  }
  open(c: Capsule, initial: ThreadState): Thread {
    const binding = digest({ task: c.task, dependencies: c.dependencies, contract: c.contractHash, recipe: c.recipeHash });
    const hash = this.store.artifact(json(initial));
    return this.store.transaction(() => {
      this.assertLease(c);
      const row = this.store.db.prepare("SELECT * FROM agent_threads WHERE run=? AND task=?").get(c.runId, c.task.id);
      if (row) {
        invariant(row.binding === binding, "thread input binding changed");
        invariant(row.fence <= c.fence, "thread fence regression");
        this.store.db.prepare("UPDATE agent_threads SET fence=? WHERE run=? AND task=?").run(c.fence, c.runId, c.task.id);
        return { capsule: c, seq: row.seq, state: this.store.readArtifact(row.state) as unknown as ThreadState };
      }
      this.store.db.prepare("INSERT INTO agent_threads VALUES(?,?,?,?,0,?)").run(c.runId, c.task.id, binding, c.fence, hash);
      return { capsule: c, seq: 0, state: initial };
    });
  }
  checkpoint(t: Thread, kind: string, payload: unknown): void {
    this.assertLease(t.capsule);
    const state = this.store.artifact(json(t.state)); const data = this.store.artifact(json(payload));
    this.store.transaction(() => {
      const c = t.capsule; this.assertLease(c);
      const row = this.store.db.prepare("SELECT seq,fence FROM agent_threads WHERE run=? AND task=?").get(c.runId, c.task.id);
      invariant(row?.seq === t.seq && row?.fence === c.fence, "stale thread checkpoint");
      this.store.db.prepare("INSERT INTO agent_events VALUES(?,?,?,?,?,?)").run(c.runId, c.task.id, t.seq + 1, Date.now(), kind, data);
      this.store.db.prepare("UPDATE agent_threads SET seq=?,state=? WHERE run=? AND task=?").run(t.seq + 1, state, c.runId, c.task.id);
    });
    t.seq++;
  }
  receipt(c: Capsule, value: Json): string {
    this.assertLease(c); const hash = this.store.artifact(value);
    this.store.transaction(() => {
      this.assertLease(c);
      this.store.db.prepare("INSERT OR IGNORE INTO agent_receipts VALUES(?,?,?)").run(c.runId, c.task.id, hash);
    });
    return hash;
  }
  recall(c: Capsule, hash: string, offset = 0, length = 4096): Json {
    invariant(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length > 0 && length <= 8192, "invalid recall range");
    invariant(this.store.db.prepare("SELECT 1 FROM agent_receipts WHERE run=? AND task=? AND hash=?").get(c.runId, c.task.id, hash), "receipt not owned by this thread");
    const text = canonical(this.store.readArtifact(hash)); const bytes = Buffer.from(text);
    return { receipt: hash, offset, bytes: bytes.length, content: bytes.subarray(offset, offset + length).toString("utf8"),
      nextOffset: offset + length < bytes.length ? offset + length : null };
  }
  page(run: string, task: string, after = 0, limit = 10): Json[] {
    invariant(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, "invalid event page");
    return this.store.db.prepare("SELECT seq,at,kind,payload FROM agent_events WHERE run=? AND task=? AND seq>? ORDER BY seq LIMIT ?")
      .all(run, task, after, limit).map(row => ({ seq: row.seq, at: row.at, kind: row.kind, payloadHash: row.payload }));
  }
  historyPage(c: Capsule, after = 0, limit = 3): Json {
    const events = this.page(c.runId, c.task.id, after, limit) as { seq: number; payloadHash: string; kind: string }[];
    const results = events.map(e => {
      // A history page grants access only to this thread's event payloads.
      const value = this.store.readArtifact(e.payloadHash);
      const hash = this.receipt(c, value);
      return { ...e, receipt: hash, preview: canonical(value).slice(0, 800) };
    });
    return { events: results, nextAfter: events.at(-1)?.seq ?? after };
  }
  feedback(c: Capsule, verification?: Verification): string | null {
    if (verification) {
      this.assertLease(c);
      const hash = this.store.artifact(json(verification));
      this.store.transaction(() => {
        this.assertLease(c);
        this.store.db.prepare("INSERT INTO agent_feedback VALUES(?,?,?) ON CONFLICT(run,task) DO UPDATE SET hash=excluded.hash")
          .run(c.runId, c.task.id, hash);
      });
      return hash;
    }
    return this.store.db.prepare("SELECT hash FROM agent_feedback WHERE run=? AND task=?").get(c.runId, c.task.id)?.hash ?? null;
  }
  async reserve(c: Capsule, provider: string, body: Json, budget: SwarmBudget, signal: AbortSignal): Promise<string> {
    const count = Buffer.byteLength(canonical(body)); const request = this.store.artifact(body);
    for (;;) {
      signal.throwIfAborted();
      const id = this.store.transaction(() => {
        this.assertLease(c); const now = Date.now();
        // A lost RPC is unknown spend, never a refund or a known-zero request.
        this.store.db.prepare("UPDATE agent_requests SET status='UNKNOWN' WHERE status='ACTIVE' AND deadline<=?").run(now);
        const used = this.store.db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM agent_requests WHERE run=?").get(c.runId)!;
        if (used.n >= budget.maxRequests || used.bytes + count > budget.maxRequestBytes) throw new FatalAttemptError("RUN_REQUEST_BUDGET_EXHAUSTED");
        const cooldown = this.store.db.prepare("SELECT until_ms FROM agent_cooldowns WHERE provider=?").get(provider)?.until_ms ?? 0;
        const live = this.store.db.prepare("SELECT COUNT(*) AS n FROM agent_requests WHERE provider=? AND status='ACTIVE'").get(provider)!.n;
        if (cooldown > now || live >= budget.modelConcurrency) return null;
        const id = randomUUID();
        this.store.db.prepare("INSERT INTO agent_requests VALUES(?,?,?,?,?,?,?,?,?,'ACTIVE',NULL,NULL)")
          .run(id, c.runId, c.task.id, c.fence, provider, count, request, now, now + budget.requestTimeoutMs);
        return id;
      });
      if (id) return id;
      await delay(50, undefined, { signal });
    }
  }
  cached(c: Capsule, step: number, body: Json): Json | null {
    this.assertLease(c);
    const row = this.store.db.prepare("SELECT body,response FROM agent_replies WHERE run=? AND task=? AND step=?").get(c.runId, c.task.id, step);
    if (!row) return null;
    invariant(row.body === digest(body), "model replay input drift");
    return this.store.readArtifact(row.response);
  }
  complete(id: string, tokens: number | null, response: Json | null, step?: number): void {
    invariant(tokens === null || (Number.isSafeInteger(tokens) && tokens >= 0), "invalid provider usage");
    const hash = response === null ? null : this.store.artifact(response);
    this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM agent_requests WHERE id=?").get(id);
      invariant(row && row.status !== "DONE", "unknown/already completed request");
      this.store.db.prepare("UPDATE agent_requests SET status=?,tokens=?,response=? WHERE id=?")
        .run(response === null ? "UNKNOWN" : "DONE", tokens, hash, id);
      const task = this.store.db.prepare("SELECT status,fence,deadline FROM tasks WHERE run=? AND id=?").get(row.run, row.task);
      // Record late spend, but a superseded RPC must never publish a replayable reply.
      const current = task?.status === "RUNNING" && task.fence === row.fence && task.deadline > Date.now();
      if (step !== undefined && hash && current) {
        invariant(Number.isSafeInteger(step) && step >= 0, "invalid model step");
        const old = this.store.db.prepare("SELECT body,response FROM agent_replies WHERE run=? AND task=? AND step=?").get(row.run, row.task, step);
        invariant(!old || (old.body === row.request && old.response === hash), "model reply already committed");
        this.store.db.prepare("INSERT OR IGNORE INTO agent_replies VALUES(?,?,?,?,?)").run(row.run, row.task, step, row.request, hash);
      }
    });
  }
  cooldown(provider: string, ms: number): void {
    invariant(Number.isFinite(ms) && ms >= 0 && ms <= 60000, "invalid provider cooldown");
    this.store.db.prepare("INSERT INTO agent_cooldowns VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)")
      .run(provider, Date.now() + ms);
  }
  usage(run: string, task?: string, fence?: number): { requests: number; requestBytes: number; knownTokens: number; unknownRequests: number; tokens: number | null } {
    const where = task === undefined ? "run=?" : fence === undefined ? "run=? AND task=?" : "run=? AND task=? AND fence=?";
    const args = task === undefined ? [run] : fence === undefined ? [run, task] : [run, task, fence];
    const row = this.store.db.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes,COALESCE(SUM(tokens),0) AS tokens,
      COALESCE(SUM(CASE WHEN tokens IS NULL THEN 1 ELSE 0 END),0) AS unknown_count FROM agent_requests WHERE ${where}`).get(...args)!;
    return { requests: row.n, requestBytes: row.bytes, knownTokens: row.tokens, unknownRequests: row.unknown_count,
      tokens: row.unknown_count ? null : row.tokens };
  }
}
