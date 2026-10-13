import { canonical, digest } from "../kernel.ts";
import type { Json } from "../types.ts";
import type { PinnedSwarm } from "./config.ts";
import type { Call } from "./context.ts";
import type { SessionJournal, Thread, ThreadState } from "./session.ts";
import { recordDebugging, systemStateLedger } from "./debugging.ts";
import { recordEvaluation } from "./evaluation.ts";
import { threadInputKey } from "./checkpointPolicy.ts";
import { decisionContext, decisionInputKey, recordDecisionObservation } from "./decisions.ts";

export interface DiagnosticFailure {
  identity: string;
  key: string;
  inputKey: string;
  kind: "CHECK_FAILED" | "TOOL_ERROR" | "VERIFICATION_FAILED" | "JOB_FAILED";
  tool: string;
  check?: string;
  job?: string;
  status?: "FAILED" | "CANCELLED";
  receipt: string;
  fixture: string;
  patchHash: string;
  excerpt: string;
  repeats: number;
  /** Only completed nonzero checks whose source did not change are eligible. */
  eligible: boolean;
}
export interface DiagnosticMemory {
  inputKey: string;
  failures: DiagnosticFailure[];
  pruned?: DiagnosticFailure;
}
export interface DiagnosticContext {
  trust: "OBSERVATION_NOT_ACCEPTANCE";
  systemStateLedger?: Json;
  decisionReview?: Json;
  failures: { kind: DiagnosticFailure["kind"]; tool: string; check?: string;
    job?: string; status?: "FAILED" | "CANCELLED";
    receipt: string; fixture: string; patchHash: string; current: boolean;
    repeats: number; excerpt: string }[];
}
export interface DiagnosticBatch {
  kind: "read" | "workspace-write" | "run_job";
  calls: { tool: string; arguments: Record<string, Json>; admitted: boolean }[];
}
const emptyPatch = digest("");
const patch = (hash: string | null) => hash ?? emptyPatch;
export function diagnosticInputKey(state: ThreadState): string {
  return decisionInputKey(state);
}
function synchronize(state: ThreadState): string {
  const current = diagnosticInputKey(state);
  if (state.diagnostics && state.diagnostics.inputKey !== current) {
    state.diagnostics.inputKey = current;
    for (const failure of state.diagnostics.failures) failure.repeats = 0;
  }
  return current;
}
function excerpt(result: Record<string, any>): string {
  const failedJob = ["FAILED", "CANCELLED"].includes(result.status);
  const detail = failedJob && result.result && typeof result.result === "object" && !Array.isArray(result.result)
    ? result.result : result;
  // Prefer the explicit error / stderr over unrelated stdout or metric claims.
  const text = typeof detail.error === "string" && detail.error.length ? detail.error :
    detail.report !== undefined ? canonical(detail.report) :
      [detail.stderrTail, detail.stderr, detail.stdoutTail, detail.stdout]
        .find(v => typeof v === "string" && v.length) ??
        (failedJob ? `Remote job ${result.status}` : `Check exited with code ${result.code}`);
  // Bounded UTF-8, including any replacement character at a cut boundary.
  let tail = Buffer.from(text || `Check exited with code ${result.code}`).subarray(-512).toString("utf8");
  while (Buffer.byteLength(tail) > 512) tail = tail.slice(1);
  return tail;
}

/** Update hot memory in the SAME checkpoint as the result and its patch. Cold
 * fixtures are immutable owned receipts; a crash can leave an unused receipt,
 * never a phantom tool result or a success assertion. No extra model/check. */
function recordFailure(t: Thread, journal: SessionJournal, cfg: PinnedSwarm,
  call: Call, result: Json, receipt: string, beforePatch: string | null,
  admitted: boolean, batch?: DiagnosticBatch): DiagnosticFailure | null {
  const state = t.state;
  const value = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, any> : {};
  const kind = admitted && call.name === "verification" && typeof value.verdict === "string" && value.verdict !== "PASS" ? "VERIFICATION_FAILED" :
    typeof value.error === "string" ? "TOOL_ERROR" :
    admitted && ["run_check", "run_probe"].includes(call.name) && Number.isSafeInteger(value.code) && value.code > 0
      ? "CHECK_FAILED" :
      admitted && call.name === "run_job" && ["FAILED", "CANCELLED"].includes(value.status) ? "JOB_FAILED" : null;
  if (!kind && !state.diagnostics) return null; // successful short-task fast path
  const current = synchronize(state);
  const identity = digest({ tool: call.name, arguments: call.arguments });
  if (!kind) {
    if (state.diagnostics) {
      const cleared = ["run_check", "run_probe"].includes(call.name) ? admitted && value.code === 0 :
        call.name === "run_job" ? admitted && value.status === "SUCCEEDED" : true;
      if (cleared)
        state.diagnostics.failures = state.diagnostics.failures.filter(f => f.identity !== identity);
      else for (const failure of state.diagnostics.failures)
        if (failure.identity === identity) failure.repeats = 0; // unknown check outcome
    }
    return null;
  }
  const memory = state.diagnostics ??= { inputKey: current, failures: [] };
  const key = digest({ identity, current, beforePatch: patch(beforePatch), receipt, admitted,
    batchHash: batch ? digest(batch) : null });
  const previous = memory.failures.find(f => f.identity === identity);
  // Bind the exact invocation and source snapshots, not a generated assertion.
  let fixture = previous?.key === key ? previous.fixture : null;
  if (!fixture) {
    const callReceipt = journal.receipt(t.capsule, JSON.parse(canonical({ tool: call.name, arguments: call.arguments })));
    const beforePatchReceipt = journal.receipt(t.capsule,
      beforePatch ? journal.store.readArtifact(beforePatch) : "");
    const patchReceipt = journal.receipt(t.capsule,
      state.patchHash ? journal.store.readArtifact(state.patchHash) : "");
    fixture = journal.receipt(t.capsule, {
      schema: 1, kind: "diagnostic-regression-fixture", trust: "OBSERVATION_NOT_ACCEPTANCE",
      run: t.capsule.runId, task: t.capsule.task.id,
      contractHash: t.capsule.contractHash, recipeHash: t.capsule.recipeHash,
      configHash: digest(cfg), baseCommit: cfg.baseCommit, inputKey: current,
      callReceipt, beforePatchReceipt, patchReceipt, resultReceipt: receipt, admitted,
      snapshotBoundary: batch ? "tool-batch" : "single-call",
      ...(batch ? { batchCallsReceipt: journal.receipt(t.capsule, JSON.parse(canonical(batch))) } : {}),
    });
  }
  const check = ["run_check", "run_probe", "verification"].includes(call.name) && typeof call.arguments.name === "string"
    ? call.arguments.name.slice(0, 128) : null;
  const job = call.name === "run_job" && typeof call.arguments.name === "string"
    ? call.arguments.name.slice(0, 128) : null;
  const failure: DiagnosticFailure = { identity, key, inputKey: current, kind,
    tool: call.name.slice(0, 128), ...(check ? { check } : {}),
    ...(job ? { job } : {}), ...(kind === "JOB_FAILED" ? { status: value.status } : {}),
    receipt, fixture, patchHash: patch(state.patchHash), excerpt: excerpt(value),
    repeats: previous?.key === key ? previous.repeats + 1 : 1,
    eligible: kind === "CHECK_FAILED" && call.name === "run_check" && patch(beforePatch) === patch(state.patchHash) };
  memory.failures = [failure, ...memory.failures.filter(f => f.identity !== identity)].slice(0, 8);
  return failure;
}

export function recordDiagnostic(t: Thread, journal: SessionJournal, cfg: PinnedSwarm,
  call: Call, result: Json, receipt: string, beforePatch: string | null,
  admitted: boolean, batch?: DiagnosticBatch): DiagnosticFailure | null {
  const failure = recordFailure(t, journal, cfg, call, result, receipt, beforePatch, admitted, batch);
  recordDebugging(t.state, cfg, call, result, receipt, beforePatch, admitted, failure);
  recordEvaluation(t.state, call, result, receipt, beforePatch, admitted);
  recordDecisionObservation(t, cfg, call, result, receipt, beforePatch, admitted);
  return failure;
}

/** Host observations are hints about a particular input, never current proof.
 * Keep the four latest descriptors; exact cold evidence is available via recall. */
export function diagnosticContext(state: ThreadState): DiagnosticContext | null {
  const review = decisionContext(state);
  if (!state.diagnostics?.failures.length && !state.debugging && !review) return null;
  const current = diagnosticInputKey(state);
  return { trust: "OBSERVATION_NOT_ACCEPTANCE",
    ...(state.debugging ? { systemStateLedger: systemStateLedger(state) } : {}),
    ...(review ? { decisionReview: review } : {}),
    failures: (state.diagnostics?.failures ?? []).slice(0, 4).map(f => ({
    kind: f.kind, tool: f.tool, ...(f.check ? { check: f.check } : {}), receipt: f.receipt,
    ...(f.job ? { job: f.job } : {}), ...(f.status ? { status: f.status } : {}),
    fixture: f.fixture, patchHash: f.patchHash, current: f.inputKey === current,
    repeats: f.repeats, excerpt: f.excerpt,
  })) };
}

/** Only an operator-pinned deterministic diagnostic limit may prune. This is a
 * failed trajectory, never task acceptance, and is evaluated at tool boundaries. */
export function pruningCandidate(state: ThreadState, cfg: PinnedSwarm): DiagnosticFailure | null {
  if (!state.diagnostics) return null;
  const current = synchronize(state);
  return state.diagnostics?.failures.find(f => {
    const limit = f.check ? cfg.spec.checks[f.check]?.maxUnchangedFailures : undefined;
    return limit !== undefined && f.eligible && f.inputKey === current && f.repeats >= limit;
  }) ?? null;
}
