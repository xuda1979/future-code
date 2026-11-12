/**
 * Cross-project session health scanning for the /sessions command.
 *
 * Pure data-collection functions — no bootstrap/state dependencies, no
 * analytics, no module-scope mutable state — so this module is safe to
 * import from tests and the SDK without triggering CLI initialization.
 *
 * Motivation (2026-11-06 RSI loop): monitoring every future-code session
 * on a machine required assembling per-project JSONL stats, goal-state
 * files, and activity ages by hand. This module turns that into one scan:
 * per-project session counts, latest activity, total size, active goal
 * and state, plus stuck-session detection (no transcript growth while a
 * session claims to be active).
 *
 * Path handling: the session store encodes project paths lossily
 * (every non-alphanumeric character becomes '-'), so `/a/b-1` and
 * `/a/b/1` share one directory name. The authoritative project path is
 * recovered from each transcript's recorded `cwd` field; the lossy
 * decode is only a display fallback.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SessionFileInfo {
  sessionId: string
  /** Bytes of the transcript JSONL. */
  bytes: number
  /** Transcript last-modified epoch ms. */
  modifiedMs: number
}

export interface ProjectHealth {
  /** Raw directory name in the session store, e.g. `-Users-daxu-software-quantum-gpt`. */
  dirName: string
  /** Authoritative project path from the transcript's recorded cwd, or the lossy decode. */
  projectPath: string
  /** True when projectPath came from a transcript cwd rather than lossy decoding. */
  projectPathExact: boolean
  sessions: SessionFileInfo[]
  /** Most recently modified transcript, or null when the project has none. */
  latestSession: SessionFileInfo | null
  totalBytes: number
  /** Latest session's goal; cwd-global legacy fallback for older-only stores. */
  activeGoal: string | null
  /** Goal state (ACTIVE/REVIEW/…) from the same file, if present. */
  goalState: string | null
  /** Legacy data is unowned; it is diagnostic context, not session authority. */
  goalScope: 'session' | 'legacy-unowned' | null
  /** Goal continuation counters, when the state file provides them. */
  goalContinuations: { continuations: number; totalContinuations: number } | null
  /** goal-autonomy.json revision, when present. */
  goalRevision: number | null
}

export interface ProjectHealthFlag {
  kind: 'stale' | 'stuck-active-goal' | 'large-project'
  detail: string
}

export interface ProjectHealthReport {
  project: ProjectHealth
  flags: ProjectHealthFlag[]
}

/** Sessions with no transcript modification for this long are "stale" (ms). */
export const STALE_SESSION_MS = 24 * 60 * 60 * 1000
/** Default per-project size above which a "large-project" flag is raised (bytes). */
export const LARGE_PROJECT_BYTES = 512 * 1024 * 1024
/** Goal is "stuck" when ACTIVE but the project's latest session is older than this (ms). */
export const STUCK_GOAL_STALE_MS = 6 * 60 * 60 * 1000

/** Bytes read when sampling a transcript head for its cwd record. */
const TRANSCRIPT_HEAD_BYTES = 16 * 1024
/** Goal-state JSONL files are never legitimately larger than this. */
const MAX_GOAL_STATE_BYTES = 256 * 1024

/**
 * Decode a session-store directory name back into an approximate path.
 * LOSSY: `sanitizePath` maps every non-alphanumeric character to '-', so
 * `quantum-gpt` and `quantum/gpt` are indistinguishable. Use only when no
 * transcript cwd is available.
 */
export function decodeProjectDirName(dirName: string): string {
  if (!dirName.startsWith('-')) return dirName
  return '/' + dirName.slice(1).replaceAll('-', '/')
}

function listSessionFiles(projectDir: string): SessionFileInfo[] {
  let entries: string[]
  try {
    entries = readdirSync(projectDir)
  } catch {
    return []
  }
  const sessions: SessionFileInfo[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue
    const file = join(projectDir, entry)
    try {
      const st = statSync(file)
      if (!st.isFile()) continue
      sessions.push({
        sessionId: entry.slice(0, -'.jsonl'.length),
        bytes: st.size,
        modifiedMs: st.mtimeMs,
      })
    } catch {
      // raced away — skip
    }
  }
  sessions.sort((a, b) => b.modifiedMs - a.modifiedMs)
  return sessions
}

/**
 * Sample the head of a transcript for its recorded `cwd`. The first line of
 * every session JSONL is a record carrying the working directory; that is
 * the authoritative reverse mapping from store dir name to project path.
 */
function readTranscriptCwd(file: string): string | null {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  let head: string
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES)
    const read = readSync(fd, buffer, 0, TRANSCRIPT_HEAD_BYTES, 0)
    head = buffer.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
  // Walk only complete lines; the cwd can be on any of the first few
  // records (queue-operation records precede the first message sometimes).
  for (const line of head.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const record = JSON.parse(line) as { cwd?: unknown }
      if (typeof record.cwd === 'string' && record.cwd.length > 0 && record.cwd.length <= 4096) {
        return record.cwd
      }
    } catch {
      // partial or non-JSON line — keep walking
    }
  }
  return null
}

interface GoalAutonomyLite {
  goal?: unknown
  state?: unknown
  revision?: unknown
  continuations?: unknown
  totalContinuations?: unknown
}

function readGoalState(projectPath: string, sessionId?: string): {
  activeGoal: string | null
  goalState: string | null
  goalScope: ProjectHealth['goalScope']
  goalContinuations: ProjectHealth['goalContinuations']
  goalRevision: number | null
} {
  const result = {
    activeGoal: null as string | null,
    goalState: null as string | null,
    goalScope: null as ProjectHealth['goalScope'],
    goalContinuations: null as ProjectHealth['goalContinuations'],
    goalRevision: null as number | null,
  }
  const base = join(projectPath, '.future-code')
  let sessionScoped = false
  try { sessionScoped = statSync(join(base, 'goals')).isDirectory() } catch { /* older-only store */ }
  // Once session namespaces exist, never present another session's legacy
  // root (or its REVIEW/pause) as this session's active objective.
  const file = sessionScoped && sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)
    ? join(base, 'goals', sessionId, 'goal-autonomy.json')
    : sessionScoped ? null : join(base, 'goal-autonomy.json')
  if (!file) return result
  let stat: { size: number }
  try {
    stat = statSync(file)
  } catch {
    return result
  }
  // Bounded parse: never trust a path under a project we do not own.
  if (stat.size > MAX_GOAL_STATE_BYTES) return result
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return result
  }
  let parsed: GoalAutonomyLite
  try {
    parsed = JSON.parse(raw) as GoalAutonomyLite
  } catch {
    return result
  }
  if (typeof parsed.goal === 'string' && parsed.goal.length > 0 && parsed.goal.length <= 4096) {
    result.activeGoal = parsed.goal
    result.goalScope = sessionScoped ? 'session' : 'legacy-unowned'
  }
  if (typeof parsed.state === 'string' && parsed.state.length <= 64) {
    result.goalState = parsed.state
  }
  if (typeof parsed.revision === 'number' && Number.isSafeInteger(parsed.revision) && parsed.revision >= 0) {
    result.goalRevision = parsed.revision
  }
  const cont = parsed.continuations
  const total = parsed.totalContinuations
  if (typeof cont === 'number' && Number.isSafeInteger(cont) && cont >= 0 &&
      typeof total === 'number' && Number.isSafeInteger(total) && total >= 0) {
    result.goalContinuations = { continuations: cont, totalContinuations: total }
  }
  return result
}

export interface ScanOptions {
  /** Session-store root (defaults to `~/.future/projects`). */
  projectsDir?: string
  /** Upper bound on projects scanned, protecting against runaway stores. */
  maxProjects?: number
  /** Upper bound on transcript stat calls per project. */
  maxSessionsPerProject?: number
  /** Skip projects whose latest transcript is older than this (epoch ms). */
  minLatestModifiedMs?: number
  /** Override the per-project "large" threshold (defaults to LARGE_PROJECT_BYTES). */
  largeProjectBytes?: number
}

/** Scan every project directory under the session store and grade health. */
export function scanProjectHealth(options: ScanOptions = {}): ProjectHealthReport[] {
  const projectsDir = options.projectsDir ?? join(homedir(), '.future', 'projects')
  const maxProjects = options.maxProjects ?? 500
  const maxSessionsPerProject = options.maxSessionsPerProject ?? 2000
  const largeProjectBytes = options.largeProjectBytes ?? LARGE_PROJECT_BYTES

  let dirEntries: string[]
  try {
    dirEntries = readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const reports: ProjectHealthReport[] = []
  const now = Date.now()
  for (const entry of dirEntries) {
    if (reports.length >= maxProjects) break
    if (!entry.isDirectory()) continue
    const projectDir = join(projectsDir, entry.name)
    const sessions = listSessionFiles(projectDir).slice(0, maxSessionsPerProject)
    const latestSession = sessions[0] ?? null
    if (options.minLatestModifiedMs !== undefined) {
      if (latestSession === null || latestSession.modifiedMs < options.minLatestModifiedMs) continue
    }

    // Authoritative project path from the newest transcript's cwd record;
    // fall back to the lossy decode when no transcript is readable.
    let projectPath = decodeProjectDirName(entry.name)
    let projectPathExact = false
    if (latestSession !== null) {
      const cwd = readTranscriptCwd(join(projectDir, `${latestSession.sessionId}.jsonl`))
      if (cwd !== null) {
        projectPath = cwd
        projectPathExact = true
      }
    }

    const goal = readGoalState(projectPath, latestSession?.sessionId)
    const totalBytes = sessions.reduce((acc, s) => acc + s.bytes, 0)
    const project: ProjectHealth = {
      dirName: entry.name,
      projectPath,
      projectPathExact,
      sessions,
      latestSession,
      totalBytes,
      ...goal,
    }

    const flags: ProjectHealthFlag[] = []
    if (latestSession !== null && now - latestSession.modifiedMs > STALE_SESSION_MS) {
      flags.push({
        kind: 'stale',
        detail: `latest transcript untouched for ${Math.round((now - latestSession.modifiedMs) / 3600000)}h`,
      })
    }
    if (
      goal.goalState === 'ACTIVE' &&
      goal.activeGoal !== null &&
      (latestSession === null || now - latestSession.modifiedMs > STUCK_GOAL_STALE_MS)
    ) {
      flags.push({
        kind: 'stuck-active-goal',
        detail: 'goal is ACTIVE but no session has run recently — autonomous continuation may be wedged',
      })
    }
    if (totalBytes > largeProjectBytes) {
      flags.push({
        kind: 'large-project',
        detail: `${(totalBytes / 1024 / 1024).toFixed(0)}MB of transcripts — consider archiving`,
      })
    }
    reports.push({ project, flags })
  }

  reports.sort((a, b) => {
    const aMs = a.project.latestSession?.modifiedMs ?? 0
    const bMs = b.project.latestSession?.modifiedMs ?? 0
    return bMs - aMs
  })
  return reports
}

/** Compact human summary of a scan — the text body for /sessions. */
export function formatProjectHealthReport(reports: ProjectHealthReport[]): string {
  if (reports.length === 0) return 'No projects found in the session store.'
  const now = Date.now()
  const lines: string[] = []
  lines.push('Session health across all projects (most recent first):')
  lines.push('')
  for (const { project, flags } of reports) {
    const age = project.latestSession
      ? describeAge(now - project.latestSession.modifiedMs)
      : 'no sessions'
    const sizeMb = (project.totalBytes / 1024 / 1024).toFixed(1)
    const goal =
      project.activeGoal !== null
        ? ` | ${project.goalScope === 'legacy-unowned' ? 'legacy goal (session unknown)' : 'goal'}: ${truncate(project.activeGoal, 40)}${project.goalState ? ` (${project.goalState})` : ''}`
        : ''
    const pathNote = project.projectPathExact ? '' : ' (approx)'
    lines.push(
      `- ${displayProjectPath(project)}${pathNote}: ${project.sessions.length} session(s), ${sizeMb}MB, last active ${age}${goal}`,
    )
    for (const flag of flags) {
      lines.push(`  ! ${flag.kind}: ${flag.detail}`)
    }
  }
  return lines.join('\n')
}

function displayProjectPath(project: ProjectHealth): string {
  const home = homedir()
  if (project.projectPath === home) return '~'
  if (project.projectPath.startsWith(home + '/')) {
    return '~/' + project.projectPath.slice(home.length + 1)
  }
  return project.projectPath
}

function describeAge(ms: number): string {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}
