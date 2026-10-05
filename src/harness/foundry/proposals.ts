import { canonical, digest, invariant } from "./kernel.ts";
import type { Store } from "./store.ts";
import type { Capsule, Json } from "./types.ts";

export type ProposalKind = "RESPONSE" | "PLAN" | "TOOL_CALL" | "SPAWN" | "CLAIM" | "CONFLICT" | "RECOVERY";
export type AdmissionVerdict = "ADMIT" | "REJECT" | "DEFER";
/** A proposal is data, never a capability. The host supplies every binding. */
export interface Proposal<T> {
  schema: 1;
  id: string;
  kind: ProposalKind;
  source: string;
  binding: { run: string; task: string | null; fence: number | null; contractHash: string; recipeHash: string };
  payloadHash: string;
  payload: T;
}
export interface Admission { proposalId: string; verdict: AdmissionVerdict; reason: string }

export function installProposalTables(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS kernel_proposals(
    id TEXT PRIMARY KEY, run TEXT NOT NULL, task TEXT, kind TEXT NOT NULL,
    envelope_hash TEXT NOT NULL, created REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS kernel_proposals_run ON kernel_proposals(run,task,created);
    CREATE TABLE IF NOT EXISTS kernel_admissions(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, proposal TEXT NOT NULL, verdict TEXT NOT NULL,
      reason TEXT NOT NULL, created REAL NOT NULL);`);
  for (const table of ["kernel_proposals", "kernel_admissions"]) store.db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'append-only proposal ledger'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'append-only proposal ledger'); END;`);
}

export function submitProposal<T>(store: Store, kind: ProposalKind, payload: T,
  context: Capsule | string, source: string): Proposal<T> {
  invariant(["RESPONSE", "PLAN", "TOOL_CALL", "SPAWN", "CLAIM", "CONFLICT", "RECOVERY"].includes(kind), "invalid proposal kind");
  invariant(typeof source === "string" && source.length > 0 && source.length <= 256, "invalid proposal source");
  const run = typeof context === "string" ? context : context.runId;
  const row = store.db.prepare("SELECT contract,recipe FROM runs WHERE id=?").get(run);
  invariant(row && row.contract === store.getMeta("contractHash"), "unknown or changed proposal run");
  // Canonical copying severs mutable references owned by adapters or model code.
  const copy = JSON.parse(canonical(payload)) as T;
  const binding = { run, task: typeof context === "string" ? null : context.task.id,
    fence: typeof context === "string" ? null : context.fence,
    contractHash: String(row.contract), recipeHash: String(row.recipe) };
  if (typeof context !== "string") invariant(context.contractHash === binding.contractHash &&
    context.recipeHash === binding.recipeHash, "proposal capsule binding mismatch");
  const identity = { schema: 1 as const, kind, source, binding, payloadHash: digest(copy), payload: copy };
  const proposal: Proposal<T> = { ...identity, id: digest(identity) };
  const hash = store.artifact(JSON.parse(canonical(proposal)) as Json);
  store.db.prepare("INSERT OR IGNORE INTO kernel_proposals VALUES(?,?,?,?,?,?)")
    .run(proposal.id, run, binding.task, kind, hash, Date.now());
  return proposal;
}

/** Revalidate even a previously admitted proposal. A receipt cannot revive an
 * expired lease or authorize a changed payload. Validators are host callbacks. */
export function decideProposal<T>(store: Store, proposal: Proposal<T>,
  validate: (payload: T) => void | { defer: string }, now = Date.now()): Admission {
  let verdict: AdmissionVerdict = "ADMIT", reason = "host validation passed";
  try {
    const row = store.db.prepare("SELECT envelope_hash FROM kernel_proposals WHERE id=?").get(proposal.id);
    invariant(row && digest(proposal) === String(row.envelope_hash), "unregistered or altered proposal");
    store.readArtifact(String(row.envelope_hash));
    invariant(digest(proposal.payload) === proposal.payloadHash, "proposal payload drift");
    const b = proposal.binding;
    const run = store.db.prepare("SELECT contract,recipe FROM runs WHERE id=?").get(b.run);
    invariant(run?.contract === b.contractHash && run?.recipe === b.recipeHash &&
      digest(store.contract()) === b.contractHash, "proposal authority binding drift");
    if (b.task !== null) {
      const task = store.db.prepare("SELECT status,fence,deadline FROM tasks WHERE run=? AND id=?").get(b.run, b.task);
      invariant(task?.status === "RUNNING" && task.fence === b.fence && task.deadline > now, "stale proposal lease");
    }
    const result = validate(proposal.payload);
    invariant(!(result && typeof (result as any).then === "function"), "async proposal validation forbidden");
    if (result && result.defer) { verdict = "DEFER"; reason = result.defer; }
  } catch (error) { verdict = "REJECT"; reason = error instanceof Error ? error.message : "validation failed"; }
  const admission = { proposalId: proposal.id, verdict, reason: reason.slice(0, 2048) };
  store.db.prepare("INSERT INTO kernel_admissions(proposal,verdict,reason,created) VALUES(?,?,?,?)")
    .run(proposal.id, verdict, admission.reason, now);
  store.event("kernel.proposal.decided", admission, proposal.binding.run, proposal.binding.task);
  return admission;
}

export function requireAdmission<T>(store: Store, proposal: Proposal<T>, validate: (payload: T) => void): T {
  const admission = decideProposal(store, proposal, validate);
  invariant(admission.verdict === "ADMIT", `proposal ${admission.verdict}: ${admission.reason}`);
  return JSON.parse(canonical(proposal.payload)) as T;
}

/** A mutation handler rechecks the registered envelope and current admission.
 * Reading this record never grants authority to an expired task. */
export function admittedProposal(store: Store, id: string, kind: ProposalKind, run: string, task: string): Proposal<any> {
  const row = store.db.prepare("SELECT envelope_hash FROM kernel_proposals WHERE id=?").get(id);
  invariant(row, "unregistered mutation proposal");
  const proposal = store.readArtifact(String(row.envelope_hash)) as unknown as Proposal<any>;
  invariant(proposal.id === id && proposal.kind === kind && proposal.binding.run === run && proposal.binding.task === task,
    "mutation proposal binding mismatch");
  const admission = store.db.prepare("SELECT verdict FROM kernel_admissions WHERE proposal=? ORDER BY seq DESC LIMIT 1").get(id);
  invariant(admission?.verdict === "ADMIT", "mutation proposal was not admitted");
  const b = proposal.binding;
  const current = store.db.prepare("SELECT status,fence,deadline FROM tasks WHERE run=? AND id=?").get(run, task);
  const execution = store.db.prepare("SELECT contract,recipe FROM runs WHERE id=?").get(run);
  invariant(current?.status === "RUNNING" && current.fence === b.fence && current.deadline > Date.now() &&
    execution?.contract === b.contractHash && execution?.recipe === b.recipeHash && digest(store.contract()) === b.contractHash,
    "stale mutation proposal lease");
  return proposal;
}
