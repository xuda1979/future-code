export const MODEL_VALIDATION_TIMEOUT_MS = 10_000

/** Bound the entire operation, including client/auth initialization. Some
 * helpers ignore AbortSignal; racing also prevents their late success. */
export async function withModelValidationDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = MODEL_VALIDATION_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  try {
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => {
        controller.abort()
        reject(new Error('Model validation cancelled. The current model was kept.'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); return }
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Model validation timed out. The current model was kept; check the endpoint and try again.'))
      }, timeoutMs)
    })
    // Do not start work for an already-cancelled command.
    return await Promise.race([stopped, signal?.aborted ? stopped : Promise.resolve().then(() => run(controller.signal))])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
