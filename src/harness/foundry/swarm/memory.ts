import { canonical, digest, invariant } from "../kernel.ts";
import type { Store } from "../store.ts";
import type { Capsule } from "../types.ts";
import type { ProgressCheckpoint } from "./context.ts";
import { diagnosticInputKey, type DiagnosticFailure } from "./diagnostics.ts";
import type { ThreadState } from "./session.ts";

/** A cold, derived index of committed observations. Never a scheduler or proof. */
export interface MemoryEntry {
  kind: "progress" | "failure";
  receipt: string;
  patchHash: string;
  atTurn: number;
  summary: string;
  nextAction?: string;
  failureSignature?: string;
  inputKey?: string;
}
export interface MemoryQuery {
  kind: "all" | MemoryEntry["kind"];
  before?: string;
  patchHash?: string;
  failureSignature?: string;
  limit?: number;
}
interface MemoryItem {
  cursor: string; eventSeq: number; kind: MemoryEntry["kind"]; receipt: string;
  patchHash: string; atTurn: number;
  trust: "UNVERIFIED_AGENT_NOTE_NOT_ACCEPTANCE" | "OBSERVATION_NOT_ACCEPTANCE";
  currentPatch: boolean | null;
  currentInput?: boolean | null;
  failureSignature?: string;
  summaryPreview?: string;
  nextActionPreview?: string;
}
export interface MemoryPage { items: MemoryItem[]; nextBefore: string | null }
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const emptyPatch = digest("");
const maxEntries = 128; // the admitted maximum number of independent checks

export function progressMemory(progress: ProgressCheckpoint, receipt: string): MemoryEntry {
  return { kind: "progress", receipt, patchHash: progress.patchHash ?? emptyPatch,
    atTurn: progress.atTurn, summary: progress.summary, nextAction: progress.nextAction };
}
export function failureMemory(failure: DiagnosticFailure, atTurn: number): MemoryEntry {
  return { kind: "failure", receipt: failure.fixture, patchHash: failure.patchHash,
    atTurn, summary: failure.excerpt, inputKey: failure.inputKey,
    // Repeated identical output is searchable across patches, but currentness
    // remains bound to ALL inputs (source, feedback, jobs and child results).
    failureSignature: digest({ identity: failure.identity, kind: failure.kind, resultReceipt: failure.receipt }) };
}
export function installMemoryTables(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS agent_memory(
    run TEXT NOT NULL, task TEXT NOT NULL, seq INTEGER NOT NULL, ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL, patch_hash TEXT NOT NULL, failure_signature TEXT,
    PRIMARY KEY(run,task,seq,ordinal));
    CREATE INDEX IF NOT EXISTS agent_memory_kind ON agent_memory(run,task,kind,seq DESC,ordinal DESC);
    CREATE INDEX IF NOT EXISTS agent_memory_patch ON agent_memory(run,task,patch_hash,seq DESC,ordinal DESC);
    CREATE INDEX IF NOT EXISTS agent_memory_patch_kind ON agent_memory(run,task,patch_hash,kind,seq DESC,ordinal DESC);
    CREATE INDEX IF NOT EXISTS agent_memory_failure ON agent_memory(run,task,failure_signature,seq DESC,ordinal DESC);
    CREATE INDEX IF NOT EXISTS agent_memory_failure_patch ON agent_memory(run,task,failure_signature,patch_hash,seq DESC,ordinal DESC);`);
}
function entries(payload: unknown): MemoryEntry[] {
  const raw = (payload as any)?.memory;
  if (raw === undefined) return [];
  invariant(Array.isArray(raw) && raw.length <= maxEntries, "invalid memory entries");
  for (const e of raw) {
    invariant(e && ["progress", "failure"].includes(e.kind) && hash(e.receipt) && hash(e.patchHash) &&
      Number.isSafeInteger(e.atTurn) && e.atTurn >= 0 && typeof e.summary === "string" &&
      (e.nextAction === undefined || typeof e.nextAction === "string") &&
      (e.kind === "failure" ? hash(e.failureSignature) && hash(e.inputKey) :
        e.failureSignature === undefined && e.inputKey === undefined) &&
      Buffer.byteLength(canonical(e)) <= 8192, "invalid memory entry");
  }
  return raw;
}
/** Called inside the SAME transaction as the source event and thread state.
 * Successful short tasks do no memory writes or additional journal scans. */
export function indexMemory(store: Store, run: string, task: string, seq: number, payload: unknown): number {
  const memory = entries(payload);
  for (let i = 0; i < memory.length; i++) {
    const e = memory[i];
    invariant(store.db.prepare("SELECT 1 FROM agent_receipts WHERE run=? AND task=? AND hash=?")
      .get(run, task, e.receipt), "unowned memory receipt");
    store.db.prepare(`INSERT INTO agent_memory VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(run,task,seq,ordinal) DO UPDATE SET kind=excluded.kind,
      patch_hash=excluded.patch_hash,failure_signature=excluded.failure_signature`)
      .run(run, task, seq, i, e.kind, e.patchHash, e.failureSignature ?? null);
  }
  return memory.length;
}
function preview(text: string, maxBytes: number): string {
  let value = Buffer.from(text).subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(value) > maxBytes) value = value.slice(0, -1);
  return value;
}

/** Exact selectors and keyset paging, never a full-thread scan or fuzzy proof.
 * Source descriptors are authenticated on every read; the SQL index is derived. */
export function readMemory(store: Store, c: { runId: string; task: Pick<Capsule["task"], "id"> }, query: MemoryQuery,
  state?: ThreadState, maxBytes = 2048): MemoryPage {
  const limit = query.limit ?? 5;
  invariant(["all", "progress", "failure"].includes(query.kind) && Number.isSafeInteger(limit) && limit > 0 && limit <= 10,
    "invalid memory query");
  invariant(Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 8192, "invalid memory budget");
  invariant((query.patchHash === undefined || hash(query.patchHash)) &&
    (query.failureSignature === undefined || hash(query.failureSignature)), "invalid memory hash");
  const where = ["m.run=?", "m.task=?"], args: (string | number)[] = [c.runId, c.task.id];
  if (query.kind !== "all") { where.push("m.kind=?"); args.push(query.kind); }
  if (query.patchHash !== undefined) { where.push("m.patch_hash=?"); args.push(query.patchHash); }
  if (query.failureSignature !== undefined) { where.push("m.failure_signature=?"); args.push(query.failureSignature); }
  if (query.before !== undefined) {
    const match = /^(\d+):(\d+)$/.exec(query.before);
    invariant(match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0 &&
      Number.isSafeInteger(Number(match[2])) && Number(match[2]) >= 0 && Number(match[2]) < maxEntries, "invalid memory cursor");
    where.push("(m.seq<? OR (m.seq=? AND m.ordinal<?))"); args.push(Number(match[1]), Number(match[1]), Number(match[2]));
  }
  const rows = store.db.prepare(`SELECT m.*,e.payload FROM agent_memory m JOIN agent_events e
    ON e.run=m.run AND e.task=m.task AND e.seq=m.seq WHERE ${where.join(" AND ")}
    ORDER BY m.seq DESC,m.ordinal DESC LIMIT ?`).all(...args, limit + 1);
  const page: MemoryPage = { items: [], nextBefore: null };
  const sources = new Map<string, MemoryEntry[]>();
  for (const row of rows.slice(0, limit)) {
    if (!sources.has(row.payload)) sources.set(row.payload, entries(store.readArtifact(row.payload)));
    const e = sources.get(row.payload)![row.ordinal];
    invariant(e && e.kind === row.kind && e.patchHash === row.patch_hash &&
      (e.failureSignature ?? null) === row.failure_signature, "memory index differs from source event; rebuild it");
    invariant(store.db.prepare("SELECT 1 FROM agent_receipts WHERE run=? AND task=? AND hash=?")
      .get(c.runId, c.task.id, e.receipt), "unowned memory receipt");
    const item: MemoryItem = { cursor: `${row.seq}:${row.ordinal}`, eventSeq: row.seq,
      kind: e.kind, receipt: e.receipt, patchHash: e.patchHash, atTurn: e.atTurn,
      trust: e.kind === "progress" ? "UNVERIFIED_AGENT_NOTE_NOT_ACCEPTANCE" : "OBSERVATION_NOT_ACCEPTANCE",
      currentPatch: state ? e.patchHash === (state.patchHash ?? emptyPatch) : null,
      ...(e.kind === "failure" ? { failureSignature: e.failureSignature,
        currentInput: state ? e.inputKey === diagnosticInputKey(state) : null } : {}),
      summaryPreview: preview(e.summary, 512),
      ...(e.nextAction !== undefined ? { nextActionPreview: preview(e.nextAction, 256) } : {}) };
    const fits = () => Buffer.byteLength(canonical({ items: [...page.items, item], nextBefore: item.cursor })) <= maxBytes;
    if (!fits() && page.items.length) break;
    if (!fits()) { delete item.summaryPreview; delete item.nextActionPreview; }
    invariant(fits(), "memory budget cannot fit a receipt reference");
    page.items.push(item);
  }
  if (rows.length > page.items.length) page.nextBefore = page.items.at(-1)!.cursor;
  return page;
}

/** Explicit bounded maintenance. Only newly recorded descriptors can be
 * rebuilt; legacy transcripts are not converted into invented observations. */
export function rebuildMemoryPage(store: Store, run: string, task: string, after = 0, limit = 100):
  { nextAfter: number; complete: boolean; indexed: number } {
  invariant(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100,
    "invalid memory rebuild page");
  return store.transaction(() => {
    const rows = store.db.prepare("SELECT seq,payload FROM agent_events WHERE run=? AND task=? AND seq>? ORDER BY seq LIMIT ?")
      .all(run, task, after, limit + 1);
    let indexed = 0;
    for (const row of rows.slice(0, limit)) {
      store.db.prepare("DELETE FROM agent_memory WHERE run=? AND task=? AND seq=?").run(run, task, row.seq);
      indexed += indexMemory(store, run, task, row.seq, store.readArtifact(row.payload));
    }
    return { nextAfter: rows[Math.min(rows.length, limit) - 1]?.seq ?? after, complete: rows.length <= limit, indexed };
  });
}
