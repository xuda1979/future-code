/** Dependency-free policy shared by the terminal API client and Swarm. */
export function isTransientProviderStatus(status: number | undefined): boolean {
  return status !== undefined && ([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529, 599].includes(status))
}

const transportCodes = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED',
  'ETIMEDOUT', 'EPIPE', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
])

/** Walk a bounded cause chain, including direct errno objects. A generic
 * AbortError, malformed response, or syntax error is not an outage. */
export function isProviderTransportError(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current = error as { name?: string; code?: string; message?: string; cause?: unknown } | null
  for (let depth = 0; current && typeof current === 'object' && depth < 8 && !seen.has(current); depth++) {
    seen.add(current)
    if (['TimeoutError', 'APIConnectionError', 'APIConnectionTimeoutError'].includes(current.name ?? '') ||
      transportCodes.has(current.code ?? '') ||
      (current instanceof TypeError && /fetch failed|network|connection/i.test(current.message))) return true
    current = current.cause as typeof current
  }
  return false
}

/** Retry-After is delta-seconds (including fractions) or an HTTP date. Reject
 * malformed/negative advice and cap valid values before creating any timer. */
export function parseProviderRetryAfter(value: string | null, now = Date.now(), maxWaitMs = 86_400_000): number | null {
  if (!value?.trim()) return null
  const text = value.trim()
  const ms = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 :
    /^[A-Za-z]/.test(text) ? Date.parse(text) - now : NaN
  return Number.isFinite(ms) && ms >= 0 ? Math.min(maxWaitMs, Math.ceil(ms)) : null
}
