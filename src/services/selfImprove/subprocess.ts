/**
 * Subprocess helpers for the self-improvement cycle.
 *
 * runHeadlessFuture spawns `future-code --print` (this binary, or
 * process.argv[1] in dev mode) against a working directory with a prompt,
 * returning the assistant's final text. The child is marked with
 * FUTURE_SELF_IMPROVE_ACTIVE so nested sessions never recurse into
 * starting their own improvement cycles.
 */

import { spawn, spawnSync } from 'node:child_process'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { SELF_IMPROVE_MARKER_ENV } from './config.js'

/** Command to invoke a fresh headless future-code session. */
export function headlessFutureCommand(): string {
  if (process.env.FUTURE_SELF_IMPROVE_COMMAND) {
    return process.env.FUTURE_SELF_IMPROVE_COMMAND
  }
  return isInBundledMode() ? process.execPath : process.argv[1]!
}

export type HeadlessResult = {
  ok: boolean
  text: string
  error?: string
}

/** Run one headless future-code session and return its final text. */
export function runHeadlessFuture(
  prompt: string,
  cwd: string,
  timeoutMs: number = 20 * 60_000,
  maxPromptBytes: number = 100_000,
): Promise<string> {
  const command = headlessFutureCommand()
  const args = [
    '--print',
    '--output-format',
    'text',
    prompt.slice(0, maxPromptBytes),
  ]
  return new Promise<string>(resolve => {
    let output = ''
    let settled = false
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        [SELF_IMPROVE_MARKER_ENV]: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        resolve(output || '')
      }
    }, timeoutMs)
    child.stdout?.on('data', chunk => {
      output += String(chunk)
      if (output.length > 400_000) output = output.slice(-200_000)
    })
    child.stderr?.on('data', chunk => {
      // Keep stderr for diagnostics but never let it dominate.
      output += String(chunk)
      if (output.length > 400_000) output = output.slice(-200_000)
    })
    child.on('error', error => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve('')
      }
      void error
    })
    child.on('close', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(output.trim())
      }
    })
  })
}

/** Synchronous git helper that never throws. Returns trimmed stdout. */
export function execGitQuiet(
  args: string[],
  cwd: string,
): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return {
      ok: result.status === 0,
      stdout: (result.stdout as string) ?? '',
      stderr: (result.stderr as string) ?? '',
    }
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error) }
  }
}
