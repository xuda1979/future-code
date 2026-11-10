/**
 * Self-improvement ledger — append-only record of every cycle and every
 * finding, stored at ~/.future/self-improve/ledger.jsonl.
 *
 * Pure data functions (path injection via options) so the module is safe to
 * unit test and import from the SDK without CLI bootstrap.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const LEDGER_VERSION = 1

export type FindingDecision = 'accepted' | 'rejected' | 'deferred'

export type LedgerEntry =
  | {
      kind: 'cycle-start'
      version: typeof LEDGER_VERSION
      ts: number
      cycleId: string
      repoPath: string
      repoBranch: string
      pid?: number
    }
  | {
      kind: 'cycle-end'
      version: typeof LEDGER_VERSION
      ts: number
      cycleId: string
      status: 'completed' | 'error' | 'no-findings' | 'lock-held'
      findings: number
      accepted: number
      error?: string
    }
  | {
      kind: 'finding'
      version: typeof LEDGER_VERSION
      ts: number
      cycleId: string
      fingerprint: string
      title: string
      category: 'bug' | 'improvement' | 'efficiency' | 'reliability'
      severity: 'low' | 'medium' | 'high' | 'critical'
      detail: string
      decision: FindingDecision
      decisionReason?: string
    }
  | {
      kind: 'change'
      version: typeof LEDGER_VERSION
      ts: number
      cycleId: string
      fingerprint: string
      branch: string
      commit?: string
      built: boolean
      tested: boolean
      merged: boolean
      pushed: boolean
      note?: string
      worktreePath?: string
    }

export function defaultLedgerDir(): string {
  return join(homedir(), '.future', 'self-improve')
}

export function defaultLedgerPath(): string {
  return join(defaultLedgerDir(), 'ledger.jsonl')
}

/** Stable fingerprint for a finding so duplicates across cycles dedup. */
export function fingerprintFinding(
  title: string,
  category: string,
  primaryTarget: string,
): string {
  const normalized =
    title.trim().toLowerCase().replace(/\s+/g, ' ') +
    '|' +
    category.trim().toLowerCase() +
    '|' +
    primaryTarget.trim().toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/** Read every entry from a ledger file (empty array if missing/corrupt). */
export function readLedger(
  ledgerPath: string = defaultLedgerPath(),
): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return []
  const entries: LedgerEntry[] = []
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as LedgerEntry
      if (parsed && typeof parsed === 'object' && 'kind' in parsed) {
        entries.push(parsed)
      }
    } catch {
      // Corrupt/partial line — skip (append-only file, tail may race).
    }
  }
  return entries
}

/** Append one entry to the ledger, creating the directory if needed. */
export function appendLedgerEntry(
  entry: LedgerEntry,
  ledgerPath: string = defaultLedgerPath(),
): void {
  mkdirSync(dirname(ledgerPath), { recursive: true })
  writeFileSync(ledgerPath, JSON.stringify(entry) + '\n', { flag: 'a' })
}

/** Timestamp (ms) of the last completed cycle, or null if none yet. */
export function lastCycleEndTs(
  entries: LedgerEntry[],
): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'cycle-end') return e.ts
  }
  return null
}

/** All fingerprints already recorded (any decision) — used for dedup. */
export function recordedFingerprints(entries: LedgerEntry[]): Set<string> {
  const set = new Set<string>()
  for (const e of entries) {
    if (e.kind === 'finding') set.add(e.fingerprint)
  }
  return set
}

/**
 * Should a new cycle start now?
 * - Never if another cycle is mid-run (cycle-start without matching cycle-end).
 * - Only if `intervalMs` has elapsed since the last completed cycle.
 * - Always if force=true (operator-invoked /self-improve run), except when
 *   a cycle is genuinely still in flight.
 */
export function shouldStartCycle(
  entries: LedgerEntry[],
  now: number,
  intervalMs: number,
  force = false,
): { start: boolean; reason: string } {
  const openCycles = new Map<string, Extract<LedgerEntry, { kind: 'cycle-start' }>>()
  for (const e of entries) {
    if (e.kind === 'cycle-start') openCycles.set(e.cycleId, e)
    else if (e.kind === 'cycle-end') openCycles.delete(e.cycleId)
  }
  for (const [id, cycle] of openCycles) {
    // Legacy/unknown owners remain conservative. Only a kernel-confirmed
    // absent process can release a stranded advisory marker after a crash.
    if (!Number.isSafeInteger(cycle.pid) || cycle.pid! <= 0)
      return { start: false, reason: `cycle ${id} still in flight (owner unknown)` }
    try { process.kill(cycle.pid!, 0); return { start: false, reason: `cycle ${id} still in flight` } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        return { start: false, reason: `cycle ${id} owner could not be reconciled` }
    }
  }
  if (openCycles.size) return { start: true, reason: 'recovering an abandoned cycle after its owner exited' }
  const lastEnd = lastCycleEndTs(entries)
  if (lastEnd === null) return { start: true, reason: 'no prior cycle' }
  const elapsed = now - lastEnd
  if (elapsed >= intervalMs) {
    return {
      start: true,
      reason: `${Math.round(elapsed / 60_000)}m since last cycle (interval ${Math.round(intervalMs / 60_000)}m)`,
    }
  }
  if (force) {
    return { start: true, reason: 'forced run' }
  }
  return {
    start: false,
    reason: `only ${Math.round(elapsed / 60_000)}m since last cycle (interval ${Math.round(intervalMs / 60_000)}m)`,
  }
}

/** Close only stranded advisory records with a kernel-confirmed dead owner.
 * Record failure, never success; otherwise the same old marker would bypass
 * the interval forever after every subsequent completed cycle. */
export function recoverAbandonedCycles(ledgerPath: string, now = Date.now()): number {
  const open = new Map<string, Extract<LedgerEntry, { kind: 'cycle-start' }>>()
  for (const entry of readLedger(ledgerPath)) {
    if (entry.kind === 'cycle-start') open.set(entry.cycleId, entry)
    else if (entry.kind === 'cycle-end') open.delete(entry.cycleId)
  }
  let recovered = 0
  for (const cycle of open.values()) {
    if (!Number.isSafeInteger(cycle.pid) || cycle.pid! <= 0) continue
    try { process.kill(cycle.pid!, 0) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
      appendLedgerEntry({ kind: 'cycle-end', version: 1, ts: now, cycleId: cycle.cycleId,
        status: 'error', findings: 0, accepted: 0, error: 'Recovered abandoned cycle after its owner process exited' }, ledgerPath)
      recovered++
    }
  }
  return recovered
}
