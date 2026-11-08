/**
 * Self-improvement configuration — leaf module with minimal imports so any
 * entry point (CLI startup, commands, tests) can read the resolved config
 * without dragging in the agent/tool chain.
 *
 * Settings schema lives in src/utils/settings/types.ts (`selfImprove`).
 */

import { getInitialSettings } from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

export const DEFAULT_REPO_URL = 'https://github.com/xuda1979/future-code'
export const DEFAULT_INTERVAL_MINUTES = 45
export const DEFAULT_MAX_CONCURRENT_CYCLES = 1

/**
 * Env var set on every self-improvement child process so nested sessions
 * never recurse into starting their own improvement cycles.
 */
export const SELF_IMPROVE_MARKER_ENV = 'FUTURE_SELF_IMPROVE_ACTIVE'

export type SelfImproveConfig = {
  enabled: boolean
  intervalMinutes: number
  repoUrl: string
  autoMerge: boolean
  autoPush: boolean
  maxConcurrentCycles: number
}

type SelfImproveSettingsBlock = NonNullable<SettingsJson['selfImprove']>

/**
 * Resolve the effective self-improvement configuration from merged user
 * settings, applying defaults for anything unset. Pure function of its
 * input so it is trivially testable.
 */
export function resolveSelfImproveConfig(
  settings: SelfImproveSettingsBlock | undefined,
): SelfImproveConfig {
  const s = settings ?? {}
  return {
    enabled: s.enabled ?? false,
    intervalMinutes: s.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    repoUrl: s.repoUrl ?? DEFAULT_REPO_URL,
    autoMerge: s.autoMerge ?? false,
    autoPush: s.autoPush ?? false,
    maxConcurrentCycles:
      s.maxConcurrentCycles ?? DEFAULT_MAX_CONCURRENT_CYCLES,
  }
}

/** Read the resolved config for the current session (settings-backed). */
export function getSelfImproveConfig(): SelfImproveConfig {
  return resolveSelfImproveConfig(getInitialSettings().selfImprove)
}
