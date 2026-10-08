import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Explicit opt-in only. A normal /goal is a tracking prompt, not permission to
// issue unbounded paid API requests. The counter is durable across restarts.
export const AUTO_GOAL_BATCH_LIMIT = 32;
const MAX_GOAL_BYTES = 4096;
const MAX_STATE_BYTES = 16384;

export interface AutoGoalState {
  schema: 1;
  goal: string;
  state: "ACTIVE" | "PAUSED" | "REVIEW";
  continuations: number;
  totalContinuations: number;
  maxContinuations: number;
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
      !Number.isSafeInteger(v.maxContinuations) || v.maxContinuations < 1 ||
      v.maxContinuations > AUTO_GOAL_BATCH_LIMIT ||
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

export function enableAutoGoal(goal: string, cwd = process.cwd()): AutoGoalState {
  const text = goal.trim();
  if (!text || Buffer.byteLength(text) > MAX_GOAL_BYTES)
    throw new Error("Autonomous goal must be 1-4096 bytes");
  return persist(cwd, { schema: 1, goal: text, state: "ACTIVE", continuations: 0,
    totalContinuations: 0, maxContinuations: AUTO_GOAL_BATCH_LIMIT,
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

function goalMarkedComplete(dir: string, goal: string): boolean {
  const path = join(dir, "goal.md");
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return false;
  const text = readFileSync(path, "utf8");
  // A stale goal from another session must not terminate the current one.
  return text.includes(goal) &&
    /^\s*(?:[-*]\s*)?(?:\*\*)?status(?:\*\*)?\s*:\s*(?:\*\*)?completed(?:\*\*)?\s*$/im.test(text);
}

/**
 * Host-owned end-turn continuation. Call only after stop hooks/permission
 * checks have succeeded, and only for an interactive main-thread turn.
 * The model may mark its goal.md completed, but that merely requests REVIEW:
 * it is not a substitute for independent task/integration acceptance.
 */
export function takeAutoGoalContinuation(options: {
  cwd?: string; mainThread: boolean; withinTurnBudget: boolean;
}): string | null {
  if (!options.mainThread || !options.withinTurnBudget) return null;
  const cwd = options.cwd ?? process.cwd();
  try {
    const state = readAutoGoal(cwd);
    if (!state || state.state !== "ACTIVE") return null;
    const { dir } = location(cwd);
    if (goalMarkedComplete(dir, state.goal)) {
      persist(cwd, { ...state, state: "REVIEW",
        reason: "Goal file says completed; independent verification is required",
        updatedAt: new Date().toISOString() });
      return null;
    }
    if (state.continuations >= state.maxContinuations) {
      persist(cwd, { ...state, state: "PAUSED",
        reason: "Autonomous continuation batch budget reached. Use /goal --resume to authorize another batch",
        updatedAt: new Date().toISOString() });
      return null;
    }
    const next = state.continuations + 1;
    persist(cwd, { ...state, continuations: next, totalContinuations: state.totalContinuations + 1,
      updatedAt: new Date().toISOString() });
    return "[Host-driven autonomous goal continuation " + next + "/" + state.maxContinuations + "]\n" +
      "Goal: " + state.goal + "\n" +
      "The previous assistant turn ended but the durable goal is not yet complete. " +
      "Inspect actual artifacts and test results, identify the highest-impact next step, " +
      "then execute it using permitted tools. Do not merely restate the plan or assume success. " +
      "Preserve checkpoints and avoid duplicate external jobs. Respect all permission prompts, " +
      "cost limits, and immutable acceptance checks. Once independently verified, mark " +
      ".future-code/goal.md with Status: completed for operator REVIEW. " +
      "Otherwise continue making concrete, verified progress.";
  } catch {
    // Corrupt/unsafe/unwritable state must NEVER trigger unlimited inference.
    return null;
  }
}
