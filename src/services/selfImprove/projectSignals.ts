/**
 * Host-observed project feedback for background self-improvement.
 *
 * Advisory only: these observations may focus source investigation. They never
 * establish correctness, authorize a change, or replace independent validation.
 * Raw goals, errors, tool output, and conversation text are never persisted.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const MAX_PROJECT_SIGNALS = 128
export const MAX_PROJECT_FEEDBACK_BYTES = 128 * 1024
export const MAX_PROMPT_PROJECT_SIGNALS = 12
const kinds = new Set(['goal-review', 'goal-blocked', 'incomplete-turn', 'recovered'])
const categories = new Set(['turn-ended', 'provider', 'tool', 'context', 'unknown'])
// Never fall back to a potentially blocking or symlink-following foreground read.
// Unsupported platforms omit this optional advisory feature rather than hang work.
const SAFE_READ_FLAGS = typeof constants.O_NONBLOCK === 'number' && typeof constants.O_NOFOLLOW === 'number'
  ? constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW : null

export interface ProjectSignalInput {
  projectId: string
  kind: 'goal-review' | 'goal-blocked' | 'incomplete-turn' | 'recovered'
  errorCategory?: 'turn-ended' | 'provider' | 'tool' | 'context' | 'unknown'
  recoveryAttempts?: number
  tokenCount?: number
  durationMs?: number
}
export interface ProjectSignal {
  schema: 1
  id: string
  projectHash: string
  at: number
  kind: ProjectSignalInput['kind']
  errorCategory?: ProjectSignalInput['errorCategory']
  recoveryAttempts?: number
  tokenCount?: number
  durationMs?: number
}
export function defaultProjectFeedbackPath(): string {
  return join(homedir(), '.future', 'self-improve', 'project-feedback.jsonl')
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function validSignal(value: unknown): value is ProjectSignal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const s = value as Record<string, unknown>
  const allowed = new Set(['schema', 'id', 'projectHash', 'at', 'kind', 'errorCategory', 'recoveryAttempts', 'tokenCount', 'durationMs'])
  if (Object.keys(s).some(key => !allowed.has(key)) || s.schema !== 1 ||
    typeof s.id !== 'string' || !/^[a-f0-9]{64}$/.test(s.id) ||
    typeof s.projectHash !== 'string' || !/^[a-f0-9]{64}$/.test(s.projectHash) ||
    !Number.isSafeInteger(s.at) || Number(s.at) < 0 || typeof s.kind !== 'string' || !kinds.has(s.kind) ||
    (s.errorCategory !== undefined && (typeof s.errorCategory !== 'string' || !categories.has(s.errorCategory)))) return false
  for (const key of ['recoveryAttempts', 'tokenCount'] as const)
    if (s[key] !== undefined && (!Number.isSafeInteger(s[key]) || Number(s[key]) < 0)) return false
  if (s.durationMs !== undefined && (typeof s.durationMs !== 'number' ||
    !Number.isFinite(s.durationMs) || s.durationMs < 0 || s.durationMs > Number.MAX_SAFE_INTEGER)) return false
  const id = hash(JSON.stringify([s.projectHash, s.kind, s.errorCategory ?? null, Math.floor(Number(s.at) / 60_000)]))
  return id === s.id
}

/** Read only a bounded tail. A corrupt/partial record is not usable feedback. */
export function recentProjectSignals(path = defaultProjectFeedbackPath(), limit = MAX_PROMPT_PROJECT_SIGNALS): ProjectSignal[] {
  if (SAFE_READ_FLAGS === null || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROJECT_SIGNALS) return []
  let fd: number | undefined
  try {
    fd = openSync(path, SAFE_READ_FLAGS)
    const metadata = fstatSync(fd)
    if (!metadata.isFile()) return []
    const size = metadata.size
    const length = Math.min(size, MAX_PROJECT_FEEDBACK_BYTES)
    const bytes = Buffer.alloc(length)
    const count = readSync(fd, bytes, 0, length, size - length)
    let text = bytes.subarray(0, count).toString('utf8')
    if (size > length) text = text.slice(text.indexOf('\n') + 1)
    const records: ProjectSignal[] = []
    for (const line of text.split('\n').slice(-MAX_PROJECT_SIGNALS - 1)) {
      if (!line || Buffer.byteLength(line, 'utf8') > 1024) continue
      try { const value: unknown = JSON.parse(line); if (validSignal(value)) records.push(value) } catch { /* partial/corrupt observation */ }
    }
    return records.slice(-limit)
  } catch { return [] }
  finally { if (fd !== undefined) { try { closeSync(fd) } catch { /* advisory read */ } } }
}

/** Best-effort bounded feedback: persistence failure never stops project work.
 * Atomic snapshots keep readers out of partial writes. Concurrent processes can
 * omit advisory observations; this log is deliberately never acceptance proof. */
export function recordProjectSignal(input: ProjectSignalInput,
  options: { path?: string; now?: number } = {}): boolean {
  let temporary: string | undefined
  try {
    if (SAFE_READ_FLAGS === null || !input || typeof input.projectId !== 'string' || !input.projectId.trim() ||
      Buffer.byteLength(input.projectId, 'utf8') > 4096) return false
    const at = options.now ?? Date.now()
    const projectHash = hash(input.projectId)
    const value: ProjectSignal = {
      schema: 1,
      id: hash(JSON.stringify([projectHash, input.kind, input.errorCategory ?? null, Math.floor(at / 60_000)])),
      projectHash, at, kind: input.kind,
      ...(input.errorCategory === undefined ? {} : { errorCategory: input.errorCategory }),
      ...(input.recoveryAttempts === undefined ? {} : { recoveryAttempts: input.recoveryAttempts }),
      ...(input.tokenCount === undefined ? {} : { tokenCount: input.tokenCount }),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    }
    if (!validSignal(value)) return false
    const path = options.path ?? defaultProjectFeedbackPath()
    try { if (!lstatSync(path).isFile()) return false }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false }
    const records = recentProjectSignals(path, MAX_PROJECT_SIGNALS)
    if (records.some(record => record.id === value.id)) return false
    const text = [...records, value].slice(-MAX_PROJECT_SIGNALS).map(record => JSON.stringify(record)).join('\n') + '\n'
    if (Buffer.byteLength(text, 'utf8') > MAX_PROJECT_FEEDBACK_BYTES) return false
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    temporary = path + '.' + randomUUID() + '.tmp'
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
    temporary = undefined
    return true
  } catch { return false }
  finally { if (temporary) { try { unlinkSync(temporary) } catch { /* best effort */ } } }
}
