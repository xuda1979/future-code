import { canonical, digest, invariant, validateEvidence, validateTasks } from "../kernel.ts";
import { claimGate } from "../claims.ts";
import { compilePlan } from "../productivity.ts";
import { Scheduler } from "../scheduler.ts";
import type { Store } from "../store.ts";
import type { Json, Task } from "../types.ts";

export type ServiceMode = "ACTIVE" | "DRAINING" | "PAUSED";
export type EventStatus = "QUEUED" | "PREPARED" | "DISPATCHED" | "COMPLETE";
export interface OperationEventInput {
  source: string;
  id: string;
  type: string;
  payload: Json;
  /** An absolute host timestamp. Omission means immediate on the first delivery. */
  availableAt?: number;
}
export interface OperationEvent {
  key: string;
  source: string;
  id: string;
  type: string;
  payload: Json;
  availableAt: number;
  receivedAt: number;
  status: EventStatus;
  run: string | null;
  planHash: string | null;
}
export interface ObligationInput { id: string; dueAt: number; detail: string; evidenceHash: string }
export interface OperationObligation extends ObligationInput {
  status: "OPEN" | "RESOLVED";
  createdAt: number;
  resolvedAt: number | null;
  resolutionHash: string | null;
}
type Row = Record<string, any>;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MODES: ServiceMode[] = ["ACTIVE", "DRAINING", "PAUSED"];
const STATUSES: EventStatus[] = ["QUEUED", "PREPARED", "DISPATCHED", "COMPLETE"];
function text(value: unknown, label: string, max = 256): asserts value is string {
  invariant(typeof value === "string" && value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= max && !/[\x00-\x1f]/.test(value), `invalid ${label}`);
}
function clock(value: number): void {
  invariant(Number.isSafeInteger(value) && value >= 0, "invalid event time");
}
function limit(value: number): void {
  invariant(Number.isSafeInteger(value) && value >= 1 && value <= 100, "invalid event page limit");
}
function fields(value: object, allowed: string[], required: string[]): void {
  invariant(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)),
  "invalid event fields");
}

/** Trusted host API. Ingress authentication and project-specific policy belong
 * to pinned adapters. Events and obligations never grant model authority.
 * Execution remains exclusively in Foundry tasks and its existing Scheduler. */
export class OperationsEvents {
  readonly store: Store;
  readonly namespace: string;
  readonly completionGuard?: (run: string) => void;
  constructor(store: Store, namespace: string, completionGuard?: (run: string) => void) {
    text(namespace, "service namespace", 128);
    this.store = store; this.namespace = namespace; this.completionGuard = completionGuard;
    store.db.exec(`CREATE TABLE IF NOT EXISTS operations_services(
      namespace TEXT PRIMARY KEY, mode TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS operations_events(
      key TEXT PRIMARY KEY, namespace TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL,
      event_type TEXT NOT NULL, input_hash TEXT NOT NULL, payload_hash TEXT NOT NULL,
      requested_available_at REAL, available_at REAL NOT NULL, received_at REAL NOT NULL,
      status TEXT NOT NULL, run TEXT, plan_hash TEXT, recipe_hash TEXT, contract_hash TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS operations_events_identity ON operations_events(namespace,source,external_id);
      CREATE INDEX IF NOT EXISTS operations_events_due ON operations_events(namespace,status,available_at,key);
      CREATE INDEX IF NOT EXISTS operations_events_due_type ON operations_events(namespace,status,event_type,available_at,key);
      CREATE INDEX IF NOT EXISTS operations_events_incomplete ON operations_events(namespace,status,received_at,key);
      CREATE TABLE IF NOT EXISTS operations_obligations(
      namespace TEXT NOT NULL, id TEXT NOT NULL, due_at REAL NOT NULL, detail TEXT NOT NULL,
      evidence_hash TEXT NOT NULL, status TEXT NOT NULL, created_at REAL NOT NULL,
      resolved_at REAL, resolution_hash TEXT, PRIMARY KEY(namespace,id));
      CREATE INDEX IF NOT EXISTS operations_obligations_due ON operations_obligations(namespace,status,due_at,id);
      CREATE TRIGGER IF NOT EXISTS operations_events_identity_immutable BEFORE UPDATE ON operations_events
      WHEN NEW.key IS NOT OLD.key OR NEW.namespace IS NOT OLD.namespace OR NEW.source IS NOT OLD.source
        OR NEW.external_id IS NOT OLD.external_id OR NEW.event_type IS NOT OLD.event_type
        OR NEW.input_hash IS NOT OLD.input_hash OR NEW.payload_hash IS NOT OLD.payload_hash
        OR NEW.requested_available_at IS NOT OLD.requested_available_at
        OR NEW.available_at IS NOT OLD.available_at OR NEW.received_at IS NOT OLD.received_at
        OR (OLD.run IS NOT NULL AND (NEW.run IS NOT OLD.run OR NEW.plan_hash IS NOT OLD.plan_hash
          OR NEW.recipe_hash IS NOT OLD.recipe_hash OR NEW.contract_hash IS NOT OLD.contract_hash))
        OR (OLD.status='COMPLETE' AND NEW.status<>'COMPLETE')
      BEGIN SELECT RAISE(ABORT,'immutable event identity or plan'); END;
      CREATE TRIGGER IF NOT EXISTS operations_events_no_delete BEFORE DELETE ON operations_events
      BEGIN SELECT RAISE(ABORT,'retain event history'); END;
      CREATE TRIGGER IF NOT EXISTS operations_obligations_identity_immutable BEFORE UPDATE ON operations_obligations
      WHEN NEW.namespace IS NOT OLD.namespace OR NEW.id IS NOT OLD.id OR NEW.due_at IS NOT OLD.due_at
        OR NEW.detail IS NOT OLD.detail OR NEW.evidence_hash IS NOT OLD.evidence_hash
        OR NEW.created_at IS NOT OLD.created_at OR (OLD.status='RESOLVED' AND
          (NEW.status IS NOT OLD.status OR NEW.resolution_hash IS NOT OLD.resolution_hash OR NEW.resolved_at IS NOT OLD.resolved_at))
      BEGIN SELECT RAISE(ABORT,'immutable obligation identity or resolution'); END;
      CREATE TRIGGER IF NOT EXISTS operations_obligations_no_delete BEFORE DELETE ON operations_obligations
      BEGIN SELECT RAISE(ABORT,'retain obligation history'); END;`);
    store.db.prepare("INSERT OR IGNORE INTO operations_services VALUES(?,'ACTIVE',?,?)")
      .run(namespace, Date.now(), Date.now());
  }
  mode(): ServiceMode {
    const mode = this.store.db.prepare("SELECT mode FROM operations_services WHERE namespace=?").get(this.namespace)?.mode;
    invariant(MODES.includes(mode), "invalid service mode"); return mode;
  }
  setMode(mode: ServiceMode, now = Date.now()): ServiceMode {
    invariant(MODES.includes(mode), "invalid service mode"); clock(now);
    return this.store.transaction(() => {
      if (this.mode() !== mode) {
        this.store.db.prepare("UPDATE operations_services SET mode=?,updated=? WHERE namespace=?").run(mode, now, this.namespace);
        this.store.event("operations.service.mode", { namespace: this.namespace, mode });
      }
      return mode;
    });
  }
  private row(key: string): Row {
    invariant(typeof key === "string" && /^[a-f0-9]{64}$/.test(key), "invalid event key");
    const row = this.store.db.prepare("SELECT * FROM operations_events WHERE namespace=? AND key=?").get(this.namespace, key);
    invariant(row, "unknown event"); return row;
  }
  private event(row: Row): OperationEvent {
    invariant(STATUSES.includes(row.status), "invalid persisted event state");
    const payload = this.store.readArtifact(String(row.payload_hash));
    invariant(digest({ namespace: this.namespace, source: row.source, id: row.external_id }) === row.key &&
      digest({ source: row.source, id: row.external_id, type: row.event_type,
        payload, availableAt: row.requested_available_at }) === row.input_hash, "event identity integrity failure");
    return { key: row.key, source: row.source, id: row.external_id, type: row.event_type, payload,
      availableAt: row.available_at, receivedAt: row.received_at, status: row.status,
      run: row.run, planHash: row.plan_hash };
  }
  get(key: string): OperationEvent { return this.event(this.row(key)); }
  enqueue(input: OperationEventInput, now = Date.now()): OperationEvent {
    return this.enqueueRecord(input, now)!;
  }
  private enqueueRecord(input: OperationEventInput, now: number, obligationId?: string): OperationEvent | null {
    fields(input, ["source", "id", "type", "payload", "availableAt"], ["source", "id", "type", "payload"]);
    text(input.source, "event source"); text(input.id, "event id"); text(input.type, "event type", 128); clock(now);
    if (input.availableAt !== undefined) clock(input.availableAt);
    invariant(Buffer.byteLength(canonical(input.payload), "utf8") <= MAX_PAYLOAD_BYTES, "event payload exceeds limit");
    const copy = JSON.parse(canonical(input)) as OperationEventInput;
    const key = digest({ namespace: this.namespace, source: copy.source, id: copy.id });
    const hash = digest({ source: copy.source, id: copy.id, type: copy.type, payload: copy.payload, availableAt: copy.availableAt ?? null });
    const payloadHash = this.store.artifact(copy.payload);
    return this.store.transaction(() => {
      if (obligationId !== undefined) {
        // Selection is advisory. Resolution on another connection between the
        // query and insertion must prevent a new notification.
        const obligation = this.store.db.prepare("SELECT status,due_at FROM operations_obligations WHERE namespace=? AND id=?")
          .get(this.namespace, obligationId);
        if (!obligation || obligation.status !== "OPEN" || obligation.due_at > now) return null;
      }
      const previous = this.store.db.prepare("SELECT * FROM operations_events WHERE key=?").get(key);
      if (previous) {
        invariant(previous.input_hash === hash, "event identity reused with changed content or schedule");
        return obligationId === undefined ? this.event(previous) : null;
      }
      this.store.db.prepare(`INSERT INTO operations_events VALUES(?,?,?,?,?,?,?,?,?,?,'QUEUED',NULL,NULL,NULL,NULL)`)
        .run(key, this.namespace, copy.source, copy.id, copy.type, hash, payloadHash, copy.availableAt ?? null, copy.availableAt ?? now, now);
      this.store.event("operations.event.received", { namespace: this.namespace, key, type: copy.type });
      return this.get(key);
    });
  }
  due(type?: string, max = 20, now = Date.now()): OperationEvent[] {
    limit(max); clock(now); if (type !== undefined) text(type, "event type", 128);
    const rows = type === undefined
      ? this.store.db.prepare("SELECT * FROM operations_events WHERE namespace=? AND status='QUEUED' AND available_at<=? ORDER BY available_at,key LIMIT ?").all(this.namespace, now, max)
      : this.store.db.prepare("SELECT * FROM operations_events WHERE namespace=? AND status='QUEUED' AND event_type=? AND available_at<=? ORDER BY available_at,key LIMIT ?").all(this.namespace, type, now, max);
    return rows.map(row => this.event(row));
  }
  incomplete(max = 20): OperationEvent[] {
    limit(max);
    return this.store.db.prepare(`SELECT * FROM operations_events WHERE namespace=? AND status IN ('PREPARED','DISPATCHED')
      ORDER BY received_at,key LIMIT ?`).all(this.namespace, max).map(row => this.event(row));
  }
  /** Plan admission is persisted before Scheduler.start. A crash at either side
   * of start can create/adopt the SAME run; it never creates a replacement ID.
   * Callers supply operator-pinned routes; model text cannot choose new routes. */
  dispatch(key: string, tasks: Task[], now = Date.now(), resolution = false): OperationEvent {
    clock(now); invariant(typeof resolution === "boolean", "invalid resolution admission flag");
    const plan: Task[] = JSON.parse(canonical(tasks)).sort((a: Task, b: Task) => a.id.localeCompare(b.id));
    invariant(Buffer.byteLength(canonical(plan), "utf8") <= 1024 * 1024, "event plan exceeds limit");
    validateTasks(this.store.contract(), plan);
    const bound = this.store.transaction(() => {
      const row = this.row(key); this.event(row);
      if (row.status !== "QUEUED") {
        invariant(row.plan_hash === digest(plan), "event plan changed after admission");
        invariant(row.contract_hash === digest(this.store.contract()), "event contract changed");
        return row;
      }
      const mode = this.mode();
      invariant(mode === "ACTIVE" || (mode === "DRAINING" && resolution), "service is not active for new event admission");
      invariant(row.available_at <= now, "event is not due");
      const recipeHash = this.store.active();
      compilePlan(plan, this.store.recipe(recipeHash), this.store.contract().limits.contextBytes);
      const planHash = this.store.artifact(plan as unknown as Json);
      const run = `event-${digest({ namespace: this.namespace, key })}`;
      this.store.db.prepare(`UPDATE operations_events SET status='PREPARED',run=?,plan_hash=?,recipe_hash=?,contract_hash=? WHERE key=?`)
        .run(run, planHash, recipeHash, digest(this.store.contract()), key);
      this.store.event("operations.event.prepared", { namespace: this.namespace, key, run, planHash }, run);
      return this.row(key);
    });
    if (bound.status === "DISPATCHED" || bound.status === "COMPLETE") return this.get(key);
    const existing = this.store.db.prepare("SELECT id FROM runs WHERE id=?").get(bound.run);
    invariant(existing || this.mode() !== "PAUSED", "service is paused before event dispatch");
    const pinnedPlan = this.store.readArtifact(bound.plan_hash) as unknown as Task[];
    new Scheduler(this.store).start(pinnedPlan, bound.recipe_hash, now, bound.run);
    return this.store.transaction(() => {
      const row = this.row(key);
      invariant(row.run === bound.run && row.plan_hash === bound.plan_hash, "event run binding changed");
      if (row.status === "PREPARED") {
        this.store.db.prepare("UPDATE operations_events SET status='DISPATCHED' WHERE key=?").run(key);
        this.store.event("operations.event.dispatched", { namespace: this.namespace, key, run: bound.run }, bound.run);
      }
      return this.get(key);
    });
  }
  /** This is finite episode completion, never completion of the ongoing service.
   * The caller additionally applies its external-effect/obligation acceptance
   * gates. Existing obligations remain independently durable after completion. */
  complete(key: string): OperationEvent {
    return this.store.transaction(() => {
      const row = this.row(key); this.event(row);
      invariant(row.status === "DISPATCHED" || row.status === "COMPLETE", "event has no dispatched run");
      const run = this.store.db.prepare("SELECT * FROM runs WHERE id=?").get(row.run);
      invariant(run?.status === "PASS", "event run is not PASS");
      this.completionGuard?.(String(row.run));
      const contract = this.store.contract();
      invariant(run.contract === row.contract_hash && run.recipe === row.recipe_hash && digest(contract) === row.contract_hash,
        "event completion binding mismatch");
      this.store.recipe(run.recipe);
      const plan = this.store.readArtifact(row.plan_hash);
      const initial = this.store.db.prepare(`SELECT t.spec FROM tasks t WHERE t.run=? AND NOT EXISTS
        (SELECT 1 FROM spawn_edges s WHERE s.run=t.run AND s.child=t.id)`).all(row.run)
        .map(item => JSON.parse(item.spec) as Task).sort((a, b) => a.id.localeCompare(b.id));
      invariant(digest(initial) === digest(plan), "event task plan drift before completion");
      const tasks = this.store.db.prepare("SELECT * FROM tasks WHERE run=? ORDER BY id").all(row.run);
      invariant(tasks.length > 0, "event task evidence missing");
      for (const task of tasks) {
        invariant(task.status === "PASS" && task.artifact && task.evidence, "event task evidence incomplete");
        validateEvidence(contract, run.recipe, JSON.parse(task.spec), this.store.readArtifact(task.artifact), this.store.readArtifact(task.evidence));
      }
      const claims = claimGate(this.store, row.run);
      invariant(claims.openClaimConflicts === 0 && claims.staleClaims === 0 &&
        !this.store.db.prepare("SELECT 1 FROM fabric_conflicts WHERE run=? AND status='OPEN' LIMIT 1").get(row.run),
      "event completion has unresolved evidence conflicts");
      if (row.status !== "COMPLETE") {
        this.store.db.prepare("UPDATE operations_events SET status='COMPLETE' WHERE key=?").run(key);
        this.store.event("operations.event.completed", { namespace: this.namespace, key, run: row.run }, row.run);
      }
      return this.get(key);
    });
  }
  private obligation(row: Row): OperationObligation {
    this.store.readArtifact(row.evidence_hash);
    if (row.resolution_hash) this.store.readArtifact(row.resolution_hash);
    invariant(["OPEN", "RESOLVED"].includes(row.status), "invalid obligation state");
    return { id: row.id, dueAt: row.due_at, detail: row.detail, evidenceHash: row.evidence_hash,
      status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at, resolutionHash: row.resolution_hash };
  }
  /** Only trusted host adapters may record or resolve obligations. Artifact
   * existence authenticates bytes; the project validator owns their meaning. */
  addObligation(input: ObligationInput, now = Date.now()): OperationObligation {
    fields(input, ["id", "dueAt", "detail", "evidenceHash"], ["id", "dueAt", "detail", "evidenceHash"]);
    text(input.id, "obligation id"); text(input.detail, "obligation detail", 2048); clock(input.dueAt); clock(now);
    this.store.readArtifact(input.evidenceHash);
    return this.store.transaction(() => {
      const old = this.store.db.prepare("SELECT * FROM operations_obligations WHERE namespace=? AND id=?").get(this.namespace, input.id);
      if (old) {
        invariant(old.due_at === input.dueAt && old.detail === input.detail && old.evidence_hash === input.evidenceHash,
          "obligation identity reused with changed commitment");
        return this.obligation(old);
      }
      this.store.db.prepare("INSERT INTO operations_obligations VALUES(?,?,?,?,?,'OPEN',?,NULL,NULL)")
        .run(this.namespace, input.id, input.dueAt, input.detail, input.evidenceHash, now);
      this.store.event("operations.obligation.opened", { namespace: this.namespace, id: input.id, dueAt: input.dueAt, evidenceHash: input.evidenceHash });
      return this.obligation(this.store.db.prepare("SELECT * FROM operations_obligations WHERE namespace=? AND id=?").get(this.namespace, input.id)!);
    });
  }
  resolveObligation(id: string, evidenceHash: string, now = Date.now()): OperationObligation {
    text(id, "obligation id"); clock(now); this.store.readArtifact(evidenceHash);
    return this.store.transaction(() => {
      const old = this.store.db.prepare("SELECT * FROM operations_obligations WHERE namespace=? AND id=?").get(this.namespace, id);
      invariant(old, "unknown obligation");
      if (old.status === "RESOLVED") {
        invariant(old.resolution_hash === evidenceHash, "obligation resolution already fixed");
        return this.obligation(old);
      }
      this.store.db.prepare("UPDATE operations_obligations SET status='RESOLVED',resolved_at=?,resolution_hash=? WHERE namespace=? AND id=?")
        .run(now, evidenceHash, this.namespace, id);
      this.store.event("operations.obligation.resolved", { namespace: this.namespace, id, evidenceHash });
      return this.obligation(this.store.db.prepare("SELECT * FROM operations_obligations WHERE namespace=? AND id=?").get(this.namespace, id)!);
    });
  }
  outstanding(after?: string, max = 20): { items: OperationObligation[]; nextAfter: string | null } {
    limit(max);
    let cursor: { namespace: string; dueAt: number; id: string } | null = null;
    if (after !== undefined) {
      invariant(typeof after === "string" && after.length <= 1024, "invalid obligation cursor");
      try { cursor = JSON.parse(Buffer.from(after, "base64url").toString("utf8")); }
      catch { throw new Error("invalid obligation cursor"); }
      invariant(cursor && cursor.namespace === this.namespace, "obligation cursor namespace mismatch");
      clock(cursor.dueAt); text(cursor.id, "obligation cursor id");
    }
    const rows = cursor
      ? this.store.db.prepare(`SELECT * FROM operations_obligations WHERE namespace=? AND status='OPEN'
        AND (due_at>? OR (due_at=? AND id>?)) ORDER BY due_at,id LIMIT ?`).all(this.namespace, cursor.dueAt, cursor.dueAt, cursor.id, max + 1)
      : this.store.db.prepare("SELECT * FROM operations_obligations WHERE namespace=? AND status='OPEN' ORDER BY due_at,id LIMIT ?").all(this.namespace, max + 1);
    const items = rows.slice(0, max).map(row => this.obligation(row));
    const last = items.at(-1);
    const nextAfter = rows.length > max && last
      ? Buffer.from(canonical({ namespace: this.namespace, dueAt: last.dueAt, id: last.id })).toString("base64url") : null;
    return { items, nextAfter };
  }
  /** At most one durable notification per accepted obligation identity. The
   * trusted host supplies a pinned resolution route for obligation.due events. */
  queueDueObligations(max = 20, now = Date.now()): OperationEvent[] {
    limit(max); clock(now);
    const rows = this.store.db.prepare(`SELECT o.id,o.due_at,o.evidence_hash FROM operations_obligations o
      WHERE o.namespace=? AND o.status='OPEN' AND o.due_at<=? AND NOT EXISTS
      (SELECT 1 FROM operations_events e WHERE e.namespace=o.namespace
        AND e.source='operations-obligation' AND e.external_id=o.id)
      ORDER BY o.due_at,o.id LIMIT ?`).all(this.namespace, now, max);
    const queued: OperationEvent[] = [];
    for (const row of rows) {
      const entry = this.enqueueRecord({ source: "operations-obligation", id: row.id,
        type: "obligation.due", payload: { id: row.id, evidenceHash: row.evidence_hash, dueAt: row.due_at } }, now, row.id);
      if (entry) queued.push(entry);
    }
    return queued;
  }
  /** Strictly future wakeup. Call due()/queueDueObligations() before idle waits;
   * due work must not occupy the next timer slot indefinitely. */
  nextDeadline(now = Date.now()): number | null {
    clock(now);
    const event = this.store.db.prepare(`SELECT available_at FROM operations_events
      WHERE namespace=? AND status='QUEUED' AND available_at>? ORDER BY available_at,key LIMIT 1`).get(this.namespace, now);
    const obligation = this.store.db.prepare(`SELECT o.due_at FROM operations_obligations o
      WHERE o.namespace=? AND o.status='OPEN' AND o.due_at>? AND NOT EXISTS
      (SELECT 1 FROM operations_events e WHERE e.namespace=o.namespace
        AND e.source='operations-obligation' AND e.external_id=o.id)
      ORDER BY o.due_at,o.id LIMIT 1`).get(this.namespace, now);
    const deadlines = [event?.available_at, obligation?.due_at].filter((value): value is number => value !== undefined);
    return deadlines.length ? Math.min(...deadlines) : null;
  }
  state(max = 20, now = Date.now()) {
    limit(max); clock(now);
    const counts = Object.fromEntries(this.store.db.prepare("SELECT status,COUNT(*) AS n FROM operations_events WHERE namespace=? GROUP BY status")
      .all(this.namespace).map(row => [row.status, Number(row.n)]));
    const projection = ({ payload, ...event }: OperationEvent) => ({ ...event, payloadHash: digest(payload) });
    return { namespace: this.namespace, mode: this.mode(), counts,
      due: this.due(undefined, max, now).map(projection), active: this.incomplete(max).map(projection),
      obligations: this.outstanding(undefined, max),
      overdue: Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM operations_obligations WHERE namespace=? AND status='OPEN' AND due_at<=?")
        .get(this.namespace, now)!.n) };
  }
}
