import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// A /goal authorizes continued work until REVIEW, an explicit pause, or a
// concrete blocker. Optional operator limits remain durable across restarts.
export const AUTO_GOAL_BATCH_LIMIT = 32;
// Larger budgets require explicit per-goal operator authorization.
export const MAX_AUTO_GOAL_CONTINUATIONS = 100_000;
const MAX_GOAL_BYTES = 4096;
const MAX_STATE_BYTES = 16384;

export interface AutoGoalState {
  schema: 1;
  goal: string;
  state: "ACTIVE" | "PAUSED" | "REVIEW";
  continuations: number;
  totalContinuations: number;
  maxContinuations: number | null;
  updatedAt: string;
  reason: string | null;
}

function location(cwd: string): { dir: string; file: string } {
  const dir = resolve(cwd, ".future-code");
  return { dir, file: join(dir, "goal-autonomy.json") };
}

function checkDirectory(dir: string, create: boolean): boolean {
  if (!existsSync(dir)) {
    if (!create) return false;
    mkdirSync(dir, { recursive: true });
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("Unsafe .future-code state directory");
  return true;
}

function checkFile(file: string): void {
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Unsafe goal-autonomy state file");
}

function validate(value: unknown): AutoGoalState {
  const v = value as AutoGoalState;
  if (!v || typeof v !== "object" || v.schema !== 1 ||
      typeof v.goal !== "string" || !v.goal.trim() ||
      Buffer.byteLength(v.goal) > MAX_GOAL_BYTES ||
      !["ACTIVE", "PAUSED", "REVIEW"].includes(v.state) ||
      !Number.isSafeInteger(v.continuations) || v.continuations < 0 ||
      !Number.isSafeInteger(v.totalContinuations) || v.totalContinuations < v.continuations ||
      (v.maxContinuations !== null && (!Number.isSafeInteger(v.maxContinuations) ||
        v.maxContinuations < 1 || v.maxContinuations > MAX_AUTO_GOAL_CONTINUATIONS)) ||
      typeof v.updatedAt !== "string" ||
      (v.reason !== null && typeof v.reason !== "string"))
    throw new Error("Invalid autonomous-goal state (fail closed)");
  return v;
}

export function readAutoGoal(cwd = process.cwd()): AutoGoalState | null {
  const { dir, file } = location(cwd);
  if (!checkDirectory(dir, false)) return null;
  checkFile(file);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error("Autonomous-goal state too large");
  return validate(JSON.parse(raw));
}

function persist(cwd: string, state: AutoGoalState): AutoGoalState {
  validate(state);
  const { dir, file } = location(cwd);
  checkDirectory(dir, true);
  checkFile(file);
  const tmp = join(dir, ".goal-autonomy-" + randomUUID() + ".tmp");
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return state;
}

export function enableAutoGoal(goal: string, cwd = process.cwd(), maxContinuations: number | null = null): AutoGoalState {
  const text = goal.trim();
  if (!text || Buffer.byteLength(text) > MAX_GOAL_BYTES)
    throw new Error("Autonomous goal must be 1-4096 bytes");
  if (maxContinuations !== null && (!Number.isSafeInteger(maxContinuations) || maxContinuations < 1 || maxContinuations > MAX_AUTO_GOAL_CONTINUATIONS))
    throw new Error("Autonomous continuation limit must be 1-100000 (explicit operator budget)");
  return persist(cwd, { schema: 1, goal: text, state: "ACTIVE", continuations: 0,
    totalContinuations: 0, maxContinuations,
    updatedAt: new Date().toISOString(), reason: null });
}

export function pauseAutoGoal(cwd = process.cwd(), reason = "Paused by operator"): AutoGoalState | null {
  const state = readAutoGoal(cwd);
  if (!state) return null;
  return persist(cwd, { ...state, state: "PAUSED", reason, updatedAt: new Date().toISOString() });
}

export function resumeAutoGoal(cwd = process.cwd()): AutoGoalState | null {
  const state = readAutoGoal(cwd);
  if (!state) return null;
  // Reauthorizing is an explicit user command, never an automatic budget reset.
  return persist(cwd, { ...state, state: "ACTIVE", continuations: 0,
    reason: null, updatedAt: new Date().toISOString() });
}

function goalFileOutcome(dir: string, goal: string): { state: 'REVIEW' | 'PAUSED'; reason: string } | null {
  const path = join(dir, "goal.md");
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
  const text = readFileSync(path, "utf8");
  // A stale goal from another session must not terminate the current one.
  if (!text.includes(goal)) return null;
  const status = /^\s*(?:[-*]\s*)?(?:\*\*)?status(?:\*\*)?\s*:\s*(?:\*\*)?(completed|blocked)(?:\*\*)?\s*$/im.exec(text)?.[1]?.toLowerCase();
  if (status === 'completed') return { state: 'REVIEW',
    reason: 'Goal file declares completion; independent acceptance is still required. Review the verified artifacts.' };
  const blocker = /^\s*(?:[-*]\s*)?(?:\*\*)?blocker(?:\*\*)?\s*:\s*(\S[^\r\n]*)/im.exec(text)?.[1]?.trim();
  return status === 'blocked' && blocker ? { state: 'PAUSED', reason: 'Reported unresolved blocker: ' + blocker.slice(0, 768) } : null;
}

/**
 * A GOAL is a durable host contract. A model turn ending is not completion.
 * This decision has a distinct BLOCKED outcome so callers cannot mistake an
 * exhausted budget, rejected completion, or unreadable state for normal EOF.
 */
export type AutoGoalDecision =
  | { kind: "SKIP" }
  | { kind: "CONTINUE"; prompt: string }
  | { kind: "BLOCKED"; reason: string };

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown error";
}

/** Persist interruption by the host (API errors, stop hooks, caller limits).
 * Never reset a continuation budget or turn a failure into completion. */
export function parkActiveAutoGoal(reason: string, cwd = process.cwd()): string | null {
  try {
    const state = readAutoGoal(cwd);
    if (!state || state.state !== "ACTIVE") return null;
    const why = reason.slice(0, 1024);
    persist(cwd, { ...state, state: "PAUSED", reason: why,
      updatedAt: new Date().toISOString() });
    return why;
  } catch (error) {
    return "Autonomous-goal state could not be safely persisted: " + errorDetail(error);
  }
}

/**
 * Host-owned end-turn continuation. Evaluate only for an interactive main
 * thread, after permission/stop checks. An explicitly authorized continuation
 * budget is immutable until /goal --resume or a new goal is issued.
 */
export function decideAutoGoalContinuation(options: {
  cwd?: string; mainThread: boolean; withinTurnBudget: boolean;
}): AutoGoalDecision {
  if (!options.mainThread) return { kind: "SKIP" };
  const cwd = options.cwd ?? process.cwd();
  try {
    const state = readAutoGoal(cwd);
    if (!state || state.state !== "ACTIVE") return { kind: "SKIP" };
    const blocked = (nextState: "PAUSED" | "REVIEW", reason: string): AutoGoalDecision => {
      persist(cwd, { ...state, state: nextState, reason,
        updatedAt: new Date().toISOString() });
      return { kind: "BLOCKED", reason };
    };
    const { dir } = location(cwd);
    const outcome = goalFileOutcome(dir, state.goal);
    if (outcome) return blocked(outcome.state, outcome.reason);
    if (!options.withinTurnBudget)
      return blocked("PAUSED", "Caller max-turns boundary reached before objective acceptance. Increase the caller limit explicitly, then /goal --resume.");
    if (state.maxContinuations !== null && state.continuations >= state.maxContinuations)
      return blocked("PAUSED", "Authorized autonomous continuation budget exhausted (" +
        state.maxContinuations + " turns). Use /goal --resume or re-arm with /goal --auto --limit N <goal>.");
    const next = state.continuations + 1;
    persist(cwd, { ...state, continuations: next, totalContinuations: state.totalContinuations + 1,
      updatedAt: new Date().toISOString() });
    return { kind: "CONTINUE", prompt: "[Host-driven autonomous goal continuation " + next +
      (state.maxContinuations === null ? "" : "/" + state.maxContinuations) + "]\n" +
      "Goal: " + state.goal + "\n" +
      "The previous assistant turn ended but the durable goal is not yet complete. " +
      "Inspect actual artifacts and test results, identify the highest-impact next step, " +
      "then execute it using permitted tools. Do not merely restate the plan or assume success. " +
      "Preserve checkpoints and avoid duplicate external jobs. Respect all permission prompts, " +
      "cost limits, and immutable acceptance checks. Once independently verified, mark " +
      ".future-code/goal.md with Status: completed for operator REVIEW. " +
      "For a recoverable obstacle, diagnose and try another supported approach. If no safe approach remains, " +
      "write Status: blocked and Blocker: <specific cause and attempted recovery> to .future-code/goal.md, " +
      "then report the blocker and next action to the user." };
  } catch (error) {
    // Fail closed, but NEVER silently treat a corrupt or unwritable state as
    // a completed goal; the parent query must display this diagnostic.
    return { kind: "BLOCKED", reason: "Autonomous-goal state unavailable: " +
      errorDetail(error) + ". Repair state or permissions before resuming." };
  }
}

/** Output styles change presentation, never the main thread's goal contract. */
export function isAutoGoalMainThread(querySource: string, agentId?: string, nonInteractive = false): boolean {
  return !agentId && !nonInteractive &&
    (querySource === "repl_main_thread" || querySource.startsWith("repl_main_thread:outputStyle:"));
}

/** An urgent user message hands off the turn; it does not cancel the goal. */
export function shouldPauseGoalAfterTerminal(reason: string, abortReason?: unknown): boolean {
  return reason !== 'completed' && !(
    abortReason === 'interrupt' && (reason === 'aborted_streaming' || reason === 'aborted_tools')
  );
}

/** Compatibility adapter for callers that only need the continuation text. */
export function takeAutoGoalContinuation(options: {
  cwd?: string; mainThread: boolean; withinTurnBudget: boolean;
}): string | null {
  const decision = decideAutoGoalContinuation(options);
  return decision.kind === "CONTINUE" ? decision.prompt : null;
}

