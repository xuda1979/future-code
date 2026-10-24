import { randomUUID } from "node:crypto";
import { checkPins } from "../commands.ts";
import { canonical, digest, invariant } from "../kernel.ts";
import type { Store } from "../store.ts";
import type { Capsule, Json } from "../types.ts";
import { runProcess } from "../swarm/process.ts";
import { DeferredAttemptError } from "../continuation.ts";
import { FatalAttemptError } from "../errors.ts";
import { integer, operationName, pointer, validateOperations, validateValue, type PinnedOperations } from "./contracts.ts";
import { OperationsEvents } from "./events.ts";

export interface ActionRequest { schema: 1; operation: "read" | "execute" | "inspect"; key: string; inputHash: string; input: Json }
export interface ActionReply {
  schema: 1; key: string; inputHash: string;
  status: "CONFIRMED" | "REJECTED" | "PENDING" | "UNKNOWN";
  result: Json;
  externalId?: string;
  usage?: Record<string, number>;
}
export type ActionRPC = (name: string, request: ActionRequest, signal: AbortSignal) => Promise<ActionReply>;
const terminal = (s: string) => s === "CONFIRMED" || s === "REJECTED";
export function installActionTables(s: Store): void {
  s.db.exec(`CREATE TABLE IF NOT EXISTS operations_policies(namespace TEXT PRIMARY KEY,hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations_resources(namespace TEXT NOT NULL,name TEXT NOT NULL,unit TEXT NOT NULL,ceiling INTEGER NOT NULL,
      held INTEGER NOT NULL DEFAULT 0,spent INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(namespace,name));
    CREATE TABLE IF NOT EXISTS operations_actions(key TEXT PRIMARY KEY,namespace TEXT NOT NULL,capability TEXT NOT NULL,input_hash TEXT NOT NULL,
      input TEXT NOT NULL,state TEXT NOT NULL,reservation TEXT NOT NULL,receipt TEXT,owner TEXT,lease REAL,retry_at REAL NOT NULL DEFAULT 0,created REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS operations_actions_pending ON operations_actions(namespace,state,retry_at);
    CREATE TABLE IF NOT EXISTS operations_action_uses(key TEXT NOT NULL,run TEXT NOT NULL,task TEXT NOT NULL,PRIMARY KEY(key,run,task));
    CREATE TABLE IF NOT EXISTS operations_inference_totals(namespace TEXT PRIMARY KEY,requests INTEGER NOT NULL,bytes INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS operations_action_uses_run ON operations_action_uses(run,task);
    CREATE TABLE IF NOT EXISTS operations_observations(namespace TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,evidence TEXT NOT NULL,
      observed REAL NOT NULL,expires REAL NOT NULL,PRIMARY KEY(namespace,id));`);
}
/** Trusted host facade. Never pass Store, RPC or this object to generated code. */
export class Operations {
  readonly store: Store; readonly pinned: PinnedOperations; readonly events: OperationsEvents;
  readonly rpc: ActionRPC;
  constructor(store: Store, pinned: PinnedOperations, rpc?: ActionRPC) {
    validateOperations(pinned.policy); this.store = store;
    this.pinned = JSON.parse(canonical(pinned)); installActionTables(store);
    const p = this.pinned.policy; this.events = new OperationsEvents(store, p.namespace,
      run => invariant(actionEvidenceGate(store, run).status === "PASS", "event completion blocked by external action evidence"));
    store.transaction(() => {
      const old = store.db.prepare("SELECT hash FROM operations_policies WHERE namespace=?").get(p.namespace);
      invariant(!old || old.hash === digest(this.pinned), "operations authority drift");
      if (!old) {
        store.db.prepare("INSERT INTO operations_policies VALUES(?,?)").run(p.namespace, digest(this.pinned));
        store.db.prepare("INSERT INTO operations_inference_totals VALUES(?,0,0)").run(p.namespace);
        for (const [name, r] of Object.entries(p.resources)) store.db.prepare("INSERT INTO operations_resources(namespace,name,unit,ceiling) VALUES(?,?,?,?)")
          .run(p.namespace, name, r.unit, r.limit);
      }
    });
    this.rpc = rpc ?? (async (name, request, signal) => {
      const out = await runProcess(this.pinned.adapters[name], store.root, [], signal, p.timeoutMs, p.maxBytes, canonical(request));
      invariant(out.code === 0, "capability adapter failed"); return JSON.parse(out.stdout);
    });
  }
  private current(c: Capsule): void {
    const run = this.store.db.prepare("SELECT contract,recipe FROM runs WHERE id=?").get(c.runId);
    const t = this.store.db.prepare("SELECT status,fence,deadline FROM tasks WHERE run=? AND id=?").get(c.runId, c.task.id);
    invariant(run?.contract === c.contractHash && run?.recipe === c.recipeHash && digest(this.store.contract()) === c.contractHash &&
      t?.status === "RUNNING" && t.fence === c.fence && t.deadline > Date.now(), "stale action authority");
    invariant(this.store.db.prepare("SELECT hash FROM operations_policies WHERE namespace=?").get(this.pinned.policy.namespace)?.hash === digest(this.pinned), "operations policy changed");
  }
  validate(name: string, input: Json, allowed: string[]): void {
    operationName(name); invariant(allowed.includes(name) && Object.hasOwn(this.pinned.policy.capabilities, name), "capability not granted");
    invariant(Buffer.byteLength(canonical(input)) <= this.pinned.policy.maxBytes, "capability input too large");
    const cap = this.pinned.policy.capabilities[name]; validateValue(input, cap.input);
    if (cap.identity) for (const path of cap.identity) pointer(input, path);
    checkPins(this.pinned.adapters[name]);
  }
  private reply(raw: ActionReply, request: ActionRequest): ActionReply {
    invariant(raw && Object.keys(raw).every(k => ["schema", "key", "inputHash", "status", "result", "externalId", "usage"].includes(k)), "invalid adapter reply");
    invariant(raw.schema === 1 && raw.key === request.key && raw.inputHash === request.inputHash &&
      ["CONFIRMED", "REJECTED", "PENDING", "UNKNOWN"].includes(raw.status) && Object.hasOwn(raw, "result"), "unbound adapter reply");
    invariant(Buffer.byteLength(canonical(raw)) <= this.pinned.policy.maxBytes, "adapter reply too large");
    invariant(raw.externalId === undefined || (typeof raw.externalId === "string" && raw.externalId.length <= 512), "invalid external identity");
    return JSON.parse(canonical(raw));
  }
  async invoke(c: Capsule, name: string, input: Json, allowed: string[], signal: AbortSignal): Promise<Json> {
    input = JSON.parse(canonical(input));
    this.current(c); this.validate(name, input, allowed); signal.throwIfAborted();
    const p = this.pinned.policy, cap = p.capabilities[name], inputHash = digest(input);
    if (cap.effect === "read") {
      const request: ActionRequest = { schema: 1, operation: "read", key: randomUUID(), inputHash, input };
      const raw = this.reply(await this.rpc(name, request, signal), request); this.current(c); signal.throwIfAborted();
      invariant(raw.status === "CONFIRMED", "read observation unavailable");
      return { ...raw, trust: "OBSERVATION_NOT_ACCEPTANCE" };
    }
    const key = digest({ namespace: p.namespace, capability: name, identity: cap.identity!.map(path => pointer(input, path)) });
    const owner = randomUUID();
    const claim = this.store.transaction(() => {
      this.current(c); this.validate(name, input, allowed); signal.throwIfAborted();
      const now = Date.now(); let row = this.store.db.prepare("SELECT * FROM operations_actions WHERE key=?").get(key);
      invariant(!row || row.input_hash === inputHash, "logical action payload drift");
      if (!row) {
        const mode = this.events.mode();
        invariant(mode === "ACTIVE" || (mode === "DRAINING" && cap.purpose === "resolve"), "service is not admitting new actions");
        for (const id of cap.requires ?? []) {
          const fact = this.store.db.prepare("SELECT evidence FROM operations_observations WHERE namespace=? AND id=? AND observed<=? AND expires>?").get(p.namespace, id, now, now);
          invariant(fact, "missing or stale observation"); this.store.readArtifact(fact.evidence);
        }
        for (const [r, amount] of Object.entries(cap.reserve ?? {})) {
          const budget = this.store.db.prepare("SELECT * FROM operations_resources WHERE namespace=? AND name=?").get(p.namespace, r)!;
          invariant(budget && Number.isSafeInteger(budget.spent + budget.held + amount) && budget.spent + budget.held + amount <= budget.ceiling, "resource budget exhausted");
          this.store.db.prepare("UPDATE operations_resources SET held=held+? WHERE namespace=? AND name=?").run(amount, p.namespace, r);
        }
        this.store.db.prepare("INSERT INTO operations_actions(key,namespace,capability,input_hash,input,state,reservation,created) VALUES(?,?,?,?,?,'PREPARED',?,?)")
          .run(key, p.namespace, name, inputHash, canonical(input), canonical(cap.reserve ?? {}), now);
        row = this.store.db.prepare("SELECT * FROM operations_actions WHERE key=?").get(key)!;
        this.store.event("operations.action.prepared", { key, capability: name, inputHash }, c.runId, c.task.id);
      }
      this.store.db.prepare("INSERT OR IGNORE INTO operations_action_uses VALUES(?,?,?)").run(key, c.runId, c.task.id);
      if (terminal(row.state)) {
        const receipt = this.reply(this.store.readArtifact(row.receipt) as unknown as ActionReply,
          { schema: 1, operation: "inspect", key, inputHash, input });
        invariant(receipt.status === row.state, "cached action evidence changed");
        return { result: receipt as unknown as Json };
      }
      if ((row.owner && row.lease > now) || row.retry_at > now)
        return { wait: Math.max(now + 10, row.owner ? row.lease : row.retry_at) };
      const operation = row.state === "PREPARED" ? "execute" as const : "inspect" as const;
      this.store.db.prepare("UPDATE operations_actions SET state='DISPATCHING',owner=?,lease=? WHERE key=?")
        .run(owner, now + 2 * p.timeoutMs + 1000, key);
      return { operation };
    });
    if (claim.result !== undefined) return claim.result;
    if (claim.wait !== undefined) throw new DeferredAttemptError("external-action", claim.wait, "external action awaits reconciliation");
    const request: ActionRequest = { schema: 1, operation: claim.operation!, key, inputHash, input };
    let reply: ActionReply | undefined;
    try {
      reply = this.reply(await this.rpc(name, request, signal), request);
      // Executing is not independently observing the committed external state.
      if (request.operation === "execute" && (reply.status === "CONFIRMED" || reply.status === "REJECTED")) {
        const inspect: ActionRequest = { ...request, operation: "inspect" };
        reply = this.reply(await this.rpc(name, inspect, signal), inspect);
      }
      this.current(c); signal.throwIfAborted();
      checkPins(this.pinned.adapters[name]);
      this.store.transaction(() => {
        this.current(c);
        const row = this.store.db.prepare("SELECT * FROM operations_actions WHERE key=?").get(key)!;
        invariant(row.owner === owner && row.lease > Date.now() && !terminal(row.state), "action ownership expired");
        if (terminal(reply!.status)) {
          const held = JSON.parse(row.reservation) as Record<string, number>;
          const usage = reply!.usage ?? {};
          invariant(Object.keys(usage).every(r => Object.hasOwn(held, r)), "unreserved actual usage");
          for (const [r, amount] of Object.entries(held)) {
            integer(usage[r]); invariant(usage[r] <= amount && (reply!.status !== "REJECTED" || usage[r] === 0), "actual usage outside reservation");
          }
          const receipt = this.store.artifact(reply as unknown as Json);
          for (const [r, amount] of Object.entries(held)) this.store.db.prepare(
            "UPDATE operations_resources SET held=held-?,spent=spent+? WHERE namespace=? AND name=?").run(amount, usage[r], p.namespace, r);
          this.store.db.prepare("UPDATE operations_actions SET state=?,receipt=?,owner=NULL,lease=NULL WHERE key=?")
            .run(reply!.status, receipt, key);
          this.store.event("operations.action.observed", { key, state: reply!.status, receipt }, c.runId, c.task.id);
        } else this.store.db.prepare("UPDATE operations_actions SET state=?,owner=NULL,lease=NULL,retry_at=? WHERE key=?")
          .run(reply!.status, Date.now() + p.pollMs, key);
      });
    } catch (error) {
      this.store.transaction(() => {
        const row = this.store.db.prepare("SELECT owner,state FROM operations_actions WHERE key=?").get(key);
        if (row?.owner === owner && !terminal(row.state)) {
          this.store.db.prepare("UPDATE operations_actions SET state='UNKNOWN',owner=NULL,lease=NULL,retry_at=? WHERE key=?").run(Date.now() + p.pollMs, key);
          this.store.event("operations.action.unknown", { key, reason: error instanceof Error ? error.message.slice(0, 512) : "adapter outcome unknown" }, c.runId, c.task.id);
        }
      });
      signal.throwIfAborted();
      throw new DeferredAttemptError("external-action", Date.now() + p.pollMs, "external action UNKNOWN; resources held, inspect before replacement");
    }
    if (!terminal(reply!.status)) throw new DeferredAttemptError("external-action", Date.now() + p.pollMs, "external action remains unresolved");
    return reply as unknown as Json;
  }
  observe(id: string, value: Json, evidence: string, observed: number, expires: number): void {
    operationName(id); integer(observed); integer(expires); invariant(observed <= Date.now() && expires > observed, "invalid observation age");
    this.store.readArtifact(evidence); invariant(Buffer.byteLength(canonical(value)) <= this.pinned.policy.maxBytes, "observation too large");
    this.store.transaction(() => {
      const old = this.store.db.prepare("SELECT observed FROM operations_observations WHERE namespace=? AND id=?").get(this.pinned.policy.namespace, id);
      invariant(!old || observed > old.observed, "observation version did not advance");
      this.store.db.prepare("INSERT INTO operations_observations VALUES(?,?,?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET value=excluded.value,evidence=excluded.evidence,observed=excluded.observed,expires=excluded.expires")
        .run(this.pinned.policy.namespace, id, canonical(value), evidence, observed, expires);
      this.store.event("operations.observation", { id, evidence, observed, expires });
    });
  }
  snapshot(): Json {
    return { namespace: this.pinned.policy.namespace, mode: this.events.mode(),
      inference: this.store.db.prepare("SELECT requests,bytes FROM operations_inference_totals WHERE namespace=?").get(this.pinned.policy.namespace) as Json,
      resources: this.store.db.prepare("SELECT name,unit,ceiling,held,spent FROM operations_resources WHERE namespace=? ORDER BY name").all(this.pinned.policy.namespace) as Json,
      unresolved: this.store.db.prepare("SELECT key,capability,state,retry_at FROM operations_actions WHERE namespace=? AND state NOT IN ('CONFIRMED','REJECTED') ORDER BY created LIMIT 100").all(this.pinned.policy.namespace) as Json };
  }
}
/** Called inside the existing request reservation transaction. Unknown RPCs count. */
export function chargeOperationsRequest(store: Store, bytes: number): void {
  const cfg = store.getMeta<{ operations?: PinnedOperations }>("extension.swarm");
  const p = cfg?.operations?.policy; if (!p) return;
  const row = store.db.prepare("SELECT requests,bytes FROM operations_inference_totals WHERE namespace=?").get(p.namespace);
  if (!row || row.requests >= p.maxModelRequests || row.bytes + bytes > p.maxModelRequestBytes)
    throw new FatalAttemptError("OPERATIONS_REQUEST_BUDGET_EXHAUSTED");
  store.db.prepare("UPDATE operations_inference_totals SET requests=requests+1,bytes=bytes+? WHERE namespace=?").run(bytes, p.namespace);
}
function usedActions(store: Store, run: string, task?: string, objective?: string): Record<string, any>[] {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='operations_action_uses'").get()) return [];
  const lineage = objective && store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='swarm_objective_revisions'").get();
  return store.db.prepare(`SELECT DISTINCT a.* FROM operations_action_uses u JOIN operations_actions a ON a.key=u.key
    WHERE (u.run=? ${lineage ? "OR u.run IN (SELECT run FROM swarm_objective_revisions WHERE objective=?)" : ""})
    ${task ? "AND u.task=?" : ""} ORDER BY a.key`).all(run, ...(lineage ? [objective] : []), ...(task ? [task] : []));
}
export function unresolvedActions(store: Store, run: string, task?: string, objective?: string): number {
  return usedActions(store, run, task, objective).filter(a => !terminal(a.state)).length;
}
/** Re-read external evidence at acceptance, including prior objective revisions. */
export function actionEvidenceGate(store: Store, run: string, task?: string, objective?: string): { status: "PASS" | "BLOCKED"; unresolved: number; invalid: number; records: Json[] } {
  let unresolved = 0, invalid = 0; const records: Json[] = [];
  for (const a of usedActions(store, run, task, objective)) {
    if (!terminal(a.state)) { unresolved++; continue; }
    try {
      const r = store.readArtifact(a.receipt) as unknown as ActionReply;
      invariant(digest(JSON.parse(a.input)) === a.input_hash && r.schema === 1 && r.key === a.key &&
        r.inputHash === a.input_hash && r.status === a.state && Object.hasOwn(r, "result"), "external action evidence binding changed");
      const held = JSON.parse(a.reservation) as Record<string, number>, usage = r.usage ?? {};
      invariant(Object.keys(usage).every(k => Object.hasOwn(held, k)), "unreserved evidence usage");
      for (const [k, amount] of Object.entries(held)) { integer(usage[k]); invariant(usage[k] <= amount && (r.status !== "REJECTED" || usage[k] === 0), "invalid evidence usage"); }
      records.push({ key: a.key, state: a.state, receipt: a.receipt, inputHash: a.input_hash });
    } catch { invalid++; }
  }
  return { status: unresolved || invalid ? "BLOCKED" : "PASS", unresolved, invalid, records };
}
