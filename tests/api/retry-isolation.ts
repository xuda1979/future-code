/** Preload ONLY for retry-resilience.test.ts. Exercise the real retry loop and
 * SDK errors without loading terminal/auth/telemetry subsystems. Sleeps advance
 * logically; real watchdog timers are tested by the Node correctness suite.
 * bun test --preload ./tests/api/retry-isolation.ts ./tests/api/retry-resilience.test.ts
 */
import { mock } from 'bun:test'
const noop = () => {}
const stub = (path: string, exports: Record<string, unknown>) =>
  mock.module(new URL(`../../src/${path}.ts`, import.meta.url).pathname, () => exports)
mock.module('bun:bundle', () => ({ feature: () => false }))
stub('utils/aws', { isAwsCredentialsProviderError: () => false })
stub('utils/debug', { logForDebugging: noop })
stub('utils/log', { logError: noop })
stub('utils/messages', {
  createSystemAPIErrorMessage: (error: Error, retryInMs: number, retryAttempt: number, maxRetries: number) =>
    ({ type: 'system', subtype: 'api_error', error, retryInMs, retryAttempt, maxRetries }),
})
stub('utils/model/providers', { getAPIProviderForStatsig: () => 'test' })
stub('utils/auth', {
  clearApiKeyHelperCache: noop, clearAwsCredentialsCache: noop, clearGcpCredentialsCache: noop,
  getFutureAIOAuthTokens: () => null, handleOAuth401Error: noop,
  isFutureAISubscriber: () => false, isEnterpriseSubscriber: () => false,
})
stub('utils/envUtils', { isEnvTruthy: (value?: string) => ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '') })
stub('utils/errors', { errorMessage: (value: unknown) => value instanceof Error ? value.message : String(value) })
stub('utils/fastMode', {
  handleFastModeOverageRejection: noop, handleFastModeRejectedByAPI: noop,
  isFastModeCooldown: () => false, isFastModeEnabled: () => false, triggerFastModeCooldown: noop,
})
stub('utils/model/model', { isNonCustomOpusModel: () => false })
stub('utils/proxy', { disableKeepAlive: noop })
stub('utils/sleep', { sleep: async (_ms: number, signal?: AbortSignal, opts?: { abortError?: () => Error }) => {
  await Promise.resolve()
  if (signal?.aborted) throw opts?.abortError?.() ?? signal.reason
} })
stub('services/analytics/growthbook', { getFeatureValue_CACHED_MAY_BE_STALE: (_name: string, fallback: unknown) => fallback })
stub('services/analytics/index', { logEvent: noop })
stub('services/rateLimitMocking', { checkMockRateLimitError: () => null, isMockRateLimitError: () => false })
stub('services/api/errors', { REPEATED_529_ERROR_MESSAGE: 'overloaded' })
stub('services/api/errorUtils', { extractConnectionErrorDetails: (error: { cause?: { code?: string } }) => error?.cause })
