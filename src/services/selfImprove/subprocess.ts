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
export async function runHeadlessFuture(
  prompt: string,
  cwd: string,
  timeoutMs: number = 20 * 60_000,
  maxPromptBytes: number = 100_000,
): Promise<string> {
  if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes <= 0) throw new Error('Invalid self-improvement prompt byte budget');
  if (Buffer.byteLength(prompt) > maxPromptBytes) throw new Error('Self-improvement prompt exceeds its byte budget');
  const command = headlessFutureCommand()
  const args = [
    '--print',
    '--output-format',
    'text',
    prompt,
  ]
  const result = await runSelfImproveProcess([command, ...args], cwd, timeoutMs, 400_000)
  if (result.code !== 0) throw new Error(`Headless session exit ${result.code}: ${result.stderr.slice(-1000)}`)
  return result.stdout.trim()
}

/** Bounded capture with separate stdout/stderr. Wait for group shutdown before
 * returning; otherwise timed-out children can still edit a replacement tree. */
export function runSelfImproveProcess(argv: string[], cwd: string, timeoutMs: number, maxBytes = 200_000):
Promise<{ code: number; stdout: string; stderr: string }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    return Promise.reject(new Error('Invalid self-improvement process budget'))
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, shell: false, detached: process.platform !== 'win32',
      env: { ...process.env, [SELF_IMPROVE_MARKER_ENV]: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let bytes = 0, failure: Error | null = null
    const kill = () => {
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* child may have exited */ }
      }
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => { failure ??= new Error('Self-improvement process deadline exceeded'); kill() }, timeoutMs)
    const collect = (chunk: Buffer, target: Buffer[]) => {
      bytes += chunk.length
      if (bytes > maxBytes) { failure ??= new Error('Self-improvement process output exceeded byte budget'); kill() }
      else target.push(Buffer.from(chunk))
    }
    child.stdout?.on('data', chunk => collect(chunk, stdout))
    child.stderr?.on('data', chunk => collect(chunk, stderr))
    child.on('error', error => { failure ??= error })
    child.on('exit', () => { if (process.platform !== 'win32') kill() })
    child.on('close', code => {
      // Also stop descendants that inherited pipes or outlived the leader.
      clearTimeout(timer)
      if (failure) return reject(failure)
      if (!Number.isInteger(code)) return reject(new Error('Self-improvement process exited without a status'))
      resolve({ code: code!, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
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
