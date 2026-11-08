/**
 * Auth-failure transcript suppression (2026-11-08).
 *
 * Motivation (measured on this machine): headless/scheduled loops that invoke
 * `future-code -p` without valid credentials burned 44,000+ sessions over
 * four months — each run materialized a ~36KB transcript whose only content
 * was the synthetic "Not logged in" error (~1.6GB of junk, 37K files in one
 * projects dir, slowing session enumeration for legitimate resume).
 *
 * Behavior: when a NON-INTERACTIVE run's first and only assistant message is
 * a synthetic authentication_failed error (no real API traffic, no tool use),
 * the transcript adds no diagnostic value — the caller already receives the
 * error text on stdout and a non-zero exit code. In that case:
 *
 *   1. The session transcript file is deleted at cleanup time.
 *   2. One compact line is appended to ~/.future/auth-failures.jsonl
 *      ({ ts, cwd, sessionId }) so loop operators keep a cheap, single-file
 *      signal for "my scheduled runs cannot authenticate" without spawning
 *      36KB-per-minute garbage.
 *
 * Interactive sessions, and non-interactive runs with ANY real work (tool
 * use, non-auth errors, retried auth that later succeeded), are untouched:
 * the transcript only gets pruned when it is provably auth-fail-only.
 */

import { appendFileSync } from 'fs'
import { join } from 'path'
import { getFutureConfigHomeDir } from './envUtils.js'

let authFailureDetected = false
let authFailureRecorded = false

/**
 * Record that this process synthesized an authentication_failed assistant
 * message. Called from the API error path (single choke point in
 * getAssistantMessageFromError) so every auth failure is captured exactly
 * once regardless of which upstream produced the 401/403.
 */
export function markAuthFailureDetected(): void {
  authFailureDetected = true
}

/** Test hook: reset the marker state. */
export function resetAuthFailureSuppressionForTesting(): void {
  authFailureDetected = false
  authFailureRecorded = false
}

/** @internal exported for tests */
export function isAuthFailureDetected(): boolean {
  return authFailureDetected
}

/**
 * Append one line to ~/.future/auth-failures.jsonl. Best-effort: never throws
 * (a failure to log a failure must not crash shutdown). The file is pruned by
 * size — keep the last ~2000 lines so an ailing loop can't grow it unbounded
 * (that would recreate the original problem in a new file).
 */
function appendAuthFailureMarker(cwd: string, sessionId: string): void {
  try {
    const markerPath = join(getFutureConfigHomeDir(), 'auth-failures.jsonl')
    appendFileSync(
      markerPath,
      JSON.stringify({ ts: new Date().toISOString(), cwd, sessionId }) + '\n',
      { encoding: 'utf8' },
    )
  } catch {
    // Ignore — best effort only.
  }
}

/**
 * Decide whether this session's transcript is auth-fail-only junk and, if so,
 * prune it and write the compact marker.
 *
 * Conditions (ALL must hold — conservative by design):
 *  - auth failure was detected this run (markAuthFailureDetected fired)
 *  - the run was non-interactive (interactive sessions keep everything;
 *    their "Not logged in" banner is a UI event the user may want to inspect)
 *  - the transcript exists and contains no tool_use block and no assistant
 *    message that is NOT an API error message (i.e. no real work happened)
 *
 * Returns the transcript path if it was pruned, else undefined.
 */
export function pruneAuthFailOnlyTranscript(
  options: {
    isNonInteractive: boolean
    transcriptPath: string
    sessionId: string
    cwd: string
    readFile?: (p: string) => string
    unlink?: (p: string) => void
  },
): string | undefined {
  if (authFailureRecorded) return undefined
  if (!options.isNonInteractive) return undefined
  if (!authFailureDetected) return undefined
  authFailureRecorded = true

  const readFile = options.readFile ?? ((p: string) => require('fs').readFileSync(p, 'utf8'))
  const unlink = options.unlink ?? ((p: string) => require('fs').unlinkSync(p))

  let raw: string
  try {
    raw = readFile(options.transcriptPath)
  } catch {
    return undefined // No transcript (never materialized) — nothing to prune.
  }

  if (raw.includes('"tool_use"')) return undefined // Real work happened — keep.
  if (raw.includes('"type":"assistant"')) {
    // Any assistant entry that is NOT an API error means real model output.
    // Auth-fail-only transcripts carry isApiErrorMessage:true on every
    // assistant line.
    for (const line of raw.split('\n')) {
      if (!line.includes('"type":"assistant"')) continue
      if (!line.includes('"isApiErrorMessage":true')) return undefined
    }
  }

  try {
    unlink(options.transcriptPath)
  } catch {
    return undefined
  }
  appendAuthFailureMarker(options.cwd, options.sessionId)
  return options.transcriptPath
}
