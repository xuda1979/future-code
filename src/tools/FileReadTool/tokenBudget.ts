// Local file reads must not inherit the inference client's ten-minute timeout.
// The byte bound is conservative for content under the byte-token encodings
// used by supported providers; it is not a model-exact token count.
export const FILE_READ_TOKEN_COUNT_TIMEOUT_MS = 1000

type Counter = (
  content: string,
  options: { signal: AbortSignal },
) => Promise<number | null>

/** Return an exact count when available, otherwise a conservative content bound.
 * The deadline includes client initialization. Late completions are observed but
 * cannot replace the chosen result. A caller cancellation remains cancellation.
 */
export async function countFileReadTokens(
  content: string,
  maxTokens: number,
  countTokens: Counter,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted()
  const byteBound = Buffer.byteLength(content, 'utf8')
  if (byteBound <= maxTokens) return byteBound

  const controller = new AbortController()
  return new Promise<number>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (count: number) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(count)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      controller.abort(signal?.reason)
      reject(signal?.reason ?? new Error('File read cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      controller.abort(new Error('File-read token count deadline reached'))
      finish(byteBound)
    }, FILE_READ_TOKEN_COUNT_TIMEOUT_MS)

    // A handler observes both late resolutions and rejections, including a
    // counter that ignores cancellation or throws before returning a promise.
    void Promise.resolve().then(() => controller.signal.aborted
      ? null
      : countTokens(content, { signal: controller.signal }),
    ).then(count => {
      finish(typeof count === 'number' && Number.isSafeInteger(count) && count > 0
        ? count
        : byteBound)
    }, () => finish(byteBound))
  })
}
