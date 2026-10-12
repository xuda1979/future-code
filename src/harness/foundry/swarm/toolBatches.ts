import { performance } from "node:perf_hooks";
import { DeferredAttemptError } from "../continuation.ts";
import { FatalAttemptError } from "../errors.ts";
import { canonical, invariant } from "../kernel.ts";
import type { AttemptControl, Json } from "../types.ts";
import type { Call } from "./context.ts";
import { inlineReceipt } from "./context.ts";
import type { PinnedSwarm } from "./config.ts";
import type { SessionJournal, Thread } from "./session.ts";
import { toolEffectContract } from "./toolEffects.ts";
import type { Hands, WorkspaceBatchResult } from "./workspace.ts";

export interface ToolBatch {
  kind: "read" | "workspace-write" | "run_job";
  calls: Call[];
  concurrency: number;
}
const reads = new Set(["read_file", "list_files"]);
const writes = new Set(["write_file", "edit_file", "delete_file"]);

/** Only adjacent compatible calls share a batch. Every other effect is a
 * barrier, including checks, delegation and progress notes. */
export function nextToolBatch(calls: Call[], hands: Hands): ToolBatch | null {
  const first = calls[0]; if (!first) return null;
  const policy = hands.batchPolicy;
  const concurrentReads = policy && Number.isSafeInteger(policy.reads) ? Math.min(4, policy.reads) : 1;
  const kind = first.name === "run_job" ? "run_job" :
    reads.has(first.name) && concurrentReads > 1 ? "read" :
    writes.has(first.name) && policy?.writes === true ? "workspace-write" : null;
  if (!kind) return null;
  const compatible = (c: Call) => kind === "run_job" ? c.name === "run_job" :
    (kind === "read" ? reads : writes).has(c.name);
  const end = calls.findIndex(c => !compatible(c));
  let group = end < 0 ? calls : calls.slice(0, end);
  const maxCalls = policy?.maxCalls;
  if (kind !== "run_job" && maxCalls !== undefined && Number.isSafeInteger(maxCalls) && maxCalls > 0)
    group = group.slice(0, maxCalls);
  // A remote transaction also coalesces one edit with its snapshot into one
  // RPC. Backends without that transaction retain the single-call path.
  return group.length > 1 || (kind === "workspace-write" && !!hands.batch)
    ? { kind, calls: group, concurrency: kind === "read" ? concurrentReads : kind === "run_job" ? 8 : 1 } : null;
}

interface BatchExecution {
  batch: ToolBatch; thread: Thread; journal: SessionJournal; cfg: PinnedSwarm;
  signal: AbortSignal; control?: AttemptControl;
  admit(call: Call): string;
  execute(call: Call): Promise<Json>;
  executeBatch?(calls: Call[]): Promise<WorkspaceBatchResult>;
  snapshot(): Promise<string>;
}

/** Charge and persist intents before effects. Private writes run in order;
 * the canonical snapshot and every result become visible in one checkpoint.
 * Until that checkpoint, restart restores the old patch and replays the batch. */
export async function executeToolBatch(o: BatchExecution): Promise<void> {
  const { batch, thread: t, journal, cfg, signal, control } = o;
  const c = t.capsule, started = performance.now();
  const carried = (t.state.pendingBatch ?? []).filter(id => !batch.calls.some(call => call.id === id));
  const charged = new Set(t.state.pendingBatch ?? []);
  if (t.state.pending) charged.add(t.state.pending.id);
  const fresh = batch.calls.filter(call => !charged.has(call.id));
  if (t.state.toolCalls + fresh.length > cfg.spec.budget.maxToolCalls)
    throw new FatalAttemptError("THREAD_TOOL_BUDGET_EXHAUSTED");
  t.state.toolCalls += fresh.length; t.state.pending = null;
  t.state.pendingBatch = [...carried, ...batch.calls.map(call => call.id)];
  journal.checkpoint(t, "tool.batch.intent", { kind: batch.kind, callIds: t.state.pendingBatch });
  // Admission failures are results, as in the single-call path. A rejected
  // duplicate cannot borrow a successful call's admission or receipt.
  const rejected = new Map<string, unknown>();
  for (const call of batch.calls) {
    try {
      const proposalId = o.admit(call);
      const effect = toolEffectContract(cfg, call.name as any, call.arguments);
      journal.checkpoint(t, "tool.effect", { callId: call.id, proposalId, ...effect });
      journal.checkpoint(t, "tool.intent", call);
    } catch (e) {
      signal.throwIfAborted(); journal.assertLease(c);
      if (e instanceof FatalAttemptError || e instanceof DeferredAttemptError) throw e;
      rejected.set(call.id, e);
    }
  }
  control?.activity?.(`${batch.kind === "run_job" ? "remote-batch" : "tool-batch"}:launch:${batch.calls.length}`);
  const results: PromiseSettledResult<Json>[] = new Array(batch.calls.length);
  const inFlight = new Map<string, Promise<Json>>();
  let batchPatch: string | undefined;
  let cursor = 0, executions = 0, stopped = false;
  const worker = async () => {
    for (;;) {
      if (stopped) return;
      const index = cursor++; if (index >= batch.calls.length) return;
      const call = batch.calls[index]!;
      try {
        signal.throwIfAborted(); journal.assertLease(c);
        if (rejected.has(call.id)) throw rejected.get(call.id);
        control?.activity?.(`tool:${call.name}`);
        // Identical reads of this private unchanged workspace share I/O only
        // within this batch. Every call keeps its own budget charge and pair.
        const key = canonical({ name: call.name, arguments: call.arguments });
        let work = batch.kind === "read" ? inFlight.get(key) : undefined;
        if (!work) {
          executions++; work = Promise.resolve().then(() => o.execute(call));
          if (batch.kind === "read") inFlight.set(key, work);
        }
        results[index] = { status: "fulfilled", value: await work };
        control?.activity?.(`completed:${call.name}`);
      } catch (reason) {
        results[index] = { status: "rejected", reason };
        control?.activity?.(`failed:${call.name}`);
        if (reason instanceof FatalAttemptError ||
            (reason instanceof DeferredAttemptError && batch.kind !== "run_job")) stopped = true;
      }
    }
  };
  // Drain every launched worker even if a host callback throws. Disposal or
  // retry must not race an older in-flight read or external job RPC.
  if (o.executeBatch && batch.kind !== "run_job") {
    const unique: Call[] = [], owners = new Map<string, number>(), indices: number[] = [];
    for (const [i, call] of batch.calls.entries()) {
      if (rejected.has(call.id)) { results[i] = { status: "rejected", reason: rejected.get(call.id) }; continue; }
      const key = batch.kind === "read" ? canonical({ name: call.name, arguments: call.arguments }) : call.id;
      let index = owners.get(key);
      if (index === undefined) { index = unique.length; owners.set(key, index); unique.push(call); }
      indices[i] = index;
    }
    if (unique.length) {
      signal.throwIfAborted(); journal.assertLease(c);
      for (const call of unique) control?.activity?.(`tool:${call.name}`);
      // Transport/snapshot failure aborts the whole group. No partial receipts
      // can make replay skip edits that disappeared with the failed worker.
      const outcome = await o.executeBatch(unique);
      invariant(Array.isArray(outcome.results) && outcome.results.length === unique.length, "invalid backend batch results");
      if (batch.kind === "workspace-write") invariant(typeof outcome.patchHash === "string", "write batch patch missing");
      executions = unique.length; batchPatch = outcome.patchHash;
      for (const call of unique) control?.activity?.(`completed:${call.name}`);
      for (const [i] of batch.calls.entries()) if (!results[i])
        results[i] = { status: "fulfilled", value: outcome.results[indices[i]!]! };
    }
  } else {
    const workers = await Promise.allSettled(Array.from({ length: Math.min(batch.concurrency, batch.calls.length) }, worker));
    const failedWorker = workers.find(w => w.status === "rejected");
    if (failedWorker?.status === "rejected") throw failedWorker.reason;
  }
  signal.throwIfAborted(); journal.assertLease(c);
  if (batch.kind === "workspace-write") {
    const interrupted = results.find(r => r?.status === "rejected" &&
      (r.reason instanceof FatalAttemptError || r.reason instanceof DeferredAttemptError));
    if (interrupted?.status === "rejected") throw interrupted.reason;
  }
  // Includes partially applied failed edits; scope validation still rejects
  // any illegal delta. Never publish write results without the exact patch.
  if (batch.kind === "workspace-write" && rejected.size < batch.calls.length) {
    const patch = batchPatch ?? await o.snapshot();
    if (patch !== t.state.patchHash) control?.progress(`patch:${patch}`);
    t.state.patchHash = patch;
  }
  const deferred: DeferredAttemptError[] = [], stillPending: string[] = [];
  let terminal: Error | null = null;
  const receipts: Json[] = [];
  for (let i = 0; i < results.length; i++) {
    const call = batch.calls[i]!, outcome = results[i]!;
    if (!outcome) { stillPending.push(call.id); continue; }
    let result: Json;
    if (outcome.status === "rejected") {
      const e = outcome.reason;
      if (e instanceof DeferredAttemptError) { deferred.push(e); stillPending.push(call.id); continue; }
      if (e instanceof FatalAttemptError) { terminal ??= e; stillPending.push(call.id); continue; }
      result = { error: e instanceof Error ? e.message.slice(0, 2048) : "tool error" };
    } else result = outcome.value;
    const receipt = journal.receipt(c, result);
    if (batch.kind === "run_job" && outcome.status === "fulfilled") t.state.lastJobReceipt = receipt;
    t.state.history.push({ role: "tool", callId: call.id, receipt, content: inlineReceipt(receipt, result) });
    receipts.push({ callId: call.id, receipt });
  }
  if (carried.length || stillPending.length) t.state.pendingBatch = [...carried, ...stillPending];
  else delete t.state.pendingBatch;
  journal.checkpoint(t, "tool.batch.result", { kind: batch.kind, results: receipts,
    pending: stillPending, patchHash: t.state.patchHash, executions, durationMs: Math.max(0, performance.now() - started) });
  if (terminal) throw terminal;
  if (deferred.length) {
    if (batch.kind !== "run_job") throw deferred[0]!;
    const wakeAt = Math.min(...deferred.map(e => e.wakeAt)), capacity = deferred.find(e => e.capacity);
    throw new DeferredAttemptError("remote-job", wakeAt,
      capacity?.message ?? `${stillPending.length} remote experiment(s) still running; batch resume scheduled`, capacity?.capacity);
  }
  control?.activity?.(`${batch.kind === "run_job" ? "remote-batch" : "tool-batch"}:completed:${batch.calls.length}`);
}
