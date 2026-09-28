/**
 * /pause-memory — pause auto-memory for the rest of this session.
 *
 * Sets FUTURE_CODE_DISABLE_AUTO_MEMORY in-process; isAutoMemoryEnabled()
 * reads it live on every check (it is not memoized), so memory extraction
 * stops immediately. The decision logic lives in the dependency-free
 * ./pause-memory-logic.ts; this module is Bun-only glue.
 */

import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { applyPauseMemory } from './pause-memory-logic.js'

export const call: LocalCommandCall = async args => {
  const result = applyPauseMemory(
    args,
    getInitialSettings().autoMemoryEnabled === false,
    isEnvTruthy(process.env.FUTURE_CODE_DISABLE_AUTO_MEMORY),
  )

  if (result.disableAutoMemory === true) {
    process.env.FUTURE_CODE_DISABLE_AUTO_MEMORY = '1'
  } else if (result.disableAutoMemory === false) {
    delete process.env.FUTURE_CODE_DISABLE_AUTO_MEMORY
  }

  return { type: 'text', value: result.value }
}
