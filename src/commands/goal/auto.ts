import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DECISION_GUIDANCE } from "../../harness/decisionGuidance.ts";
import { AUTONOMOUS_QUESTION_REDIRECT, executionProse, isRoutineDecisionHandoff } from "../../harness/autonomyPolicy.ts";
import { getAutoGoalSessionId, isAutoGoalBackgroundTurn } from "../../utils/autoGoalSession.ts";
import { parseLoopTask } from "../loop/task.ts";

// A /goal authorizes continued work until REVIEW, an explicit pause, or a
// concrete blocker. Optional operator limits remain durable across restarts.
export const AUTO_GOAL_BATCH_LIMIT = 32;
// Larger budgets require explicit per-goal operator authorization.
export const MAX_AUTO_GOAL_CONTINUATIONS = 100_000;
const MAX_GOAL_BYTES = 4096;
const MAX_STATE_BYTES = 512 * 1024;
const MAX_SUPERSEDED_GOALS = 8;
const MAX_STEERING_NOTES = 64;
const MAX_ROUTINE_DECISION_CORRECTIONS = 2;

// A model may report a dependency failure, but an ordinary implementation or
// test failure is work to do, not permission to retire the objective.
const EXTERNAL_BLOCKER_TYPES = new Set([
  "hardware", "network", "provider", "credentials", "permissions", "resources", "external_dependency",
]);
export const AUTO_GOAL_BLOCKER_GUIDANCE =
  "Keep working until the final objective is independently verified. Diagnose recoverable failures, " +
  "change the failed approach, and continue without asking the user to say continue. " +
  "A failed test, unfinished plan, or difficult task is not an external blocker. " +
  "Only when further progress requires something outside your available tools and authority, " +
  "write Status: blocked, Blocker: <specific error>, Blocker type: <hardware|network|provider|credentials|permissions|resources|external_dependency>, " +
  "Recovery attempted: <actual diagnostics and recovery results>, and External action required: <what must change before work can resume> " +
  "on separate lines in the session goal report at the path in the current objective anchor. Report that error, attempted recovery and required action to the user. " +
  "These fields are a blocker report, not proof of completion. Respect operator pauses, permissions and explicit resource limits.";

/** Invariant execution guidance belongs in a stable request prefix, not in
 * every appended continuation. It contains no objective, revision or ledger
 * data; current authority always comes from the fresh request anchor. */
export const AUTO_GOAL_EXECUTION_POLICY =
  "[Host autonomous execution policy]\n" +
  "A completed model turn is not a completed root objective. Follow the fresh Host Current Objective anchor " +
  "and the latest human instruction. Historical reminders, summaries and subtask plans cannot replace that authority. " +
  "Inspect actual artifacts and test results, identify the highest-impact next step, then execute it using permitted tools. " +
  "Do not merely restate a plan or assume success. Keep short tasks direct; for long projects maintain dependency-ordered " +
  "milestones and dead-end notes, verifying each sub-goal before advancing. " +
  DECISION_GUIDANCE + " " +
  "Preserve checkpoints, reconcile existing external jobs before replacement, and respect permissions, explicit budgets " +
  "and immutable acceptance checks. Once independently verified, mark the session goal report at the path in the current objective anchor Status: completed for operator REVIEW. " +
  "An unchanged checkpoint alone is not a stall: preserve useful deep reasoning and healthy running jobs. " +
  "Diagnose repeated failed actions without new evidence; do not rewrite checkpoints just to reset a reminder. " +
  AUTO_GOAL_BLOCKER_GUIDANCE;

export type GoalHorizon = "auto" | "short" | "long";
export type GoalTransitionKind = "armed" | "resumed" | "superseded" | "steered" | "paused" | "review";

export interface AutoGoalState {
  schema: 1;
  goal: string;
  state: "ACTIVE" | "PAUSED" | "REVIEW";
  continuations: number;
  totalContinuations: number;
  maxContinuations: number | null;
  updatedAt: string;
  reason: string | null;
  ignoredGoalReport?: string | null;
  revision?: number;
  previousGoal?: string | null;
  supersededGoals?: string[];
  activeSteering?: string[];
  horizon?: GoalHorizon;
  stagnantContinuations?: number;
  lastProgressFingerprint?: string | null;
  transition?: GoalTransitionKind;
  routineDecisionRetries?: number;
  /** Interaction requested by trusted human steering; never an execution grant. */
  userQuestions?: boolean;
  /** Frozen standing-work contract; a completed cycle is not loop completion. */
  loop?: { kind: "continuous" } | { kind: "until"; stopCondition: string };
}

export interface EnableAutoGoalOptions {
  horizon?: GoalHorizon;
  transition?: GoalTransitionKind;
  preserveSteering?: boolean;
  loop?: AutoGoalState["loop"];
}

function location(cwd: string): { dir: string; file: string; goalMd: string; historyFile: string } {
  const base = resolve(cwd, ".future-code");
  const sessionId = getAutoGoalSessionId();
  const dir = sessionId === null ? base : join(base, "goals", sessionId);
  return {
    dir,
    file: join(dir, "goal-autonomy.json"),
    goalMd: join(dir, "goal.md"),
    historyFile: join(dir, "goal-history.jsonl"),
  };
}

export function autoGoalReportPath(cwd = process.cwd()): string {
  return location(cwd).goalMd;
}

function checkDirectory(dir: string, create: boolean): boolean {
  // Inspect each existing ancestor before creating anything. Checking only
  // the leaf would let a symlinked goals/ redirect another session's writes.
  const parent = resolve(dir, "..");
  if (basename(dir) !== ".future-code" && parent !== dir && !checkDirectory(parent, create)) return false;
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

export function normalizeGoalText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function classifyGoalHorizon(goal: string, explicit: GoalHorizon = "auto"): "short" | "long" {
  if (explicit === "short" || explicit === "long") return explicit;
  const text = goal.trim();
  if (
    text.length > 160 ||
    text.includes("\n") ||
    /\b(?:architecture|redesign|refactor\s+all|migration|migrate|framework|pipeline|benchmark|experiment|research|paper|full-stack|end-to-end|e2e|system|platform|suite|comprehensive|long-term|marathon|multi-step|phase|production|overhaul|autonomous|reliability|productivity|robustness)\b/i.test(text) ||
    /(?:架构|重构|迁移|框架|流水线|实验|研究|论文|端到端|系统|平台|全面|长期|多阶段|生产级)/.test(text)
  ) {
    return "long";
  }
  return "short";
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
      (v.ignoredGoalReport != null && (typeof v.ignoredGoalReport !== "string" || !/^[a-f0-9]{64}$/.test(v.ignoredGoalReport))) ||
      (v.reason !== null && typeof v.reason !== "string") ||
      (v.userQuestions !== undefined && typeof v.userQuestions !== "boolean") ||
      (v.loop !== undefined && (!v.loop || typeof v.loop !== "object" ||
        !["continuous", "until"].includes(v.loop.kind) ||
        (v.loop.kind === "until" && (typeof v.loop.stopCondition !== "string" || !v.loop.stopCondition.trim() ||
          Buffer.byteLength(v.loop.stopCondition) > MAX_GOAL_BYTES)))) ||
      (v.revision !== undefined && (!Number.isSafeInteger(v.revision) || v.revision < 1)) ||
      (v.previousGoal != null && (typeof v.previousGoal !== "string" || Buffer.byteLength(v.previousGoal) > MAX_GOAL_BYTES)) ||
      (v.supersededGoals !== undefined && (!Array.isArray(v.supersededGoals) || v.supersededGoals.length > MAX_SUPERSEDED_GOALS ||
        v.supersededGoals.some(item => typeof item !== "string" || !item.trim() || Buffer.byteLength(item) > MAX_GOAL_BYTES))) ||
      (v.activeSteering !== undefined && (!Array.isArray(v.activeSteering) || v.activeSteering.length > MAX_STEERING_NOTES ||
        v.activeSteering.some(item => typeof item !== "string" || !item.trim() || Buffer.byteLength(item) > MAX_GOAL_BYTES))) ||
      (v.horizon !== undefined && !["auto", "short", "long"].includes(v.horizon)) ||
      (v.stagnantContinuations !== undefined && (!Number.isSafeInteger(v.stagnantContinuations) || v.stagnantContinuations < 0)) ||
      (v.lastProgressFingerprint != null && (typeof v.lastProgressFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(v.lastProgressFingerprint))) ||
      (v.transition !== undefined && !["armed", "resumed", "superseded", "steered", "paused", "review"].includes(v.transition)) ||
      (v.routineDecisionRetries !== undefined && (!Number.isSafeInteger(v.routineDecisionRetries) ||
        v.routineDecisionRetries < 0 || v.routineDecisionRetries > MAX_ROUTINE_DECISION_CORRECTIONS)))
    throw new Error("Invalid autonomous-goal state (fail closed)");
  return v;
}

export function readAutoGoal(cwd = process.cwd()): AutoGoalState | null {
  if (isAutoGoalBackgroundTurn()) return null;
  const { dir, file } = location(cwd);
  if (!checkDirectory(dir, false)) return null;
  checkFile(file);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error("Autonomous-goal state too large");
  return validate(JSON.parse(raw));
}

function persist(cwd: string, state: AutoGoalState): AutoGoalState {
  if (isAutoGoalBackgroundTurn()) throw new Error("A scheduled task cannot replace the foreground autonomous goal");
  validate(state);
  const encoded = JSON.stringify(state, null, 2) + "\n";
  if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error("Autonomous-goal state too large; preserve and consolidate constraints before continuing");
  const { dir, file } = location(cwd);
  checkDirectory(dir, true);
  checkFile(file);
  const tmp = join(dir, ".goal-autonomy-" + randomUUID() + ".tmp");
  try {
    writeFileSync(tmp, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return state;
}

function readGoalReport(dir: string): { text: string; fingerprint: string; contentFingerprint: string } | null {
  const path = join(dir, "goal.md");
  if (!existsSync(path)) return null;
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024n * 1024n) return null;
  const text = readFileSync(path, "utf8");
  // Include the write identity so a fresh report, even with identical text,
  // is evaluated again. Resume ignores only the report already acknowledged.
  const fingerprint = createHash("sha256").update(`${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:`).update(text).digest("hex");
  return { text, fingerprint, contentFingerprint: createHash("sha256").update(text).digest("hex") };
}

function extractGoalHeading(reportText: string): string | null {
  const match = /^\s*#\s+([^\r\n]+)/m.exec(reportText);
  const heading = match?.[1]?.trim();
  return heading && Buffer.byteLength(heading) <= MAX_GOAL_BYTES ? heading : null;
}

export interface GoalMilestone {
  done: boolean;
  text: string;
  index: number; // 1-based position in the ledger
}

/**
 * Parses the machine-readable milestone ledger from goal.md.
 * Ledger items are GitHub-style checkboxes optionally wrapped in a
 * "## Milestones" section; items outside any "Status:" line qualify.
 * Each item looks like:
 *   - [ ] Fix notation clash between L (range) and L (lattice)
 *   - [x] Replace separator sentence — evidence: review_update.md §2
 */
export function parseMilestoneLedger(reportText: string): GoalMilestone[] {
  const milestones: GoalMilestone[] = [];
  const seen = new Set<string>();
  const pattern = /^\s*(?:[-*+]|\d+\.)\s+\[( |x|X)\]\s*(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  const prose = executionProse(reportText, true);
  while ((match = pattern.exec(prose)) !== null) {
    const text = match[2]!.trim();
    if (!text || text.length > 512) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    milestones.push({ done: match[1] !== " ", text, index: milestones.length + 1 });
  }
  return milestones;
}

/** Reads and parses the milestone ledger from the session goal report at the path in the current objective anchor. */
export function readMilestoneLedger(cwd = process.cwd()): GoalMilestone[] {
  const state = readAutoGoal(cwd);
  if (!state) return [];
  return milestoneLedgerForGoal(state.goal, cwd);
}

function milestoneLedgerForGoal(goal: string, cwd: string): GoalMilestone[] {
  const { dir } = location(cwd);
  if (!checkDirectory(dir, false)) return [];
  const report = readGoalReport(dir);
  return report && goalMatchesReport(report.text, goal) ? parseMilestoneLedger(report.text) : [];
}

/**
 * Chooses the next actionable milestone: the first unchecked item in ledger
 * order. Ledgers are written dependency-ordered, so the first open item is
 * the frontier.
 */
export function nextOpenMilestone(milestones: GoalMilestone[]): GoalMilestone | null {
  return milestones.find(m => !m.done) ?? null;
}

function goalMatchesReport(reportText: string, goal: string): boolean {
  // A mention in "Supersedes", notes, or a different goal's body is not a
  // binding. Multi-line objectives retain their first line as the H1, with
  // the remaining objective text immediately below it.
  const heading = extractGoalHeading(reportText);
  return heading !== null && normalizeGoalText(heading) === normalizeGoalText(goal.split(/\r?\n/)[0]!) &&
    normalizeGoalText(reportText).includes(normalizeGoalText(goal));
}

function syncGoalMarkdownFile(
  cwd: string,
  goal: string,
  previousGoal: string | null,
  activeSteering: string[] = [],
  forceOverwrite = false,
): void {
  const { dir, goalMd } = location(cwd);
  checkDirectory(dir, true);
  if (existsSync(goalMd)) {
    const stat = lstatSync(goalMd);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe goal report file");
    if (!forceOverwrite) {
      const existing = readFileSync(goalMd, "utf8");
      if (goalMatchesReport(existing, goal)) return;
    }
    // Preserve the old work before repairing/superseding its ledger. An
    // archive is historical evidence, never the active instruction source.
    const report = readGoalReport(dir);
    if (!report) throw new Error("Cannot safely archive mismatched goal report");
    const archive = `goal-report-${randomUUID()}.md`;
    writeFileSync(join(dir, archive), report.text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    appendGoalHistory(cwd, { at: new Date().toISOString(), event: "goal_report_archived", archive });
  } else if (!forceOverwrite) {
    return;
  }
  const lines = [
    `# ${goal}`,
    `Status: in_progress`,
  ];
  if (previousGoal) lines.push(`Supersedes: ${previousGoal}`);
  if (activeSteering.length > 0) {
    lines.push(`Active constraints: ${activeSteering.join(" | ")}`);
  }
  const tmp = join(dir, ".goal-md-" + randomUUID() + ".tmp");
  try {
    writeFileSync(tmp, lines.join("\n") + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(tmp, goalMd);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function appendGoalHistory(cwd: string, entry: Record<string, unknown>): void {
  try {
    const { dir, historyFile } = location(cwd);
    checkDirectory(dir, true);
    if (existsSync(historyFile)) {
      const stat = lstatSync(historyFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) return;
    }
    appendFileSync(historyFile, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    // Non-fatal audit log best effort.
  }
}

export function enableAutoGoal(
  goal: string,
  cwd = process.cwd(),
  maxContinuations: number | null = null,
  options?: EnableAutoGoalOptions,
): AutoGoalState {
  // Check before report creation/archive as well as before the state write.
  if (isAutoGoalBackgroundTurn()) throw new Error("A scheduled task cannot replace the foreground autonomous goal");
  const text = goal.trim();
  if (!text || Buffer.byteLength(text) > MAX_GOAL_BYTES)
    throw new Error("Autonomous goal must be 1-4096 bytes");
  if (maxContinuations !== null && (!Number.isSafeInteger(maxContinuations) || maxContinuations < 1 || maxContinuations > MAX_AUTO_GOAL_CONTINUATIONS))
    throw new Error("Autonomous continuation limit must be 1-100000 (explicit operator budget)");

  let existing: AutoGoalState | null = null;
  try { existing = readAutoGoal(cwd); } catch { existing = null; }
  const { dir } = location(cwd);
  const existingReport = checkDirectory(dir, false) ? readGoalReport(dir) : null;
  const reportHeading = existingReport ? extractGoalHeading(existingReport.text) : null;

  let previousGoal: string | null = existing?.previousGoal ?? null;
  const priorSuperseded = existing?.supersededGoals ?? [];
  let isSuperseding = false;

  if (existing && normalizeGoalText(existing.goal) !== normalizeGoalText(text)) {
    previousGoal = existing.goal;
    isSuperseding = true;
  } else if (!existing && reportHeading && normalizeGoalText(reportHeading) !== normalizeGoalText(text)) {
    previousGoal = reportHeading;
    isSuperseding = true;
  }

  const supersededGoals = [
    ...(previousGoal ? [previousGoal] : []),
    ...priorSuperseded,
  ].filter((item, idx, arr) =>
    normalizeGoalText(item) !== normalizeGoalText(text) &&
    arr.findIndex(other => normalizeGoalText(other) === normalizeGoalText(item)) === idx
  ).slice(0, MAX_SUPERSEDED_GOALS);

  const revision = existing
    ? (existing.revision ?? 1) + (isSuperseding ? 1 : 0)
    : 1;
  const now = new Date().toISOString();

  // Initialize the binding ourselves; the model should spend its first tool
  // call on useful work, not recreating host-known goal/status metadata.
  // Preserve a matching ledger, and archive any mismatched prior report.
  if (!existingReport || !goalMatchesReport(existingReport.text, text)) {
    syncGoalMarkdownFile(cwd, text, previousGoal, options?.preserveSteering ? (existing?.activeSteering ?? []) : [], true);
  }

  const currentReport = checkDirectory(dir, false) ? readGoalReport(dir) : null;
  const transition: GoalTransitionKind = options?.transition ?? (isSuperseding ? "superseded" : "armed");
  const horizon: GoalHorizon = options?.horizon ?? classifyGoalHorizon(text);
  const activeSteering = options?.preserveSteering ? (existing?.activeSteering ?? []) : [];

  const nextState = persist(cwd, {
    schema: 1,
    goal: text,
    state: "ACTIVE",
    continuations: 0,
    totalContinuations: 0,
    maxContinuations,
    updatedAt: now,
    reason: null,
    ...(currentReport ? { ignoredGoalReport: currentReport.fingerprint } : {}),
    revision,
    ...(previousGoal ? { previousGoal } : {}),
    ...(supersededGoals.length > 0 ? { supersededGoals } : {}),
    ...(activeSteering.length > 0 ? { activeSteering } : {}),
    horizon,
    stagnantContinuations: 0,
    lastProgressFingerprint: currentReport?.contentFingerprint ?? null,
    transition,
    ...(options?.loop ? { loop: options.loop } : {}),
  });

  if (isSuperseding) {
    appendGoalHistory(cwd, {
      at: now,
      event: "objective_superseded",
      revision,
      previousGoal,
      goal: text,
      horizon,
    });
  }
  return nextState;
}

export function supersedeAutoGoal(
  newGoal: string,
  cwd = process.cwd(),
  maxContinuations?: number | null,
): AutoGoalState {
  let existing: AutoGoalState | null = null;
  try { existing = readAutoGoal(cwd); } catch { existing = null; }
  const limit = maxContinuations === undefined ? (existing?.maxContinuations ?? null) : maxContinuations;
  return enableAutoGoal(newGoal, cwd, limit, { transition: existing ? "superseded" : "armed" });
}

export function recordGoalSteering(
  steeringNote: string,
  cwd = process.cwd(),
  options: { resumePaused?: boolean; resetContinuationBudget?: boolean; userQuestions?: boolean } = {},
): AutoGoalState | null {
  const note = steeringNote.trim();
  if (!note) return null;
  if (Buffer.byteLength(note) > MAX_GOAL_BYTES) throw new Error("Goal steering exceeds 4096 bytes; split the instruction without discarding constraints");
  const state = readAutoGoal(cwd);
  if (!state) return null;
  const existingNotes = state.activeSteering ?? [];
  const deduped = [
    ...existingNotes.filter(item => normalizeGoalText(item) !== normalizeGoalText(note)),
    note,
  ];
  if (deduped.length > MAX_STEERING_NOTES) throw new Error("Goal steering limit reached; consolidate constraints explicitly instead of discarding earlier instructions");
  const { dir } = location(cwd);
  const preservePause = state.state === "PAUSED" && options.resumePaused === false;
  return persist(cwd, {
    ...state,
    state: preservePause ? "PAUSED" : "ACTIVE",
    continuations: state.state === "PAUSED" && !preservePause && options.resetContinuationBudget !== false ? 0 : state.continuations,
    ignoredGoalReport: state.state === "PAUSED" && !preservePause
      ? (readGoalReport(dir)?.fingerprint ?? null)
      : state.ignoredGoalReport,
    reason: preservePause ? state.reason : null,
    activeSteering: deduped,
    routineDecisionRetries: 0,
    ...(options.userQuestions === undefined ? {} : { userQuestions: options.userQuestions }),
    transition: "steered",
    updatedAt: new Date().toISOString(),
  });
}

export function pauseAutoGoal(cwd = process.cwd(), reason = "Paused by operator"): AutoGoalState | null {
  const state = readAutoGoal(cwd);
  if (!state) return null;
  return persist(cwd, {
    ...state,
    state: "PAUSED",
    reason,
    transition: "paused",
    updatedAt: new Date().toISOString(),
  });
}

export function resumeAutoGoal(cwd = process.cwd()): AutoGoalState | null {
  const state = readAutoGoal(cwd);
  if (!state) return null;
  // Reauthorizing is an explicit user command, never an automatic budget reset.
  return persist(cwd, {
    ...state,
    state: "ACTIVE",
    continuations: 0,
    ignoredGoalReport: readGoalReport(location(cwd).dir)?.fingerprint ?? null,
    reason: null,
    stagnantContinuations: 0,
    routineDecisionRetries: 0,
    transition: "resumed",
    updatedAt: new Date().toISOString(),
  });
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "have",
  "will", "should", "would", "could", "make", "sure", "please", "now", "let",
  "lets", "work", "working", "task", "goal", "objective", "project", "code",
  "future", "future-code", "use", "using", "need", "want", "also", "then",
  "when", "where", "what", "which", "while", "after", "before", "all", "any",
  "some", "more", "other", "both", "each", "only", "just", "very", "much",
]);

function meaningfulTokens(text: string): string[] {
  const latin = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\u4e00-\u9fff]+/g, " ")
    .split(/\s+/)
    .filter(tok => tok.length >= 3 && !STOPWORDS.has(tok));
  const cjk = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return [...new Set([...latin, ...cjk])];
}

export function goalTokenOverlap(goalA: string, goalB: string): number {
  const tokensA = meaningfulTokens(goalA);
  const tokensB = meaningfulTokens(goalB);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setB = new Set(tokensB);
  let shared = 0;
  for (const tok of tokensA) {
    if (setB.has(tok)) shared++;
  }
  return shared / Math.min(tokensA.length, tokensB.length);
}

function actionDirectiveText(input: string): string {
  return input.trim().replace(/^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:help\s+me\s+)?|i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to\s+)/i, "");
}

const ACTION_DIRECTIVE = /^(?:(?:please|now|next|first)\s+)?(?:fix|implement|build|create|refactor|develop|design|optimize|migrate|add|remove|replace|rewrite|update|upgrade|integrate|resolve|repair|patch|write|complete|finish|deliver|ship|support|architect|overhaul|redesign|automate|improve|enhance|verify|debug|construct|configure|deploy|change|push|commit|sync|synchronize|pull|rebuild|merge|run|execute|continue|maintain|review|inspect|check|test|evaluate|benchmark|train|research|investigate|analyze|perform)\b/i;

function isReadOnlyQuestionOrChat(input: string): boolean {
  const text = input.trim();
  if (!text) return true;
  if (/^(?:hi|hello|hey|thanks|thank you|ok|okay|yes|no|yep|nope|cool|great|good|nice|got it|understood|你好|谢谢|好的|收到|明白)[.!。！?？]*$/i.test(text)) {
    return true;
  }
  // "Could you fix ...?" is a request to act. Its punctuation must not
  // leave a stale objective authoritative while the model handles the fix.
  if (ACTION_DIRECTIVE.test(actionDirectiveText(text))) return false;
  // Questions or pure explanation/inspection requests must not overwrite an objective or auto-arm
  if (/^(?:explain|what\b|why\b|how\b|where\b|when\b|who\b|which\b|can you explain|could you explain|tell me\b|describe\b|show me\b|list\b|status\b|is there\b|are there\b|do we\b|does\b|did\b|为什么|怎么|如何|什么是|解释一下|告诉我|查看|列出)/i.test(text)) {
    return true;
  }
  if ((text.endsWith("?") || text.endsWith("？")) && !extractExplicitNewObjective(text)) {
    return true;
  }
  return false;
}

export function extractExplicitNewObjective(input: string): string | null {
  const text = input.trim();
  if (!text || text.startsWith("/")) return null;
  const patterns: RegExp[] = [
    /^(?:(?:my|the|our)\s+)?(?:new\s+)?(?:objective|goal|mission|target|task)\s*(?:is|now\s+is|:|-|->)\s*(.+)$/is,
    /^(?:please\s+)?(?:switch|change|update|set|replace|shift|pivot)\s+(?:the\s+|our\s+|my\s+)?(?:current\s+)?(?:objective|goal|task|focus|direction)\s+(?:to|with|into|:)\s*(.+)$/is,
    /^(?:instead\s+of\s+[^,.\n]+[,:]?\s*|forget\s+(?:that|the\s+(?:previous|old|prior|earlier)\s+(?:goal|objective|task))[,.;:]?\s*|(?:stop|drop|abandon)\s+(?:working\s+on\s+)?(?:that|the\s+(?:previous|old|prior)\s+(?:goal|objective|task))\s+(?:and\s+)?)(.+)$/is,
    /^(?:now\s+)?(?:let'?s|we\s+need\s+to|i\s+want\s+you\s+to|i\s+need\s+you\s+to)\s+(?:switch\s+to|pivot\s+to|work\s+on\s+a\s+new\s+(?:objective|goal|task)\s*[:,-]?\s*)(.+)$/is,
    /^(?:(?:我的|当前|新的|新)\s*(?:目标|任务|方向)\s*(?:是|为|改为|换成|更新为|：|:)\s*)(.+)$/is,
    /^(?:(?:请)?(?:把|将)?(?:当前|之前的|旧的)?(?:目标|任务|方向)\s*(?:改为|换成|切换为|更新为|设为)\s*[:：]?\s*)(.+)$/is,
    /^(?:不要做[^，,。.\n]+[，,。.\s]*|放弃(?:之前的|旧的)(?:目标|任务)[，,。.\s]*)(?:现在|请|改为|换成)?\s*(.+)$/is,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const candidate = match?.[1]?.trim();
    if (candidate && candidate.length >= 3 && Buffer.byteLength(candidate) <= MAX_GOAL_BYTES) {
      return candidate;
    }
  }
  return null;
}

function isRefinementDirective(input: string): boolean {
  const text = input.trim();
  return /^(?:also\b|and\s+also\b|make\s+sure\b|please\s+also\b|don'?t\b|do\s+not\b|without\b|remember\s+to\b|keep\s+in\s+mind\b|in\s+addition\b|for\s+this\s+(?:goal|task|objective)\b|use\s+\S+\s+instead\b|另外|同时|还要|确保|注意|顺便|不要|不能)/i.test(text);
}

function explicitQuestionPreference(input: string): boolean | null {
  const text = actionDirectiveText(input);
  if (/^(?:please\s+)?(?:do not|don't|never|stop|avoid)\s+(?:ask|asking|interrupt|interrupting)\b/i.test(text) ||
    /^(?:please\s+)?(?:work|continue|proceed|execute)\s+(?:fully\s+)?autonomously\b/i.test(text) ||
    /^(?:请)?(?:不要问我|别问我|自主执行|自主工作)/.test(text)) return false;
  if (/^(?:please\s+)?(?:(?:ask|consult)\s+me\b|check\s+with\s+me\b|let\s+me\s+(?:choose|decide)\b)/i.test(text) ||
    /^(?:请)?(?:先问我|让我选择|让我决定|向我确认)/.test(text)) return true;
  return null;
}

function isActionableObjectiveDirective(input: string): boolean {
  const text = input.trim();
  if (!text || text.startsWith("/") || Buffer.byteLength(text) > MAX_GOAL_BYTES) return false;
  if (isReadOnlyQuestionOrChat(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  const hasCjk = /[\u4e00-\u9fff]{4,}/.test(text);
  // Clear short imperatives such as "Run tests" are still work requests.
  const action = actionDirectiveText(text);
  if (ACTION_DIRECTIVE.test(action) && action.replace(ACTION_DIRECTIVE, "").trim().length > 1) return true;
  if (words.length < 3 && !hasCjk) return false;
  if (text.length < 12 && !hasCjk) return false;
  return ACTION_DIRECTIVE.test(actionDirectiveText(text)) ||
    /\b(?:and\s+send\s+a\s+pr|until\s+all\s+tests\s+pass|and\s+run\s+(?:the\s+)?tests|fix\s+it|change\s+the\s+code)\b/i.test(text) ||
    /^(?:请|现在|接下来)?\s*(?:修复|实现|构建|创建|重构|开发|设计|优化|迁移|添加|删除|替换|重写|更新|升级|集成|解决|修补|编写|完成|交付|支持|改进|增强|调试|部署|修改|运行|执行|提交|推送|同步|拉取|重建|继续|维护|检查|测试|评估|训练|研究)/.test(text);
}

/**
 * Reconciles human main-thread input with the durable autonomous goal:
 * 1. Explicit resume instructions ("continue", "resume", "keep going", "go on", "继续", "继续工作")
 *    re-arm a PAUSED goal with its existing budget and lifetime counter.
 * 2. Explicit pause instructions ("pause", "pause goal", "stop goal", "暂停") pause an ACTIVE goal.
 * 3. Explicit replacements supersede the root goal. Other follow-ups steer the
 *    unfinished root goal; vocabulary overlap cannot decide root authority.
 *    Actionable requests automatically arm a goal when none is unfinished.
 * Child/SDK/background messages cannot reset a budget or change root authority.
 */
export function resumeAutoGoalFromInput(
  input: string,
  options: { mainThread: boolean; cwd?: string; autoArm?: boolean; loopMode?: "builtin" | "bundled" },
): AutoGoalState | null {
  if (!options.mainThread) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const cwd = options.cwd ?? process.cwd();
  const loopCommand = /^\/loop(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (loopCommand && options.loopMode) {
    const parsed = parseLoopTask(loopCommand[1] ?? "");
    if (!parsed) return null;
    // This is an explicit human command, not expanded skill/cron text. Keep
    // every requested constraint, including stop/cadence and follow-on work.
    const goalText = "/loop " + parsed.goalText;
    const current = readAutoGoal(cwd);
    if (current && normalizeGoalText(current.goal) === normalizeGoalText(goalText)) {
      // Repeating an active command is not a fresh resource budget. An
      // explicit paused-loop restart resumes its work with accounting intact.
      if (current.state === "ACTIVE") return current;
      return recordGoalSteering(trimmed, cwd, { resetContinuationBudget: false });
    }
    return enableAutoGoal(goalText, cwd, current?.maxContinuations ?? null, {
      transition: current ? "superseded" : "armed",
      ...(options.loopMode === "builtin" ? { loop: parsed.stopCondition
        ? { kind: "until", stopCondition: parsed.stopCondition }
        : { kind: "continuous" } } : {}),
    });
  }
  // Other commands own their own semantics. A plugin named /loop is not the
  // built-in loop contract and cannot inherit authority by its name alone.
  if (trimmed.startsWith("/")) return null;

  // 1. Whole human resume instruction
  if (/^(?:continue|resume|keep going|go on|go(?: for both)?|do both|proceed|继续|继续工作|继续执行|两个都做)[.!。！]?$/i.test(trimmed)) {
    let current: AutoGoalState | null = null;
    try { current = readAutoGoal(cwd); } catch { return null; }
    if (current?.state !== "PAUSED") return null;
    return resumeAutoGoal(cwd);
  }

  // 2. Whole human pause instruction
  if (/^(?:pause|pause goal|stop goal|stop autonomous work|暂停|暂停目标|停止自动工作)[.!。！]?$/i.test(trimmed)) {
    try {
      if (readAutoGoal(cwd)?.state === "ACTIVE") {
        pauseAutoGoal(cwd, "Paused by operator instruction");
      }
    } catch { /* ignore corrupt state on pause */ }
    return null;
  }

  let current: AutoGoalState | null = null;
  try { current = readAutoGoal(cwd); } catch { return null; }
  const userQuestions = explicitQuestionPreference(trimmed);
  if (current && current.state !== "REVIEW" && userQuestions !== null) {
    return recordGoalSteering(trimmed, cwd, {
      resumePaused: false, resetContinuationBudget: false, userQuestions,
    });
  }
  // 3. Read-only questions/explanations never overwrite or re-arm an objective.
  if (isReadOnlyQuestionOrChat(trimmed)) return null;

  // 4. Explicit new objective / pivot statement ("New objective: ...", "Instead of X, do Y", etc.)
  const explicitNew = extractExplicitNewObjective(trimmed);
  if (explicitNew) {
    return enableAutoGoal(explicitNew, cwd, current?.maxContinuations ?? null, {
      transition: current ? "superseded" : "armed",
    });
  }

  // 5. Mid-flight steering/refinement on an active or paused objective
  if (current && current.state !== "REVIEW" && isRefinementDirective(trimmed)) {
    return recordGoalSteering(trimmed, cwd, { resumePaused: false, resetContinuationBudget: false });
  }

  // 6. Actionable engineering/research directive
  if (isActionableObjectiveDirective(trimmed)) {
    if (current) {
      // A necessary subtask can share no words with the larger objective.
      // Preserve that objective until the human explicitly replaces it.
      if (current.state !== "REVIEW") {
        return recordGoalSteering(trimmed, cwd, { resetContinuationBudget: false });
      }
      return enableAutoGoal(trimmed, cwd, current.maxContinuations, {
        transition: "superseded",
      });
    }
    const autoArmAllowed = options.autoArm ?? (process.env.FUTURE_CODE_AUTO_OBJECTIVE !== "0");
    if (autoArmAllowed) {
      return enableAutoGoal(trimmed, cwd, null, { transition: "armed" });
    }
  }

  // Trusted corrections/context need not start with a verb we predicted.
  // Retain them across compaction without turning them into a new root goal.
  if (current && current.state !== "REVIEW") return recordGoalSteering(trimmed, cwd, {
    // Supplied prerequisite evidence can resume a genuine external blocker,
    // but an observation cannot cancel an operator pause or replenish a limit.
    resumePaused: current.reason?.startsWith("External blocker (") ?? false,
    resetContinuationBudget: false,
  });

  return null;
}

function isSelfRecoverableBlocker(
  blocker: string,
  kind: string,
  recovery: string,
  action: string,
): boolean {
  const combinedFailure = blocker + " " + action;
  // A routine question never grants a genuinely missing or denied capability.
  // Native access controls remain authoritative even if the report says "go".
  if (/\b(?:denied|forbidden|HTTP\s*(?:401|403)|not\s+(?:authorized|permitted|granted)|ungranted|revoked|expired)\b/i.test(combinedFailure) ||
      (/\b(?:force[- ]?push|production\s+(?:deploy|release|publish)|purchase|spend)\b/i.test(combinedFailure) &&
        /\b(?:approval|authorize|authorization|permission)\b/i.test(combinedFailure))) return false;
  if (isRoutineDecisionHandoff(action)) return true;
  // Asking the human to type "continue" or "resume" is never a valid external blocker
  if (/\b(?:say|type|reply|run|enter|tell\s+me\s+to)\s+['"`]?(?:continue|resume|keep\s+going|go\s+on)\b/i.test(action)) {
    return true;
  }
  // If the recovery attempted is trivial placeholder text
  if (/^(?:none|n\/a|nothing|not\s+attempted|no\s+recovery)$/i.test(recovery.trim())) {
    return true;
  }
  // If the required action is purely local code/test/build/refactor work and lacks genuine external dependency indicators
  const combined = `${blocker} ${action}`;
  const isPureCodeWork = /\b(?:fix|resolve|repair|debug|update|edit|refactor|implement|write|rerun|re-run|compile|recompile)\b[^.\r\n]{0,80}\b(?:code|bug|test|tests|build|compile|compilation|type|types|lint|syntax|import|implementation|error|file|files|suite)\b/i.test(action);
  const hasExternalIndicator = /\b(?:hardware|device|power|gpu|fpga|board|cable|network|internet|dns|vpn|firewall|proxy|provider|api\s*key|token|credential|credentials|oauth|login|secret|password|permission|permissions|sudo|root|chmod|quota|billing|disk\s+full|out\s+of\s+memory|oom|offline|unreachable|unavailable|expired|revoked|external|human\s+approval|manual\s+approval)\b/i.test(combined);
  if (isPureCodeWork && !hasExternalIndicator && kind !== "hardware") {
    return true;
  }
  return false;
}

function goalFileOutcome(
  dir: string,
  state: AutoGoalState,
  cwd: string,
): { state: "REVIEW" | "PAUSED"; reason: string } | { recovery: string; routineHandoff?: boolean } | null {
  const report = readGoalReport(dir);
  if (!report) return null;
  const { text } = report;
  const controlText = executionProse(text, true);
  // Also repair entirely unrelated objectives, not just previously known ones.
  // A mention of the active goal in the body cannot authorize a stale H1.
  if (!goalMatchesReport(text, state.goal)) {
    syncGoalMarkdownFile(cwd, state.goal, state.previousGoal ?? null, state.activeSteering ?? [], true);
    return {
      recovery:
        `OBJECTIVE DRIFT DETECTED: the session goal report at the path in the current objective anchor did not belong to the active objective. ` +
        `Its previous contents were archived and the active ledger restored for "${state.goal}". ` +
        `Align the next action to this objective and continue all work that remains possible.`,
    };
  }
  if (report.fingerprint === state.ignoredGoalReport) return null;

  const status = /^\s*(?:[-*]\s*)?(?:\*\*)?status(?:\*\*)?\s*:\s*(?:\*\*)?(completed|blocked)(?:\*\*)?\s*$/im.exec(controlText)?.[1]?.toLowerCase();
  if (status === "completed") {
    if (state.loop?.kind === "continuous") return {
      recovery: "This is a standing loop. A completed cycle cannot retire it. Reconcile the previous cycle's effects, " +
        "inspect current evidence, and continue the next useful cycle without requesting another go. " +
        "Respect operator stops, actual external failures, resource limits, and healthy running jobs.",
    };
    const open = nextOpenMilestone(parseMilestoneLedger(text));
    if (open) return {
      recovery: "The completion report still has an unfinished milestone (#" + open.index + "): " +
        open.text + ". Continue this requested work in dependency order; a completed subtask cannot retire the standing objective.",
    };
    return {
      state: "REVIEW",
      reason: "Goal file declares completion; independent acceptance is still required. Review the verified artifacts.",
    };
  }
  if (status !== "blocked") return null;

  const field = (name: string) =>
    new RegExp("^[ \\t]*(?:[-*][ \\t]*)?(?:\\*\\*)?" + name + "(?:\\*\\*)?[ \\t]*:[ \\t]*(\\S[^\\r\\n]*)", "im")
      .exec(controlText)?.[1]?.trim();
  const blocker = field("blocker");
  const kind = field("blocker type")?.toLowerCase();
  const recovery = field("recovery attempted");
  const action = field("external action required");

  if (blocker && kind && EXTERNAL_BLOCKER_TYPES.has(kind) && recovery && action) {
    if (isSelfRecoverableBlocker(blocker, kind, recovery, action)) {
      return {
        routineHandoff: isRoutineDecisionHandoff(action),
        recovery:
          "The goal file reports a blocker that is recoverable within your own tools and authority without human help. " +
          "Diagnose it, switch implementation strategy, and continue all work that remains possible.",
      };
    }
    return {
      state: "PAUSED",
      reason:
        `External blocker (${kind}): ${blocker.slice(0, 320)}. ` +
        `Recovery attempted: ${recovery.slice(0, 256)}. External action required: ${action.slice(0, 256)}`,
    };
  }
  return {
    recovery:
      "The goal file reports a blocker without a complete external-dependency report. " +
      "Diagnose it and continue all work that remains possible.",
  };
}

/**
 * Formats an authoritative post-compaction anchor for the current active goal
 * so context compaction never causes the agent to drift back to earlier tasks.
 */
export function formatActiveGoalCompactionAnchor(state: AutoGoalState | null, cwd = process.cwd()): string | null {
  if (!state || state.state !== "ACTIVE") return null;
  const superseded = [
    ...(state.previousGoal ? [state.previousGoal] : []),
    ...(state.supersededGoals ?? []),
  ].filter((item, idx, arr) => arr.indexOf(item) === idx);
  const horizon = classifyGoalHorizon(state.goal, state.horizon);
  const lines = [
    `[Host Active Objective Anchor — Revision ${state.revision ?? 1} (${horizon}-horizon project)]`,
    `ACTIVE OBJECTIVE: ${state.goal}`,
    `Goal report for this session: ${JSON.stringify(autoGoalReportPath(cwd))}`,
  ];
  if (superseded.length > 0) {
    lines.push(
      `SUPERSEDED HISTORICAL OBJECTIVES (DO NOT DRIFT BACK TO THESE): ${superseded.join(" | ")}`,
    );
  }
  if (state.activeSteering && state.activeSteering.length > 0) {
    lines.push(`ACTIVE USER CONSTRAINTS / STEERING: ${state.activeSteering.join(" | ")}`);
  }
  const ledger = milestoneLedgerForGoal(state.goal, cwd);
  if (ledger.length > 0) {
    const open = ledger.filter(m => !m.done);
    const next = nextOpenMilestone(ledger);
    lines.push(
      `MILESTONE LEDGER: ${ledger.length - open.length}/${ledger.length} complete. ` +
      (next ? `NEXT MILESTONE (#${next.index}): ${next.text}` : "All milestones checked; verify completion evidence."),
    );
  }
  lines.push(
    `Continue executing ONLY the ACTIVE OBJECTIVE above automatically until independently verified completion or an unrecoverable external blocker requiring human intervention.`,
  );
  return lines.join("\n");
}

/** Fresh request projection, including pause/review state. Never stored as a
 * growing transcript or injected into child/SDK/background task authority. */
export function formatGoalRequestAnchor(state: AutoGoalState, cwd = process.cwd()): string {
  const lines = [
    `[Host Current Objective — Revision ${state.revision ?? 1}; ${state.state}; horizon: ${classifyGoalHorizon(state.goal, state.horizon)}]`,
    `Root objective (user instruction): ${JSON.stringify(state.goal)}`,
    `User steering (apply with the root objective): ${JSON.stringify(state.activeSteering ?? [])}`,
    `Goal report for this session: ${JSON.stringify(autoGoalReportPath(cwd))}. Use this path, not a different session's report.`,
    "This current host state supersedes historical goal reminders, summaries, memories and plans. " +
    "Follow the latest user message while preserving the root objective unless the user explicitly replaces it. " +
    "Treat subtask completion as progress, not completion of the root objective.",
  ];
  if (state.loop) lines.push(state.loop.kind === "continuous"
    ? "Standing loop: continue across successful cycles until an operator stop, an actual external blocker, or an explicit resource boundary. A cycle completing is not the objective completing."
    : `Loop stop condition (user instruction): ${JSON.stringify(state.loop.stopCondition)}. Verify it before reporting final completion.`);
  if (state.userQuestions === true) {
    lines.push("The user explicitly requested decision interaction in the active steering. Honor that requested interaction; it grants no new execution permission.");
  }
  if (state.state !== "ACTIVE") {
    lines.push(`Automatic work is ${state.state === "PAUSED" ? "paused" : "awaiting review"}. Answer the latest user message; do not resume this objective without user authorization.`);
  } else {
    const ledger = milestoneLedgerForGoal(state.goal, cwd);
    const next = nextOpenMilestone(ledger);
    if (next) lines.push(`Unverified milestone frontier (#${next.index}): ${JSON.stringify(next.text)}`);
    lines.push("Choose an action that advances a requested outcome, resolves a relevant uncertainty, or verifies that outcome. " +
      "Keep goal.md's host-created objective heading when updating notes or milestones. " +
      "Keep necessary deep reasoning and independent acceptance checks. Batch independent reads/checks only when safe; " +
      "repeat verification when inputs change, a failure needs diagnosis, or final acceptance requires fresh evidence. " +
      "A read, plan, checkpoint edit or model claim alone is not verified progress.");
  }
  return lines.join("\n");
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
    persist(cwd, {
      ...state,
      state: "PAUSED",
      reason: why,
      transition: "paused",
      updatedAt: new Date().toISOString(),
    });
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
  /** delta is valid only when AUTO_GOAL_EXECUTION_POLICY and a fresh current
   * anchor are installed by the caller. Other callers retain full guidance. */
  promptFormat?: "full" | "delta";
  /** Current assistant prose only, never human text or tool-result contents. */
  assistantText?: string;
  /** Host-observed completed tool execution since the previous goal decision. */
  toolActivity?: boolean;
  /** Set only from a matched host-generated rejected question receipt. */
  routineQuestionRejected?: boolean;
}): AutoGoalDecision {
  if (!options.mainThread) return { kind: "SKIP" };
  const cwd = options.cwd ?? process.cwd();
  try {
    const state = readAutoGoal(cwd);
    if (!state || state.state !== "ACTIVE") return { kind: "SKIP" };
    const blocked = (nextState: "PAUSED" | "REVIEW", reason: string): AutoGoalDecision => {
      persist(cwd, {
        ...state,
        state: nextState,
        reason,
        transition: nextState === "REVIEW" ? "review" : "paused",
        updatedAt: new Date().toISOString(),
      });
      return { kind: "BLOCKED", reason };
    };
    const { dir } = location(cwd);
    let outcome = goalFileOutcome(dir, state, cwd);
    // A complete external failure report outranks a prose classifier. No
    // generated instruction or answer can overrule a real denied capability.
    if (outcome && "state" in outcome && outcome.state === "PAUSED") return blocked(outcome.state, outcome.reason);
    const handoff = options.routineQuestionRejected === true || isRoutineDecisionHandoff(options.assistantText ?? "") ||
      !!(outcome && "routineHandoff" in outcome && outcome.routineHandoff);
    if (outcome && "state" in outcome) {
      if (!handoff) return blocked(outcome.state, outcome.reason);
      outcome = { recovery: "A reply that hands requested next steps back to the user is not objective completion." };
    }
    if (!options.withinTurnBudget)
      return blocked("PAUSED", "Caller max-turns boundary reached before objective acceptance. Increase the caller limit explicitly, then /goal --resume.");
    if (state.maxContinuations !== null && state.continuations >= state.maxContinuations)
      return blocked("PAUSED", "Authorized autonomous continuation budget exhausted (" +
        state.maxContinuations + " turns). Use /goal --resume or re-arm with /goal --auto --limit N <goal>.");

    if (state.userQuestions === true && options.routineQuestionRejected !== true &&
      isRoutineDecisionHandoff(options.assistantText ?? "")) return { kind: "SKIP" };

    const previousCorrections = options.toolActivity ? 0 : (state.routineDecisionRetries ?? 0);
    if (handoff && previousCorrections >= MAX_ROUTINE_DECISION_CORRECTIONS) {
      return blocked("PAUSED", "Model execution contract failure: the model repeatedly returned routine decision requests " +
        "without a tool action after two automatic corrections. No user decision or 'go' is required. " +
        "The unfinished objective and evidence are preserved; diagnose or replace the noncompliant model configuration.");
    }
    const recoveryGuidance = [
      outcome && "recovery" in outcome ? outcome.recovery : "",
      handoff ? AUTONOMOUS_QUESTION_REDIRECT : "",
    ].filter(Boolean).join("\n");
    const currentReport = readGoalReport(dir);
    const currentFingerprint = currentReport?.contentFingerprint ?? null;
    const progressed = currentFingerprint !== null && currentFingerprint !== state.lastProgressFingerprint;
    const stagnantContinuations = progressed ? 0 : (state.stagnantContinuations ?? 0) + 1;
    const next = state.continuations + 1;
    persist(cwd, {
      ...state,
      continuations: next,
      totalContinuations: state.totalContinuations + 1,
      stagnantContinuations,
      lastProgressFingerprint: currentFingerprint,
      routineDecisionRetries: handoff ? previousCorrections + 1 : 0,
      updatedAt: new Date().toISOString(),
    });

    const header = "[Host-driven autonomous goal continuation " + next +
      (state.maxContinuations === null ? "" : "/" + state.maxContinuations) + "]\n";
    if (options.promptFormat === "delta") return {
      kind: "CONTINUE",
      prompt: header + "Execute the next useful step for the current host objective. End-turn is not completion." +
        (recoveryGuidance ? "\n" + recoveryGuidance : ""),
    };

    const superseded = [
      ...(state.previousGoal ? [state.previousGoal] : []),
      ...(state.supersededGoals ?? []),
    ].filter((item, idx, arr) => arr.indexOf(item) === idx);

    const antiDriftLine = superseded.length > 0
      ? `Anti-drift lock (Revision ${state.revision ?? 1}): Current objective supersedes [${superseded.join("; ")}]. Do NOT revert or drift back to any superseded objective.\n`
      : "";
    const steeringLine = state.activeSteering && state.activeSteering.length > 0
      ? `Active user constraints: ${state.activeSteering.join(" | ")}\n`
      : "";
    const horizon = classifyGoalHorizon(state.goal, state.horizon);
    const horizonGuidance = horizon === "long"
      ? "Long-horizon project mode: maintain structured milestones and dead-end notes in the session goal report at the path in the current objective anchor, verify each sub-goal with concrete checks before advancing, and preserve clean working state across compactions. "
      : "Short-horizon sprint mode: execute the most direct implementation and verification path with minimal overhead. ";
    const stagnationLine = stagnantContinuations >= 2
      ? `\nCheckpoint unchanged for ${stagnantContinuations} continuations. This alone does not prove a stall: preserve useful deep reasoning and healthy running jobs. If the same failed action is repeating without new evidence, diagnose it and change approach. Record substantive findings when available; do not rewrite the checkpoint just to reset this reminder.`
      : "";

    return {
      kind: "CONTINUE",
      prompt:
        header +
        "Goal: " + state.goal + "\nGoal report: " + JSON.stringify(autoGoalReportPath(cwd)) + "\n" +
        antiDriftLine +
        steeringLine +
        "The previous assistant turn ended but the durable goal is not yet complete. " +
        "Inspect actual artifacts and test results, identify the highest-impact next step, " +
        "then execute it using permitted tools. Do not merely restate the plan or assume success. " +
        horizonGuidance +
        DECISION_GUIDANCE + " " +
        "Preserve checkpoints and avoid duplicate external jobs. Respect all permission prompts, " +
        "cost limits, and immutable acceptance checks. Once independently verified, mark " +
        "the session goal report at the path in the current objective anchor with Status: completed for operator REVIEW. " +
        AUTO_GOAL_BLOCKER_GUIDANCE +
        stagnationLine +
        (recoveryGuidance ? "\n" + recoveryGuidance : ""),
    };
  } catch (error) {
    // Fail closed, but NEVER silently treat a corrupt or unwritable state as
    // a completed goal; the parent query must display this diagnostic.
    return {
      kind: "BLOCKED",
      reason: "Autonomous-goal state unavailable: " +
        errorDetail(error) + ". Repair state or permissions before resuming.",
    };
  }
}

/** Preserve the host's actual terminal category and an actionable repair path.
 * Recoverable context errors are repaired in the query loop before this
 * parking boundary. Never reinterpret a hook, cancellation or budget as EOF. */
export function autoGoalTerminalDiagnostic(reason: string, error?: unknown): string {
  const guidance: Record<string, string> = {
    prompt_too_long: "Provider context limit rejected the request. Automatic context repair could not complete within the current policy; inspect the compaction diagnostic and oversized instructions or tool schemas.",
    blocking_limit: "The working context reached its blocking limit. Check automatic compaction settings and the summary failure diagnostic before resuming.",
    image_error: "Media input failed validation or exceeded the provider limit. Inspect the original media diagnostic and repair the affected input.",
    model_error: "Model/runtime failure remained after automatic recovery. Inspect the original error and restore the unavailable dependency.",
    hook_stopped: "A tool hook stopped execution. Inspect its output and resolve the stated condition; the hook decision remains in force.",
    stop_hook_prevented: "A stop hook prevented continuation. Inspect its output and resolve the stated condition before resuming.",
    max_turns: "The explicit caller turn limit was reached. Increase that limit explicitly before resuming the saved objective.",
    aborted_streaming: "Model execution was interrupted by the user or caller. The saved objective remains paused until it is resumed.",
    aborted_tools: "Tool execution was interrupted by the user or caller. Reconcile any admitted side effects before resuming the saved objective.",
  };
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (guidance[reason] ?? `Execution stopped with runtime reason "${reason}". Diagnose that condition before resuming the saved objective.`) +
    (detail.trim() ? " Original error: " + detail.trim().slice(0, 640) : "");
}

/** Output styles change presentation, never the main thread's goal contract. */
export function isAutoGoalMainThread(querySource: string, agentId?: string, nonInteractive = false): boolean {
  return !agentId && !nonInteractive && !isAutoGoalBackgroundTurn() &&
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
