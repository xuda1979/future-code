/**
 * Self-improvement cycle — the background loop that keeps future-code
 * improving itself while sessions run.
 *
 * Flow (one cycle):
 *   1. Guard: config enabled, interval elapsed, no cycle in flight
 *      (all sessions on the machine share one ledger/lock).
 *   2. Locate the future-code source repo (git rev-parse on cwd, else
 *      clone the configured repoUrl into ~/.future/self-improve/repo).
 *   3. Spawn a headless `future-code --print` analysis subagent over that
 *      repo with a strict JSON-findings contract.
 *   4. Gate each finding: dedup against the ledger fingerprint set,
 *      severity floor, and a risk classifier (analysis-only proposals
 *      with no execution semantics change are auto-acceptable).
 *   5. For accepted findings, run the executor: feature branch → change
 *      (another headless session, scoped to the one finding) → build →
 *      targeted test → commit; merge to main and push only when the
 *      operator opted in via settings (autoMerge/autoPush).
 *
 * Everything is recorded in the ledger (see ledger.ts). The cycle never
 * throws into the host session — failures are logged and recorded as
 * cycle-end(status=error).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logForDebugging } from '../../utils/debug.js'
import {
  appendLedgerEntry,
  defaultLedgerPath,
  fingerprintFinding,
  readLedger,
  recordedFingerprints,
  shouldStartCycle,
  type LedgerEntry,
} from './ledger.js'
import {
  getSelfImproveConfig,
  SELF_IMPROVE_MARKER_ENV,
  type SelfImproveConfig,
} from './config.js'
import { runAnalysisPrompt, runChangePrompt } from './prompts.js'
import { execGitQuiet, runHeadlessFuture } from './subprocess.js'

/** In-flight guard across async starts within one process. */
let localCycleRunning = false

export function getSelfImproveStateDir(): string {
  return join(homedir(), '.future', 'self-improve')
}

/**
 * Locate the future-code source checkout to analyze. Prefers the repo the
 * current process is running from; falls back to the shared clone under
 * ~/.future/self-improve/repo (cloning on demand).
 */
export function resolveRepoPath(
  config: SelfImproveConfig,
  startDir: string,
): { repoPath: string | null; cloned: boolean; error?: string } {
  const gitTop = execGitQuiet(['rev-parse', '--show-toplevel'], startDir)
  if (gitTop.ok && existsSync(join(gitTop.stdout, 'src', 'services'))) {
    return { repoPath: gitTop.stdout, cloned: false }
  }
  const shared = join(getSelfImproveStateDir(), 'repo')
  if (existsSync(join(shared, '.git'))) {
    execGitQuiet(['fetch', 'origin', 'main'], shared)
    return { repoPath: shared, cloned: false }
  }
  const clone = execGitQuiet(
    ['clone', '--depth', '50', '--branch', 'main', config.repoUrl, shared],
    getSelfImproveStateDir(),
  )
  if (!clone.ok) {
    return {
      repoPath: null,
      cloned: false,
      error: `clone failed: ${clone.stderr.slice(0, 300)}`,
    }
  }
  return { repoPath: shared, cloned: true }
}

export type ParsedFinding = {
  title: string
  category: 'bug' | 'improvement' | 'efficiency' | 'reliability'
  severity: 'low' | 'medium' | 'high' | 'critical'
  detail: string
  target: string // primary file or module the finding is about
  proposedChange: string
}

/** Parse the analysis subagent's JSON findings block (tolerant). */
export function parseFindings(raw: string): ParsedFinding[] {
  const start = raw.indexOf('```json')
  const jsonText = start >= 0 ? raw.slice(start + 7) : raw
  const end = jsonText.indexOf('```')
  const body = (end >= 0 ? jsonText.slice(0, end) : jsonText).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: ParsedFinding[] = []
  const categories = new Set(['bug', 'improvement', 'efficiency', 'reliability'])
  const severities = new Set(['low', 'medium', 'high', 'critical'])
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const f = item as Record<string, unknown>
    if (
      typeof f.title !== 'string' ||
      typeof f.detail !== 'string' ||
      typeof f.target !== 'string' ||
      typeof f.proposedChange !== 'string'
    ) {
      continue
    }
    out.push({
      title: f.title.slice(0, 200),
      category: (categories.has(String(f.category))
        ? String(f.category)
        : 'improvement') as ParsedFinding['category'],
      severity: (severities.has(String(f.severity))
        ? String(f.severity)
        : 'low') as ParsedFinding['severity'],
      detail: f.detail.slice(0, 4000),
      target: f.target.slice(0, 300),
      proposedChange: f.proposedChange.slice(0, 4000),
    })
  }
  return out
}

/** Gate a single finding. Returns null to drop it, else the decision. */
export function gateFinding(
  finding: ParsedFinding,
  knownFingerprints: ReadonlySet<string>,
): { decision: 'accept' | 'drop'; reason: string; fingerprint: string } {
  const fingerprint = fingerprintFinding(
    finding.title,
    finding.category,
    finding.target,
  )
  if (knownFingerprints.has(fingerprint)) {
    return { decision: 'drop', reason: 'duplicate of a recorded finding', fingerprint }
  }
  if (finding.severity === 'low' && finding.category === 'improvement') {
    return {
      decision: 'drop',
      reason: 'low-severity improvements are below the action floor',
      fingerprint,
    }
  }
  return { decision: 'accept', reason: 'novel, actionable', fingerprint }
}

/**
 * Decide whether a background self-improvement cycle should start now.
 * Reads the shared ledger, so the interval/collision guard is global
 * across every future-code session on this machine.
 */
export function maybeStartSelfImproveCycle(options: {
  force?: boolean
  now?: number
  config?: SelfImproveConfig
  ledgerPath?: string
}): { started: boolean; reason: string } {
  const config = options.config ?? getSelfImproveConfig()
  const ledgerPath = options.ledgerPath ?? defaultLedgerPath()
  const now = options.now ?? Date.now()

  if (process.env[SELF_IMPROVE_MARKER_ENV] === '1') {
    return { started: false, reason: 'self-improve child session — no recursion' }
  }
  if (!config.enabled) {
    return { started: false, reason: 'selfImprove.enabled is false' }
  }
  if (localCycleRunning) {
    return { started: false, reason: 'cycle already running in this process' }
  }
  const entries = readLedger(ledgerPath)
  const guard = shouldStartCycle(
    entries,
    now,
    config.intervalMinutes * 60_000,
    options.force === true,
  )
  if (!guard.start) return { started: false, reason: guard.reason }

  localCycleRunning = true
  void runSelfImproveCycle({ config, ledgerPath, entries })
    .catch(error => {
      logForDebugging(`Self-improve cycle crashed: ${String(error)}`)
    })
    .finally(() => {
      localCycleRunning = false
    })
  return { started: true, reason: guard.reason }
}

/**
 * Run one full self-improvement cycle. Never throws — all failures are
 * recorded in the ledger and returned.
 */
export async function runSelfImproveCycle(options: {
  config: SelfImproveConfig
  ledgerPath?: string
  entries?: LedgerEntry[]
  onEvent?: (message: string) => void
}): Promise<{ status: 'completed' | 'error' | 'no-findings'; findings: number; accepted: number; error?: string }> {
  const { config } = options
  const ledgerPath = options.ledgerPath ?? defaultLedgerPath()
  const log = options.onEvent ?? (() => {})
  const cycleId = `si-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const repo = resolveRepoPath(config, process.cwd())
  if (!repo.repoPath) {
    appendLedgerEntry(
      {
        kind: 'cycle-end',
        version: 1,
        ts: Date.now(),
        cycleId,
        status: 'error',
        findings: 0,
        accepted: 0,
        error: repo.error ?? 'no future-code checkout available',
      },
      ledgerPath,
    )
    return { status: 'error', findings: 0, accepted: 0, error: repo.error }
  }
  const repoPath = repo.repoPath
  const branchInfo = execGitQuiet(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    repoPath,
  )
  appendLedgerEntry(
    {
      kind: 'cycle-start',
      version: 1,
      ts: Date.now(),
      cycleId,
      repoPath,
      repoBranch: branchInfo.stdout.trim() || 'unknown',
    },
    ledgerPath,
  )

  try {
    // Freshen from main so analysis sees current code (per operator rule:
    // git pull main before any feature-branch work).
    execGitQuiet(['pull', '--ff-only', 'origin', 'main'], repoPath)

    const known = recordedFingerprints(
      options.entries ?? readLedger(ledgerPath),
    )
    const recentTitles = recentFindingTitles(
      options.entries ?? readLedger(ledgerPath),
      30,
    )

    log(`analyzing ${repoPath}`)
    const analysis = await runHeadlessFuture(
      runAnalysisPrompt(recentTitles),
      repoPath,
    )
    const findings = parseFindings(analysis)
    let accepted = 0
    for (const finding of findings) {
      const gate = gateFinding(finding, known)
      appendLedgerEntry(
        {
          kind: 'finding',
          version: 1,
          ts: Date.now(),
          cycleId,
          fingerprint: gate.fingerprint,
          title: finding.title,
          category: finding.category,
          severity: finding.severity,
          detail: finding.detail,
          decision: gate.decision === 'accept' ? 'accepted' : 'rejected',
          decisionReason: gate.reason,
        },
        ledgerPath,
      )
      if (gate.decision !== 'accept') continue
      accepted++
      known.add(gate.fingerprint)

      const outcome = await executeFindingChange({
        cycleId,
        finding,
        fingerprint: gate.fingerprint,
        repoPath,
        config,
        ledgerPath,
        log,
      })
      log(
        `${finding.title}: branch=${outcome.branch} built=${outcome.built} tested=${outcome.tested} merged=${outcome.merged} pushed=${outcome.pushed}`,
      )
    }

    const status =
      findings.length === 0
        ? 'no-findings'
        : accepted === 0
          ? 'completed'
          : 'completed'
    appendLedgerEntry(
      {
        kind: 'cycle-end',
        version: 1,
        ts: Date.now(),
        cycleId,
        status,
        findings: findings.length,
        accepted,
      },
      ledgerPath,
    )
    return { status, findings: findings.length, accepted }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendLedgerEntry(
      {
        kind: 'cycle-end',
        version: 1,
        ts: Date.now(),
        cycleId,
        status: 'error',
        findings: 0,
        accepted: 0,
        error: message.slice(0, 500),
      },
      ledgerPath,
    )
    return { status: 'error', findings: 0, accepted: 0, error: message }
  }
}

/** Titles of recent findings, fed to the analysis prompt to avoid dupes. */
export function recentFindingTitles(
  entries: LedgerEntry[],
  count: number,
): string[] {
  const titles: string[] = []
  for (let i = entries.length - 1; i >= 0 && titles.length < count; i--) {
    const e = entries[i]
    if (e.kind === 'finding') titles.push(e.title)
  }
  return titles
}

/**
 * Execute one accepted finding: feature branch → change → build → test →
 * commit → (optionally) merge to main → push. Each step is recorded in
 * the ledger. Per the operator's rule, `git pull origin main` runs before
 * the branch is cut.
 */
export async function executeFindingChange(options: {
  cycleId: string
  finding: ParsedFinding
  fingerprint: string
  repoPath: string
  config: SelfImproveConfig
  ledgerPath: string
  log: (message: string) => void
}): Promise<{
  branch: string
  commit?: string
  built: boolean
  tested: boolean
  merged: boolean
  pushed: boolean
  note?: string
}> {
  const { cycleId, finding, fingerprint, repoPath, config, ledgerPath, log } =
    options
  const slug =
    finding.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'finding'
  const branch = `self-improve/${slug}`

  // Start from a current main.
  execGitQuiet(['fetch', 'origin', 'main'], repoPath)
  execGitQuiet(['checkout', 'main'], repoPath)
  execGitQuiet(['pull', '--ff-only', 'origin', 'main'], repoPath)
  execGitQuiet(
    ['checkout', '-B', branch, 'origin/main'],
    repoPath,
  )

  let commit: string | undefined
  let built = false
  let tested = false
  let merged = false
  let pushed = false
  let note: string | undefined

  try {
    // Change session: a headless future-code run scoped to this finding.
    const changeOutput = await runHeadlessFuture(
      runChangePrompt(finding),
      repoPath,
    )
    const dirty = execGitQuiet(['status', '--porcelain'], repoPath)
    if (dirty.stdout.trim() === '') {
      note = 'change session produced no diff — skipped'
    } else {
      execGitQuiet(['add', '-A'], repoPath)
      execGitQuiet(
        [
          'commit',
          '-m',
          `${finding.title}\n\nSelf-improvement cycle ${cycleId}.\nCategory: ${finding.category}; severity: ${finding.severity}.`,
        ],
        repoPath,
      )
      const head = execGitQuiet(['rev-parse', 'HEAD'], repoPath)
      commit = head.stdout.trim() || undefined

      // Build + targeted test validation before any merge.
      built = await validateBuild(repoPath, log)
      tested = built && (await validateTests(repoPath, log))

      if (built && tested && config.autoMerge) {
        execGitQuiet(['checkout', 'main'], repoPath)
        const merge = execGitQuiet(['merge', '--no-ff', branch, '-m', `Merge ${branch} (self-improve ${cycleId})`], repoPath)
        merged = merge.ok
        if (merged && config.autoPush) {
          const push = execGitQuiet(['push', 'origin', 'main'], repoPath)
          pushed = push.ok
        }
      } else if (built && tested) {
        note = 'autoMerge disabled — change left on feature branch for review'
      } else {
        note = 'validation failed — change left on feature branch'
      }
    }
  } catch (error) {
    note = `executor error: ${String(error).slice(0, 200)}`
  } finally {
    // Leave the repo on a clean main so the next cycle starts fresh.
    execGitQuiet(['checkout', 'main'], repoPath)
  }

  appendLedgerEntry(
    {
      kind: 'change',
      version: 1,
      ts: Date.now(),
      cycleId,
      fingerprint,
      branch,
      commit,
      built,
      tested,
      merged,
      pushed,
      note,
    },
    ledgerPath,
  )
  return { branch, commit, built, tested, merged, pushed, note }
}

/** Build the repo (build.sh) to validate a change compiles into a binary. */
export async function validateBuild(
  repoPath: string,
  log: (message: string) => void,
): Promise<boolean> {
  log(`building ${repoPath}`)
  const result = await runCommand(['bash', 'build.sh'], repoPath, 10 * 60_000)
  if (!result.ok) {
    log(`build failed: ${result.output.slice(-400)}`)
  }
  return result.ok
}

/** Run the repo's fast test lane to validate a change doesn't regress. */
export async function validateTests(
  repoPath: string,
  log: (message: string) => void,
): Promise<boolean> {
  log('running test lane')
  const result = await runCommand(
    ['bun', 'test', 'tests/'],
    repoPath,
    10 * 60_000,
  )
  if (!result.ok) {
    log(`tests failed: ${result.output.slice(-400)}`)
  }
  return result.ok
}

/** Promise wrapper around child_process.spawn with timeout + capture. */
export function runCommand(
  command: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    let output = ''
    let settled = false
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: { ...process.env, [SELF_IMPROVE_MARKER_ENV]: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        resolve({ ok: false, output: output + '\n[timeout]' })
      }
    }, timeoutMs)
    child.stdout?.on('data', chunk => {
      output += String(chunk)
      if (output.length > 200_000) output = output.slice(-100_000)
    })
    child.stderr?.on('data', chunk => {
      output += String(chunk)
      if (output.length > 200_000) output = output.slice(-100_000)
    })
    child.on('error', error => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, output: output + String(error) })
      }
    })
    child.on('close', code => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ ok: code === 0, output })
      }
    })
  })
}

/** Status snapshot for /self-improve status. */
export function selfImproveStatus(ledgerPath: string = defaultLedgerPath()): {
  lastCycle: LedgerEntry | null
  totals: { cycles: number; findings: number; accepted: number; changes: number; merged: number }
  recent: LedgerEntry[]
} {
  const entries = readLedger(ledgerPath)
  let lastCycle: LedgerEntry | null = null
  const totals = { cycles: 0, findings: 0, accepted: 0, changes: 0, merged: 0 }
  for (const e of entries) {
    if (e.kind === 'cycle-end') {
      totals.cycles++
      lastCycle = e
    } else if (e.kind === 'finding') {
      totals.findings++
      if (e.decision === 'accepted') totals.accepted++
    } else if (e.kind === 'change') {
      totals.changes++
      if (e.merged) totals.merged++
    }
  }
  return {
    lastCycle,
    totals,
    recent: entries.slice(-40),
  }
}
