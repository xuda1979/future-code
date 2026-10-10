import { useEffect, useRef } from 'react'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../utils/messageQueueManager.js'
import type { QueryGuard } from '../utils/QueryGuard.js'
import { processQueueIfReady } from '../utils/queueProcessor.js'
import { startQueueWakeup, hasMainThreadQueuedCommand } from '../utils/queueWakeup.js'
import { logError } from '../utils/log.js'

type UseQueueProcessorParams = {
  executeQueuedInput: (commands: QueuedCommand[]) => Promise<void>
  hasActiveLocalJsxUI: boolean
  queryGuard: QueryGuard
}

/**
 * Hook that processes queued commands when conditions are met.
 *
 * Uses a single unified command queue (module-level store). Priority determines
 * processing order: 'now' > 'next' (user input) > 'later' (task notifications).
 * The dequeue() function handles priority ordering automatically.
 *
 * Processing triggers when:
 * - No query active (direct queryGuard subscription)
 * - Queue has items
 * - No active local JSX UI blocking input
 */
export function useQueueProcessor({
  executeQueuedInput,
  hasActiveLocalJsxUI,
  queryGuard,
}: UseQueueProcessorParams): void {
  const latest = useRef({ executeQueuedInput, hasActiveLocalJsxUI })
  latest.current = { executeQueuedInput, hasActiveLocalJsxUI }
  const wakeup = useRef<ReturnType<typeof startQueueWakeup> | null>(null)
  useEffect(() => {
    const pump = startQueueWakeup({
      isReady: () => !queryGuard.isActive && !latest.current.hasActiveLocalJsxUI &&
        hasMainThreadQueuedCommand(getCommandQueueSnapshot()),
      process: () => {
        let completion: Promise<void> | undefined
        processQueueIfReady({ executeInput: commands => {
          completion = latest.current.executeQueuedInput(commands)
          return completion
        } })
        return completion
      },
      subscribe: [queryGuard.subscribe, subscribeToCommandQueue],
      onError: logError,
    })
    wakeup.current = pump
    return () => { pump.stop(); if (wakeup.current === pump) wakeup.current = null }
  }, [queryGuard])
  useEffect(() => { wakeup.current?.wake() }, [hasActiveLocalJsxUI, executeQueuedInput])
}

