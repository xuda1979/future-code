import type { Command } from '../../commands.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * /sessions — cross-project session health monitor.
 *
 * Surfaces what the 2026-11-06 RSI loop had to assemble by hand: which
 * projects have live sessions, how stale they are, which carry an ACTIVE
 * autonomous goal with no recent activity (wedged continuation), and which
 * stores have grown unboundedly. `--json` emits the raw scan for tooling.
 */
const sessions: Command = {
  type: 'prompt',
  name: 'sessions',
  description:
    'Show health of all Future Code sessions on this machine: activity age, size, goal state, stuck detection.',
  argumentHint: '[--json] [--all]',
  progressMessage: 'Scanning session store',
  source: 'builtin',
  async getPromptForCommand(args: string) {
    const flags = new Set(args.trim().split(/\s+/).filter(Boolean))
    if (flags.has('--help')) {
      return [
        {
          type: 'text' as const,
          text: 'Usage: /sessions [--json] [--all]\n\nScans every project in the session store and reports per-project session health: session count, transcript size, time since last activity, active goal and its state, plus flags for stale sessions, ACTIVE goals with no recent activity (possibly wedged autonomous continuations), and oversized stores. --json emits machine-readable output. --all includes projects with no recent activity (default keeps the report focused on the last 30 days).',
        },
      ]
    }

    const { scanProjectHealth, formatProjectHealthReport } = await import('./sessionsHealth.ts')
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
    const reports = scanProjectHealth(
      flags.has('--all')
        ? {}
        : { minLatestModifiedMs: Date.now() - thirtyDaysMs },
    )

    if (flags.has('--json')) {
      return [
        {
          type: 'text' as const,
          text: JSON.stringify(
            reports.map(({ project, flags: projectFlags }) => ({
              projectPath: project.projectPath,
              sessionCount: project.sessions.length,
              totalBytes: project.totalBytes,
              lastActiveMs: project.latestSession?.modifiedMs ?? null,
              activeGoal: project.activeGoal,
              goalState: project.goalState,
              goalRevision: project.goalRevision,
              goalContinuations: project.goalContinuations,
              flags: projectFlags,
            })),
            null,
            2,
          ),
        },
      ]
    }

    const body = formatProjectHealthReport(reports)
    const flagged = reports.filter(r => r.flags.length > 0)
    const summary = flagged.length
      ? `\n\n${flagged.length} project(s) flagged for attention. Investigate flagged ACTIVE goals first — autonomous continuations that stop making progress should be resumed with /goal --resume or superseded with a new /goal, and the session restarted.`
      : '\n\nNo projects flagged. All sessions with recent activity look healthy.'
    const authNote = describeAuthOutages()
    return [
      {
        type: 'text' as const,
        text: `${body}${summary}${authNote}\n\nUse /sessions --json for machine-readable output, /sessions --all to include dormant projects.`,
      },
    ]
  },
}

/**
 * Best-effort detection of headless-auth outages on this machine. When a
 * keeper-style watchdog has logged recent auth failures, headless sessions
 * (cron/launchd loops) cannot run even though interactive sessions work.
 */
function describeAuthOutages(): string {
  const candidates = [
    join(homedir(), 'software', 'quantum-gpt', 'logs', 'session_keeper.log'),
  ]
  for (const file of candidates) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // Only look at the tail; keeper logs can be tens of MB.
    const tail = raw.slice(-64 * 1024)
    const failures = tail.match(/auth FAILED/g)?.length ?? 0
    const lastFailure = tail.lastIndexOf('auth FAILED')
    if (failures >= 3 && lastFailure !== -1) {
      const context = tail
        .slice(lastFailure, lastFailure + 400)
        .split('\n')
        .slice(0, 4)
        .join(' | ')
      return `\n\n⚠ Headless-auth watchdog on this machine shows ${failures} recent auth probe failures (last: ${context.slice(0, 200)}). Headless/cron sessions are likely failing with "Not logged in" — check the upstream credential/quota before relying on scheduled loops.`
    }
  }
  return ''
}

export default sessions
