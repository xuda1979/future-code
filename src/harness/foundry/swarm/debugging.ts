import { canonical, digest, invariant } from "../kernel.ts";
import type { Json } from "../types.ts";
import type { PinnedSwarm } from "./config.ts";
import type { Call, Message } from "./context.ts";
import type { DiagnosticFailure } from "./diagnostics.ts";
import type { ThreadState } from "./session.ts";

export interface DebugObservation {
  check: string; receipt: string; fixture?: string; patchHash: string;
  atTurn: number; signature: string; excerpt: string;
  code: number | null;
}
export interface TriageCard {
  check: string; cycles: number; pattern: "repeated" | "oscillation" | "nonconvergent";
  question: string; receipts: string[];
}
export interface DebuggingState {
  evidenceKey: string;
  windows: Record<string, DebugObservation[]>;
  originalSymptom?: DebugObservation;
  resets: number;
  generation: number;
  writePaths: string[];
  probeRequired?: boolean;
  probe?: { observation: DebugObservation; hypothesis: string; falsifyWhen: string; negativeControl: string;
    evidenceKey: string; generation: number };
  deadlineAt?: number;
  card?: TriageCard;
  /** Frozen auditor input permits exact replay after a lost checkpoint. */
  audit?: { agent: string; history: Message[] };
  prunedReason?: string;
  prunedRecorded?: boolean;
}
const emptyPatch = digest("");
const writes = new Set(["write_file", "edit_file", "delete_file"]);
const evidenceKey = (s: ThreadState) => digest({ feedback: s.feedbackHash,
  job: s.lastJobReceipt ?? null, children: s.lastSpawnReceipt ?? null });
function memory(s: ThreadState): DebuggingState {
  const key = evidenceKey(s);
  const d = s.debugging ??= { evidenceKey: key, windows: {}, resets: 0, generation: 0, writePaths: [] };
  if (d.evidenceKey !== key) {
    d.evidenceKey = key; d.windows = {}; delete d.probe;
  }
  return d;
}
function beginDeadline(d: DebuggingState, cfg: PinnedSwarm): void {
  d.deadlineAt ??= Date.now() + cfg.spec.debugging!.branchTimeoutMs;
}

/** Called before tool effects, including every member of a write batch.
 * The first file may contain a reproduction; expanding to a second file needs
 * a completed probe. Failed probes suppress all remaining proposed effects. */
export function admitDebuggingCall(s: ThreadState, cfg: PinnedSwarm, call: Call): void {
  if (!cfg.spec.debugging) return;
  const d = memory(s);
  invariant(!d.prunedReason, d.prunedReason ?? "debugging trajectory ended");
  const supported = d.probe && d.probe.evidenceKey === d.evidenceKey && d.probe.generation === d.generation;
  if (d.probeRequired && ["run_check", "run_job", "spawn_tasks"].includes(call.name))
    invariant(supported, "FALSIFICATION_REQUIRED: establish the premise with run_probe before another full check, external job, or delegated trajectory");
  if (!writes.has(call.name)) return;
  const path = String(call.arguments.path);
  const broad = d.writePaths.some(p => p !== path);
  invariant(!(d.probeRequired || (broad && cfg.spec.debugging.requireProbeBeforeMultiFile)) || supported,
    "FALSIFICATION_REQUIRED: run a permitted micro-probe with a hypothesis and falsifier before expanding edits; a hypothesis or saved note is not evidence");
  if (!d.writePaths.includes(path) && d.writePaths.length < 2) d.writePaths.push(path);
  if (broad) beginDeadline(d, cfg);
}

/** Counts completed failing observations across source edits. A success clears
 * only the SAME check's window; unrelated passing checks cannot hide a loop.
 * Duplicate failures in one model turn cannot manufacture multiple cycles. */
export function recordDebugging(s: ThreadState, cfg: PinnedSwarm, call: Call, result: Json,
  receipt: string, beforePatch: string | null, admitted: boolean, failure: DiagnosticFailure | null): void {
  if (!cfg.spec.debugging || !admitted || !["run_check", "run_probe"].includes(call.name)) return;
  const d = memory(s), r = result as any;
  const unchanged = (beforePatch ?? emptyPatch) === (s.patchHash ?? emptyPatch);
  const code = Number.isSafeInteger(r?.code) && r.code >= 0 ? r.code as number : null;
  const observation: DebugObservation = { check: String(call.arguments.name), receipt,
    ...(failure ? { fixture: failure.fixture } : {}), patchHash: s.patchHash ?? emptyPatch,
    atTurn: s.turns, signature: digest({ check: call.arguments.name, result }),
    excerpt: failure?.excerpt ?? "", code };
  if (call.name === "run_probe") {
    beginDeadline(d, cfg);
    delete d.probe;
    if (code !== 0 || !unchanged) {
      d.originalSymptom ??= observation;
      d.card = triageCard([observation]);
      d.prunedReason = `${code === null || !unchanged ? "PROBE_INCONCLUSIVE" : "PREMISE_PROBE_FAILED"}: probe=${observation.check} receipt=${receipt}; stop this trajectory and re-examine its premise`;
    } else {
      d.probe = { observation, hypothesis: String(call.arguments.hypothesis),
        falsifyWhen: String(call.arguments.falsifyWhen), negativeControl: String(call.arguments.negativeControl),
        evidenceKey: d.evidenceKey, generation: d.generation };
      d.probeRequired = false;
    }
    return;
  }
  // A command that changed the candidate cannot establish a stable diagnostic.
  if (!unchanged) return;
  if (code === 0) {
    delete d.windows[observation.check];
    if (d.card?.check === observation.check) delete d.card;
    return;
  }
  if (!failure) return;
  d.originalSymptom ??= observation;
  d.generation++; delete d.probe;
  beginDeadline(d, cfg);
  const window = Object.hasOwn(d.windows, observation.check) ? d.windows[observation.check]! : [];
  if (window.at(-1)?.atTurn === s.turns) window.pop();
  d.windows = { ...d.windows, [observation.check]: [...window, observation].slice(-cfg.spec.debugging.maxFailedCycles) };
  // Bound distinct named checks in hot state as well as each individual window.
  const names = Object.keys(d.windows);
  if (names.length > 8) delete d.windows[names[0]!];
}

export function inversionCandidate(s: ThreadState, cfg: PinnedSwarm): DebugObservation[] | null {
  if (!cfg.spec.debugging || !s.debugging) return null;
  const d = memory(s);
  return Object.values(d.windows).find(w => w.length >= cfg.spec.debugging!.maxFailedCycles) ?? null;
}
export function triageCard(window: DebugObservation[]): TriageCard {
  const signatures = window.map(o => o.signature);
  const last = signatures.slice(-4);
  const oscillation = last.length === 4 && last[0] === last[2] && last[1] === last[3] && last[0] !== last[1];
  return { check: window.at(-1)!.check, cycles: window.length,
    pattern: oscillation ? "oscillation" : new Set(signatures).size === 1 ? "repeated" : "nonconvergent",
    question: `Does the failing capability in check '${window.at(-1)!.check}' exist in this deployment? Confirm the runtime, environment, and dependency contract before another broad patch.`,
    receipts: [...new Set(window.map(o => o.receipt))].slice(-4) };
}

/** Exact observations outrank prose notes. Exit codes do not establish an
 * architectural explanation, and a passing probe is never task acceptance. */
export function systemStateLedger(s: ThreadState): Json {
  const d = s.debugging;
  const observations = d ? Object.values(d.windows).flat().slice(-4) : [];
  return JSON.parse(canonical({ trust: "OBSERVATION_NOT_ACCEPTANCE",
    precedence: "Use host observations before working hypotheses; retain their input binding and uncertainty.",
    currentPatch: s.patchHash ?? emptyPatch,
    originalSymptom: d?.originalSymptom ? { ...d.originalSymptom,
      currentPatch: d.originalSymptom.patchHash === (s.patchHash ?? emptyPatch) } : null,
    observations: observations.map(o => ({ ...o, currentPatch: o.patchHash === (s.patchHash ?? emptyPatch) })),
    probe: d?.probe ? { ...d.probe.observation, currentPatch: d.probe.observation.patchHash === (s.patchHash ?? emptyPatch),
      currentEvidence: d.probe.evidenceKey === evidenceKey(s) && d.probe.generation === d.generation,
      hypothesis: { trust: "UNVERIFIED_AGENT_HYPOTHESIS", statement: d.probe.hypothesis,
        falsifyWhen: d.probe.falsifyWhen, negativeControl: d.probe.negativeControl } } : null,
    triage: d?.card ?? null,
  }));
}

/** Freeze raw symptom and contracts only. No patches, freeform progress notes,
 * failed-attempt transcript, or prior diagnosis enters the independent audit. */
export function prepareInversion(s: ThreadState, cfg: PinnedSwarm, task: { goal: string; acceptance: string[]; agent?: string },
  window: DebugObservation[], agent: string): void {
  const d = memory(s); d.card = triageCard(window);
  if (d.resets >= cfg.spec.debugging!.maxInversionResets) {
    d.prunedReason = `NONCONVERGENT_DEBUGGING: check=${d.card.check} cycles=${d.card.cycles} pattern=${d.card.pattern}; inversion budget exhausted. ${d.card.question}`;
    return;
  }
  d.audit = { agent, history: [{ role: "user", content: canonical({
    task: { goal: task.goal, acceptance: task.acceptance },
    rawInitialSymptom: d.originalSymptom ?? window[0],
    constraints: { baseCommit: cfg.baseCommit, protectedPaths: cfg.spec.protectedPaths,
      availableProbes: cfg.spec.agents[task.agent ?? cfg.spec.defaultAgent]!.probes ?? [] },
    instruction: "Assume the current approach is fundamentally impossible. Identify three distinct architectural, environmental, or dependency-contract reasons. For each, propose the cheapest falsifying experiment and a negative control. State uncertainty explicitly. You have no execution or acceptance authority.",
  }) }] };
}

export function finishInversion(s: ThreadState, audit: string, receipt: string): void {
  const d = s.debugging!;
  d.resets++; d.windows = {}; d.probeRequired = true; delete d.probe;
  delete s.progress; delete s.recoveryNote;
  const ledger = systemStateLedger(s);
  s.history = [s.history[0]!, { role: "user", content: canonical({ inversionReset: d.resets,
    systemStateLedger: ledger,
    auditor: { trust: "UNVERIFIED_AGENT_HYPOTHESES", receipt, hypotheses: audit },
    instruction: "Previous theories and failed-attempt transcripts were retired from this context. Preserve the durable evidence. Falsify the premise using run_probe before editing; do not repeat the failed strategy. Ask the operator the triage question if the capability cannot be established by permitted probes.",
  }) }];
  delete d.audit;
}
