/**
 * HTTP utility constants and helpers
 */

import axios from 'axios'
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import {
  getFutureApiKey,
  getFutureAIOAuthTokens,
  handleOAuth401Error,
  isFutureAISubscriber,
} from './auth.js'
import { getFutureCodeUserAgent } from './userAgent.js'
import { getWorkload } from './workloadContext.js'

// WARNING: We rely on `future-cli` in the user agent for log filtering.
// Please do NOT change this without making sure that logging also gets updated!
export function getUserAgent(): string {
  const agentSdkVersion = process.env.FUTURE_AGENT_SDK_VERSION
    ? `, agent-sdk/${process.env.FUTURE_AGENT_SDK_VERSION}`
    : ''
  // SDK consumers can identify their app/library via FUTURE_AGENT_SDK_CLIENT_APP
  // e.g., "my-app/1.0.0" or "my-library/2.1"
  const clientApp = process.env.FUTURE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.FUTURE_AGENT_SDK_CLIENT_APP}`
    : ''
  // Turn-/process-scoped workload tag for cron-initiated requests. 1P-only
  // observability — proxies strip HTTP headers; QoS routing uses cc_workload
  // in the billing-header attribution block instead (see constants/system.ts).
  // getFutureClient (client.ts:98) calls this per-request inside withRetry,
  // so the read picks up the same setWorkload() value as getAttributionHeader.
  const workload = getWorkload()
  const workloadSuffix = workload ? `, workload/${workload}` : ''
  return `future-cli/${MACRO.VERSION} (${process.env.USER_TYPE}, ${process.env.FUTURE_CODE_ENTRYPOINT ?? 'cli'}${agentSdkVersion}${clientApp}${workloadSuffix})`
}

export function getMCPUserAgent(): string {
  const parts: string[] = []
  if (process.env.FUTURE_CODE_ENTRYPOINT) {
    parts.push(process.env.FUTURE_CODE_ENTRYPOINT)
  }
  if (process.env.FUTURE_AGENT_SDK_VERSION) {
    parts.push(`agent-sdk/${process.env.FUTURE_AGENT_SDK_VERSION}`)
  }
  if (process.env.FUTURE_AGENT_SDK_CLIENT_APP) {
    parts.push(`client-app/${process.env.FUTURE_AGENT_SDK_CLIENT_APP}`)
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `future-code/${MACRO.VERSION}${suffix}`
}

// User-Agent for WebFetch requests to arbitrary sites. `Future-User` is
// Future's publicly documented agent for user-initiated fetches (what site
// operators match in robots.txt); the future-code suffix lets them distinguish
// local CLI traffic from future.ai server-side fetches.
export function getWebFetchUserAgent(): string {
  return `Future-User (${getFutureCodeUserAgent()}; +https://support.future.com/)`
}

export type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}

/**
 * Get authentication headers for API requests
 * Returns either OAuth headers for Max/Pro users or API key headers for regular users
 */
export function getAuthHeaders(): AuthHeaders {
  if (isFutureAISubscriber()) {
    const oauthTokens = getFutureAIOAuthTokens()
    if (!oauthTokens?.accessToken) {
      return {
        headers: {},
        error: 'No OAuth token available',
      }
    }
    return {
      headers: {
        Authorization: `Bearer ${oauthTokens.accessToken}`,
        'future-beta': OAUTH_BETA_HEADER,
      },
    }
  }
  // TODO: this will fail if the API key is being set to an LLM Gateway key
  // should we try to query keychain / credentials for a valid Future key?
  const apiKey = getFutureApiKey()
  if (!apiKey) {
    return {
      headers: {},
      error: 'No API key available',
    }
  }
  return {
    headers: {
      'x-api-key': apiKey,
    },
  }
}

/**
 * Wrapper that handles OAuth 401 errors by force-refreshing the token and
 * retrying once. Addresses clock drift scenarios where the local expiration
 * check disagrees with the server.
 *
 * The request closure is called again on retry, so it should re-read auth
 * (e.g., via getAuthHeaders()) to pick up the refreshed token.
 *
 * Note: bridgeApi.ts has its own DI-injected version — handleOAuth401Error
 * transitively pulls in config.ts (~1300 modules), which breaks the SDK bundle.
 *
 * @param opts.also403Revoked - Also retry on 403 with "OAuth token has been
 *   revoked" body (some endpoints signal revocation this way instead of 401).
 */
export async function withOAuth401Retry<T>(
  request: () => Promise<T>,
  opts?: { also403Revoked?: boolean },
): Promise<T> {
  try {
    return await request()
  } catch (err) {
    if (!axios.isAxiosError(err)) throw err
    const status = err.response?.status
    const isAuthError =
      status === 401 ||
      (opts?.also403Revoked &&
        status === 403 &&
        typeof err.response?.data === 'string' &&
        err.response.data.includes('OAuth token has been revoked'))
    if (!isAuthError) throw err
    const failedAccessToken = getFutureAIOAuthTokens()?.accessToken
    if (!failedAccessToken) throw err
    await handleOAuth401Error(failedAccessToken)
    return await request()
  }
}
