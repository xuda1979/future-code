/**
 * Self-improvement cycle — the background loop that keeps future-code
 * improving itself while sessions run.
 *
 * Flow (one cycle):
 *   1. Guard: config enabled, interval/advisory history permits a cycle,
 *      and no cycle is running in this process.
 *   2. Locate the configured source in the managed clone. Analysis and
 *      changes use separate private worktrees pinned to fetched main.
 *   3. Spawn a headless `future-code --print` analysis subagent over that
 *      repo with a strict JSON-findings contract.
 *   4. Bound and deduplicate findings. Finding admission authorizes a
 *      proposal, never a correctness or acceptance claim.
 *   5. For accepted findings, run the executor: feature branch → change
 *      (another headless session, scoped to the one finding) → build →
 *      targeted test → commit; merge to main and push only when the
 *      operator opted in via settings (autoMerge/autoPush).
 *
 * Everything is recorded in the ledger (see ledger.ts). The cycle never
 * throws into the host session — failures are logged and recorded as
 * cycle-end(status=error).
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { logForDebugging } from '../../utils/debug.js'
import {
  appendLedgerEntry,
  defaultLedgerPath,
  fingerprintFinding,
  readLedger,
  recordedFingerprints,
  recoverAbandonedCycles,
  shouldStartCycle,
  type LedgerEntry,
} from './ledger.js'
import {
  getSelfImproveConfig,
  SELF_IMPROVE_MARKER_ENV,
  type SelfImproveConfig,
} from './config.js'
import { runAnalysisPrompt, runChangePrompt } from './prompts.js'
import { execGitQuiet, runHeadlessFuture, runSelfImproveProcess } from './subprocess.js'

/** In-flight guard across async starts within one process. */
let localCycleRunning = false

export function getSelfImproveStateDir(): string {
  return join(homedir(), '.future', 'self-improve')
}

/**
 * Use a managed checkout for the configured repository, never the foreground
 * project's checkout. The current project may be an unrelated src/services repo.
 */
export function resolveRepoPath(
  config: SelfImproveConfig,
  _startDir: string,
): { repoPath: string | null; cloned: boolean; error?: string } {
  try {
    mkdirSync(getSelfImproveStateDir(), { recursive: true })
    const shared = join(getSelfImproveStateDir(), 'repo')
    if (existsSync(join(shared, '.git'))) {
      const origin = execGitQuiet(['remote', 'get-url', 'origin'], shared)
      const identity = (url: string) => url.trim().replace(/^git@github\.com:/, 'https://github.com/').replace(/\/?\.git\/?$/, '').replace(/\/$/, '')
      if (!origin.ok || identity(origin.stdout) !== identity(config.repoUrl))
        return { repoPath: null, cloned: false, error: 'Managed self-improvement checkout belongs to a different repository' }
      const fetched = execGitQuiet(['fetch', 'origin', 'main'], shared)
      if (!fetched.ok) return { repoPath: null, cloned: false, error: `fetch failed: ${fetched.stderr.slice(-300)}` }
      if (checkedGit(['branch', '--show-current'], shared) === 'main' && !checkedGit(['status', '--porcelain'], shared))
        checkedGit(['merge', '--ff-only', 'origin/main'], shared)
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
  } catch (error) {
    return { repoPath: null, cloned: false, error: error instanceof Error ? error.message : String(error) }
  }
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
export function parseFindings(raw: string, strict = false): ParsedFinding[] {
  const start = raw.indexOf('```json')
  const jsonText = start >= 0 ? raw.slice(start + 7) : raw
  const end = jsonText.indexOf('```')
  const body = (end >= 0 ? jsonText.slice(0, end) : jsonText).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    if (strict) throw new Error('Analysis did not return valid JSON findings')
    return []
  }
  if (!Array.isArray(parsed)) {
    if (strict) throw new Error('Analysis findings must be an array')
    return []
  }
  if (strict && parsed.length > 3) throw new Error('Analysis exceeded the three-finding budget')
  const out: ParsedFinding[] = []
  const categories = new Set(['bug', 'improvement', 'efficiency', 'reliability'])
  const severities = new Set(['low', 'medium', 'high', 'critical'])
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      if (strict) throw new Error('Invalid analysis finding')
      continue
    }
    const f = item as Record<string, unknown>
    if (strict && (!categories.has(String(f.category)) || !severities.has(String(f.severity))))
      throw new Error('Analysis finding has an invalid category or severity')
    if (
      typeof f.title !== 'string' ||
      typeof f.detail !== 'string' ||
      typeof f.target !== 'string' ||
      typeof f.proposedChange !== 'string'
    ) {
      if (strict) throw new Error('Analysis finding is missing required text fields')
      continue
    }
    if (strict && [f.title, f.detail, f.target, f.proposedChange].some(value => !(value as string).trim()))
      throw new Error('Analysis finding contains an empty required field')
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
    if (out.length === 3) break
  }
  return out
}

function checkedGit(args: string[], cwd: string): string {
  const result = execGitQuiet(args, cwd)
  if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.stderr.slice(-500)}`)
  return result.stdout.trim()
}

interface ImprovementWorkspace { path: string; parent: string; base: string }
function prepareWorkspace(repoPath: string, ledgerPath: string, branch?: string, frozenCommit?: string): ImprovementWorkspace {
  if (!frozenCommit) checkedGit(['fetch', 'origin', 'main'], repoPath)
  const base = checkedGit(['rev-parse', '--verify', `${frozenCommit ?? 'origin/main'}^{commit}`], repoPath)
  const parent = join(dirname(ledgerPath), 'worktrees')
  mkdirSync(parent, { recursive: true })
  const unique = mkdtempSync(join(parent, 'cycle-'))
  const path = join(unique, 'checkout')
  checkedGit(['worktree', 'add', ...(branch ? ['-b', branch] : ['--detach']), path, base], repoPath)
  return { path, parent: unique, base }
}

function releaseWorkspace(repoPath: string, workspace: ImprovementWorkspace, log: (text: string) => void): void {
  const removed = execGitQuiet(['worktree', 'remove', workspace.path], repoPath)
  if (removed.ok) rmSync(workspace.parent, { recursive: true, force: true })
  else log(`Preserved worktree for inspection: ${workspace.path}`)
}

/** Candidates cannot rewrite the baseline commands/checks that certify them.
 * New regression tests are allowed; changes to existing verifiers need review. */
function changedVerificationInputs(repoPath: string, base: string, commit: string): string[] {
  const parts = checkedGit(['diff', '--no-renames', '--name-status', '-z', base, commit], repoPath).split('\0')
  const protectedPaths: string[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!, path = parts[i + 1]!
    if (path.startsWith('scripts/') || path.startsWith('.github/') ||
      (path.startsWith('tests/') && status !== 'A') ||
      ['AGENTS.md', 'build.sh', 'package.json', 'bun.lock', 'bun.lockb', 'bunfig.toml', 'tsconfig.json', '.gitignore', '.gitattributes', '.gitmodules'].includes(path))
      protectedPaths.push(path)
  }
  return protectedPaths
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
 * Reads shared advisory history; the local flag prevents overlap in this
 * process. Unique worktrees and checked promotion protect cross-process Git
 * state. This is not a transactional cross-process token/quota scheduler.
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
 * Run one cycle. Execution failures are recorded and returned. Persistence
 * failures may still reject and are contained by the scheduler boundary.
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
  recoverAbandonedCycles(ledgerPath)
  appendLedgerEntry(
    {
      kind: 'cycle-start',
      version: 1,
      ts: Date.now(),
      cycleId,
      repoPath,
      repoBranch: branchInfo.stdout.trim() || 'unknown',
      pid: process.pid,
    },
    ledgerPath,
  )

  let analysisWorkspace: ImprovementWorkspace | undefined
  try {
    analysisWorkspace = prepareWorkspace(repoPath, ledgerPath)

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
      analysisWorkspace.path,
    )
    if (checkedGit(['status', '--porcelain'], analysisWorkspace.path))
      throw new Error('Read-only analysis modified its private worktree; preserved for inspection')
    const findings = parseFindings(analysis, true)
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
  } finally {
    if (analysisWorkspace) releaseWorkspace(repoPath, analysisWorkspace, log)
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
 * the ledger. Proposals start from a pinned fetched base in private worktrees;
 * foreground checkouts are never switched or used to assemble a candidate.
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
  worktreePath?: string
}> {
  const { cycleId, finding, fingerprint, repoPath, config, ledgerPath, log } =
    options
  const slug =
    finding.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'finding'
  const branch = `self-improve/${slug}-${randomUUID().slice(0, 8)}`

  let commit: string | undefined
  let built = false
  let tested = false
  let merged = false
  let pushed = false
  let note: string | undefined
  let workspace: ImprovementWorkspace | undefined
  let verificationWorkspace: ImprovementWorkspace | undefined

  try {
    workspace = prepareWorkspace(repoPath, ledgerPath, branch)
    const changePath = workspace.path
    // Change session: a headless future-code run scoped to this finding.
    await runHeadlessFuture(
      runChangePrompt(finding),
      changePath,
    )
    const dirty = checkedGit(['status', '--porcelain'], changePath)
    if (!dirty) {
      note = 'change session produced no diff — skipped'
    } else {
      checkedGit(['add', '-A'], changePath)
      checkedGit(
        [
          'commit',
          '-m',
          `${finding.title}\n\nSelf-improvement cycle ${cycleId}.\nCategory: ${finding.category}; severity: ${finding.severity}.`,
        ],
        changePath,
      )
      commit = checkedGit(['rev-parse', 'HEAD'], changePath)
      if (commit === workspace.base) throw new Error('Change session did not create a candidate commit')

      // Build + targeted test validation before any merge.
      const changedChecks = changedVerificationInputs(changePath, workspace.base, commit)
      if (changedChecks.length) {
        note = `Baseline verification inputs changed; independent review required: ${changedChecks.join(', ')}`
      } else {
        // Rebuild evidence from the committed candidate in a fresh tree;
        // never accept the proposer's ignored files or exploratory caches.
        verificationWorkspace = prepareWorkspace(repoPath, ledgerPath, undefined, commit)
        const verificationPath = verificationWorkspace.path
        const buildPassed = await validateBuild(verificationPath, log)
        if (checkedGit(['status', '--porcelain'], verificationPath)) throw new Error('Build changed the frozen candidate source')
        built = buildPassed
        if (built) {
          const checksPassed = await validateTests(verificationPath, log)
          if (checkedGit(['status', '--porcelain'], verificationPath)) throw new Error('Verification changed the frozen candidate source')
          tested = checksPassed
        }
      }

      if (built && tested && config.autoMerge) {
        checkedGit(['fetch', 'origin', 'main'], repoPath)
        if (resolve(repoPath) !== resolve(join(getSelfImproveStateDir(), 'repo')) ||
          checkedGit(['branch', '--show-current'], repoPath) !== 'main' ||
          checkedGit(['status', '--porcelain'], repoPath) ||
          checkedGit(['rev-parse', 'HEAD'], repoPath) !== workspace.base ||
          checkedGit(['rev-parse', 'origin/main'], repoPath) !== workspace.base) {
          note = 'Managed main is in use, changed, or advanced; candidate preserved for review'
        } else {
          checkedGit(['merge', '--ff-only', commit], repoPath)
          merged = true
          if (config.autoPush) {
            checkedGit(['push', 'origin', `${commit}:refs/heads/main`], repoPath)
            pushed = true
          }
        }
      } else if (built && tested) {
        note = 'autoMerge disabled — change left on feature branch for review'
      } else if (!note) {
        note = 'validation failed — change left on feature branch'
      }
    }
  } catch (error) {
    note = `executor error: ${String(error).slice(0, 200)}`
  } finally {
    if (workspace) releaseWorkspace(repoPath, workspace, log)
    if (verificationWorkspace) releaseWorkspace(repoPath, verificationWorkspace, log)
  }
  const worktreePath = [workspace, verificationWorkspace].find(tree => tree && existsSync(tree.path))?.path

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
      worktreePath,
    },
    ledgerPath,
  )
  return { branch, commit, built, tested, merged, pushed, note, worktreePath }
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

/** Run the required offline gates and stop at the first failing lane. */
export async function validateTests(
  repoPath: string,
  log: (message: string) => void,
): Promise<boolean> {
  log('running test lane')
  for (const gate of ['correctness', 'resilience', 'foundry', 'swarm', 'commands']) {
    const result = await runCommand(['node', `scripts/test-${gate}.mjs`], repoPath, 15 * 60_000)
    if (!result.ok) { log(`${gate} tests failed: ${result.output.slice(-400)}`); return false }
  }
  return true
}

/** Promise wrapper around child_process.spawn with timeout + capture. */
export async function runCommand(
  command: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await runSelfImproveProcess(command, cwd, timeoutMs)
    return { ok: result.code === 0, output: result.stdout + result.stderr }
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
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
