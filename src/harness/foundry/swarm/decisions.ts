import { digest, invariant } from "../kernel.ts";
import type { Json } from "../types.ts";
import type { PinnedSwarm } from "./config.ts";
import type { Call } from "./context.ts";
import type { SessionJournal, Thread, ThreadState } from "./session.ts";

export interface MeasurementObservation {
  name: string; receipt: string; inputKey: string; code: number; atTurn: number;
}
export interface DecisionReview {
  writeTurns: number; measurementChecks: string[];
  instruction: string;
}
export interface DecisionState {
  writeTurns: number;
  lastWriteTurn?: number;
  measurements: Record<string, MeasurementObservation>;
  lastMeasurement?: MeasurementObservation;
  review?: DecisionReview;
  noticeKey?: string;
  reviews: number;
}
const writes = new Set(["write_file", "edit_file", "delete_file"]);
const emptyPatch = digest("");

/** Matches diagnostic currentness: source plus host feedback/child/job evidence. */
export function decisionInputKey(s: ThreadState): string {
  return digest({ patchHash: s.patchHash ?? emptyPatch, feedbackHash: s.feedbackHash,
    jobReceipt: s.lastJobReceipt ?? null, spawnReceipt: s.lastSpawnReceipt ?? null });
}

/** Called in the same durable checkpoint as the tool result, including batches.
 * Only declared measurements count. Prose, reads and unrelated passing checks
 * cannot clear an overdue review; failures are useful observations, not PASS. */
export function recordDecisionObservation(t: Thread, cfg: PinnedSwarm, call: Call,
  result: Json, receipt: string, beforePatch: string | null, admitted: boolean): void {
  if (!admitted) return;
  const s = t.state, profile = cfg.spec.agents[t.capsule.task.agent ?? cfg.spec.defaultAgent];
  const policy = profile.decisionPolicy;
  const name = String(call.arguments.name);
  const selected = policy?.measurementChecks.includes(name);
  const preflight = (profile.jobs ?? []).some(job => cfg.spec.jobs?.[job]?.preflightChecks?.includes(name));
  const changed = (beforePatch ?? emptyPatch) !== (s.patchHash ?? emptyPatch);
  const isWrite = writes.has(call.name) && changed && policy;
  const isCheck = call.name === "run_check" && (selected || preflight);
  if (!isWrite && !isCheck) return;
  const d = s.decisions ??= { writeTurns: 0, measurements: {}, reviews: 0 };
  if (isWrite && d.lastWriteTurn !== s.turns) {
    d.writeTurns++; d.lastWriteTurn = s.turns;
    if (d.writeTurns >= policy!.maxUnmeasuredWriteTurns) d.review = {
      writeTurns: d.writeTurns, measurementChecks: policy!.measurementChecks,
      instruction: "Source changed across several model turns without a new declared measurement. Identify the key uncertainty and run the smallest relevant named measurement before further edits or a new external job. Describe how its outcomes change your next action. Reads and working notes remain available; independent acceptance is unchanged.",
    };
  }
  if (!isCheck) return;
  const previous = Object.hasOwn(d.measurements, name) ? d.measurements[name] : undefined;
  const r = result as any;
  // Unknown, rejected and source-mutating outcomes invalidate any older support.
  delete d.measurements[name];
  if (changed || !Number.isSafeInteger(r?.code) || r.code < 0 || r.error !== undefined) return;
  const observation: MeasurementObservation = { name, receipt, code: r.code,
    inputKey: decisionInputKey(s), atTurn: s.turns };
  d.measurements = { ...d.measurements, [name]: observation };
  if (selected && (previous?.receipt !== receipt || previous.inputKey !== observation.inputKey)) {
    d.lastMeasurement = observation;
    d.writeTurns = 0; delete d.lastWriteTurn; delete d.review; delete d.noticeKey;
  }
}

export function requireDecisionMeasurement(s: ThreadState): void {
  invariant(!s.decisions?.review, "DECISION_MEASUREMENT_REQUIRED: " +
    `run a declared measurement (${s.decisions?.review?.measurementChecks.join(", ")}) before more source-changing turns or new external work; a plan or unrelated check cannot clear this review`);
}

/** Remaining edits within one already admitted model turn stay ordered. */
export function admitDecisionCall(s: ThreadState, call: Call): void {
  if (writes.has(call.name) && s.decisions?.lastWriteTurn !== s.turns) requireDecisionMeasurement(s);
}

/** Bounded host observation projection survives ordinary context retirement. */
export function decisionContext(s: ThreadState): Json | null {
  if (!s.decisions?.review) return null;
  return { trust: "OBSERVATION_NOT_ACCEPTANCE", ...s.decisions.review,
    inputKey: decisionInputKey(s), lastMeasurement: s.decisions.lastMeasurement
      ? { ...s.decisions.lastMeasurement, current: s.decisions.lastMeasurement.inputKey === decisionInputKey(s) } : null };
}

/** Exact owned results authorize a declared prerequisite, never task completion.
 * Called transactionally BEFORE a new job intent. Existing jobs bypass this
 * gate so stale evidence can never prevent reconciliation of admitted effects. */
export function jobPreflight(journal: SessionJournal, t: ThreadState, c: Thread["capsule"],
  checks: string[]): Json {
  requireDecisionMeasurement(t);
  const inputKey = decisionInputKey(t);
  const observations = checks.map(name => {
    const observation = t.decisions?.measurements[name];
    invariant(observation && observation.code === 0 && observation.inputKey === inputKey &&
      journal.ownsReceipt(c, observation.receipt),
      `JOB_PREFLIGHT_REQUIRED: run_check '${name}' must complete successfully on the current source and evidence before a new job; unrelated, failed, unknown or stale results do not qualify`);
    const result = journal.store.readArtifact(observation.receipt) as any;
    invariant(result?.code === 0 && result.error === undefined, "JOB_PREFLIGHT_REQUIRED: invalid measurement receipt");
    return { name, receipt: observation.receipt, inputKey, atTurn: observation.atTurn };
  });
  return { schema: 1, kind: "job-preflight", trust: "OBSERVATION_NOT_ACCEPTANCE",
    run: c.runId, task: c.task.id,
    measurementChecks: checks, observations, inputKey,
    patchHash: t.patchHash ?? emptyPatch };
}
