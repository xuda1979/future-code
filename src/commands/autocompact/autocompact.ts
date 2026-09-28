/**
 * /autocompact — control when auto-compact triggers.
 *
 * - `/autocompact` or `status` — show current setting and threshold
 * - `/autocompact on|off` — persist autoCompactEnabled in global config
 *   (same key the config UI writes)
 * - `/autocompact <percent>` — session-scoped override: sets
 *   FUTURE_AUTOCOMPACT_PCT_OVERRIDE, which getAutoCompactThreshold() reads
 *   live, capping compaction at `percent`% of the context window
 *
 * Arg parsing lives in the dependency-free ./autocompact-logic.ts.
 */

import {
  getAutoCompactThreshold,
  isAutoCompactEnabled,
} from '../../services/compact/autoCompact.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { parseAutocompactArgs } from './autocompact-logic.js'

function statusMessage(): string {
  const model = getMainLoopModel()
  const threshold = getAutoCompactThreshold(model)
  const pctOverride = process.env.FUTURE_AUTOCOMPACT_PCT_OVERRIDE
  const lines = [
    `Auto-compact: ${isAutoCompactEnabled() ? 'on' : 'off'} (setting: ${getGlobalConfig().autoCompactEnabled ? 'on' : 'off'})`,
    `Compact threshold: ~${threshold.toLocaleString()} tokens for ${model}`,
  ]
  if (pctOverride) {
    lines.push(`Session override active: ${pctOverride}% of context window`)
  }
  lines.push(
    'Usage: /autocompact on|off — toggle the setting; /autocompact <percent> — session-scoped threshold.',
  )
  return lines.join('\n')
}

export const call: LocalCommandCall = async args => {
  const action = parseAutocompactArgs(args)

  switch (action.kind) {
    case 'status':
      return { type: 'text', value: statusMessage() }

    case 'set-enabled':
      saveGlobalConfig(config => ({
        ...config,
        autoCompactEnabled: action.enabled,
      }))
      return {
        type: 'text',
        value: `Auto-compact ${action.enabled ? 'enabled' : 'disabled'} in your global config.`,
      }

    case 'set-percent':
      process.env.FUTURE_AUTOCOMPACT_PCT_OVERRIDE = String(action.percent)
      return {
        type: 'text',
        value: `Auto-compact will trigger at ~${action.percent}% of the context window for this session. This does not change your saved settings.`,
      }

    case 'error':
      return { type: 'text', value: action.message }
  }
}
