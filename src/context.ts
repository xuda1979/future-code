import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import {
  getAdditionalDirectoriesForFutureMd,
  setCachedFutureMdContent,
} from './bootstrap/state.js'
import { getLocalISODate } from './constants/common.js'
import { getMemoryContextLine } from './utils/systemResources.js'
import {
  filterInjectedMemoryFiles,
  getFutureMds,
  getMemoryFiles,
} from './utils/futuremd.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { getCwd } from './utils/cwd.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { execFileNoThrowWithCwd } from './utils/execFileNoThrow.js'
import { ForegroundPreparationTimeoutError, waitForForegroundPreparation } from './utils/foregroundPreparation.js'
import { getBranch, getDefaultBranch, getIsGit, gitExe } from './utils/git.js'
import { shouldIncludeGitInstructions } from './utils/gitSettings.js'
import { logError } from './utils/log.js'
import { collectProjectDigest } from './utils/projectDigest.js'

const MAX_STATUS_CHARS = 2000
const STARTUP_GIT_TIMEOUT_MS = 1000
const MAX_STARTUP_GIT_OUTPUT_BYTES = 256 * 1024

// System prompt injection for cache breaking (ant-only, ephemeral debugging state)
let systemPromptInjection: string | null = null

export function getSystemPromptInjection(): string | null {
  return systemPromptInjection
}

export function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  // Clear context caches immediately when injection changes
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
}

export const getGitStatus = memoize(async (cwd = getCwd()): Promise<string | null> => {
  if (process.env.NODE_ENV === 'test') {
    // Avoid cycles in tests
    return null
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'git_status_started')

  // The Git snapshot is optional context. Bound the whole collection and
  // retain fast results when one query (e.g. the worktree scan) is slow.
  const controller = new AbortController()
  const snapshot: Partial<Record<'branch' | 'mainBranch' | 'status' | 'log' | 'userName', string>> = {}
  let isGit = false
  try {
    await waitForForegroundPreparation('startup Git snapshot', async () => {
      const detected = await getIsGit()
      if (controller.signal.aborted) return
      isGit = detected
      logForDiagnosticsNoPII('info', 'git_is_git_check_completed', {
        duration_ms: Date.now() - startTime,
        is_git: isGit,
      })
      if (!isGit) return

      const executable = gitExe()
      const git = async (args: string[]) => {
        const result = await execFileNoThrowWithCwd(executable, args, {
          cwd,
          abortSignal: controller.signal,
          timeout: STARTUP_GIT_TIMEOUT_MS,
          maxBuffer: MAX_STARTUP_GIT_OUTPUT_BYTES,
          preserveOutputOnError: false,
        })
        // The leading two columns of short status distinguish staged edits.
        return result.code === 0 ? result.stdout.trimEnd() : undefined
      }
      const keep = async (key: keyof typeof snapshot, result: Promise<string | undefined>) => {
        const value = await result
        if (!controller.signal.aborted && value !== undefined) snapshot[key] = value
      }
      await Promise.allSettled([
        keep('branch', getBranch()),
        keep('mainBranch', getDefaultBranch()),
        keep('status', git(['--no-optional-locks', 'status', '--short'])),
        keep('log', git(['--no-optional-locks', 'log', '--oneline', '-n', '5'])),
        keep('userName', git(['config', 'user.name'])),
      ])
    }, { timeoutMs: STARTUP_GIT_TIMEOUT_MS })
  } catch (error) {
    if (error instanceof ForegroundPreparationTimeoutError) {
      logForDiagnosticsNoPII('info', 'git_status_deadline_reached', { timeout_ms: STARTUP_GIT_TIMEOUT_MS })
    } else {
      logForDiagnosticsNoPII('error', 'git_status_failed', { duration_ms: Date.now() - startTime })
      logError(error)
    }
  } finally {
    controller.abort()
  }
  if (!isGit) {
    logForDiagnosticsNoPII('info', 'git_status_skipped_not_git', { duration_ms: Date.now() - startTime })
    return null
  }

  const { branch, mainBranch, status, log, userName } = snapshot
  const truncated = (status?.length ?? 0) > MAX_STATUS_CHARS
  let statusText = status ?? '(unavailable. Run git status --short when needed.)'
  if (status === '') statusText = '(clean)'
  if (truncated) {
    statusText = statusText.slice(0, MAX_STATUS_CHARS) + '\n... (truncated. Run git status --short for details.)'
  }
  logForDiagnosticsNoPII('info', 'git_status_completed', {
    duration_ms: Date.now() - startTime,
    truncated,
    status_available: status !== undefined,
  })
  return [
    'This Git snapshot was collected at the start of the conversation.',
    ...(branch ? [`Current branch: ${branch}`] : []),
    ...(mainBranch ? [`Main branch (you will usually use this for PRs): ${mainBranch}`] : []),
    ...(userName ? [`Git user: ${userName}`] : []),
    `Status:\n${statusText}`,
    ...(log ? [`Recent commits:\n${log}`] : []),
  ].join('\n\n')
})

/**
 * This context is prepended to each conversation, and cached for the duration of the conversation.
 */
export const getSystemContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const startTime = Date.now()
    const cwd = getCwd()
    logForDiagnosticsNoPII('info', 'system_context_started')

    // Skip git status in CCR (unnecessary overhead on resume) or when git instructions are disabled
    const gitStatus =
      isEnvTruthy(process.env.FUTURE_CODE_REMOTE) ||
      !shouldIncludeGitInstructions()
        ? null
        : await getGitStatus(cwd)

    // Include system prompt injection if set (for cache breaking, ant-only)
    const injection = feature('BREAK_CACHE_COMMAND')
      ? getSystemPromptInjection()
      : null

    // Session-start layout/manifest digest: lets the model act directly on
    // known paths instead of re-listing directories at turn one. Guards
    // (CCR, bare mode, killswitch, homedir) live in projectDigest.ts.
    const projectDigest = collectProjectDigest(cwd)

    logForDiagnosticsNoPII('info', 'system_context_completed', {
      duration_ms: Date.now() - startTime,
      has_git_status: gitStatus !== null,
      has_injection: injection !== null,
      has_project_digest: projectDigest !== null,
    })

    return {
      ...(gitStatus && { gitStatus }),
      ...(projectDigest && { projectDigest }),
      ...(feature('BREAK_CACHE_COMMAND') && injection
        ? {
            cacheBreaker: `[CACHE_BREAKER: ${injection}]`,
          }
        : {}),
    }
  },
)

/**
 * This context is prepended to each conversation, and cached for the duration of the conversation.
 */
export const getUserContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'user_context_started')

    // FUTURE_CODE_DISABLE_FUTURE_MDS: hard off, always.
    // --bare: skip auto-discovery (cwd walk), BUT honor explicit --add-dir.
    // --bare means "skip what I didn't ask for", not "ignore what I asked for".
    const shouldDisableFutureMd =
      isEnvTruthy(process.env.FUTURE_CODE_DISABLE_FUTURE_MDS) ||
      (isBareMode() && getAdditionalDirectoriesForFutureMd().length === 0)
    // Await the async I/O (readFile/readdir directory walk) so the event
    // loop yields naturally at the first fs.readFile.
    const futureMd = shouldDisableFutureMd
      ? null
      : getFutureMds(filterInjectedMemoryFiles(await getMemoryFiles()))
    // Cache for the auto-mode classifier (yoloClassifier.ts reads this
    // instead of importing futuremd.ts directly, which would create a
    // cycle through permissions/filesystem → permissions → yoloClassifier).
    setCachedFutureMdContent(futureMd || null)

    logForDiagnosticsNoPII('info', 'user_context_completed', {
      duration_ms: Date.now() - startTime,
      futuremd_length: futureMd?.length ?? 0,
      futuremd_disabled: Boolean(shouldDisableFutureMd),
    })

    // Memory-awareness: surface the host memory budget (RAM, GPU/NPU/HBM)
    // as conversation context so workloads are sized up front instead of
    // discovering the ceiling by OOM-crashing into it.
    const memoryContext = getMemoryContextLine()

    return {
      ...(futureMd && { futureMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
      ...(memoryContext && { memoryContext }),
    }
  },
)
