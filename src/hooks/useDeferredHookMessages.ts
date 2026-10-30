import { useCallback, useEffect, useRef } from 'react'
import type { HookResultMessage, Message } from '../types/message.js'
import { DeferredHookGate } from '../utils/foregroundPreparation.js'
import { logError } from '../utils/log.js'

/**
 * Manages deferred SessionStart hook messages so the REPL can render
 * immediately instead of blocking on hook execution (~500ms).
 *
 * Hook messages are injected asynchronously when the promise resolves.
 * Returns a callback that onSubmit should call before the first API
 * request to ensure the model always sees hook context.
 */
export function useDeferredHookMessages(
  pendingHookMessages: Promise<HookResultMessage[]> | undefined,
  setMessages: (action: React.SetStateAction<Message[]>) => void,
  onError: (error: unknown) => void = logError,
): (signal?: AbortSignal) => Promise<void> {
  const gateRef = useRef<DeferredHookGate<HookResultMessage> | null>(null)
  if (!gateRef.current) gateRef.current = new DeferredHookGate(pendingHookMessages)
  const gate = gateRef.current
  const publish = useCallback((msgs: HookResultMessage[]) => {
    setMessages(prev => [...msgs, ...prev])
  }, [setMessages])

  useEffect(() => {
    return gate.observe(publish, onError)
  }, [gate, publish, onError])

  return useCallback((signal?: AbortSignal) => gate.wait(publish, { signal }), [gate, publish])
}
