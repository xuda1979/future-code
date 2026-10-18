import test from 'node:test'
import assert from 'node:assert/strict'
import { isProviderTransportError, isTransientProviderStatus, parseProviderRetryAfter } from '../../src/utils/providerRetryPolicy.ts'

test('provider outages include gateway disconnects but exclude credential and configuration failures', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529, 599])
    assert.equal(isTransientProviderStatus(status), true, String(status))
  for (const status of [undefined, 200, 400, 401, 403, 404, 501, 505])
    assert.equal(isTransientProviderStatus(status), false, String(status))
})

test('transport classification covers direct errno, nested causes, undici body timeouts and cycles', () => {
  for (const code of ['ENETUNREACH', 'ECONNRESET', 'EHOSTUNREACH', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
    const cause = Object.assign(new Error('transport'), { code })
    assert.equal(isProviderTransportError(cause), true)
    assert.equal(isProviderTransportError(new Error('wrapped', { cause: new Error('again', { cause }) })), true)
  }
  assert.equal(isProviderTransportError(new TypeError('fetch failed')), true)
  const cycle: any = new Error('cycle'); cycle.cause = cycle
  for (const error of [cycle, null, 'fetch failed', new SyntaxError('JSON'), new Error('network design'),
    new DOMException('cancel', 'AbortError'), new TypeError('invalid input')])
    assert.equal(isProviderTransportError(error), false)
})

test('Retry-After parsing preserves fractional seconds and dates without accepting partial numeric text', () => {
  const now = Date.UTC(2026, 0, 1)
  assert.equal(parseProviderRetryAfter('0.125', now), 125)
  assert.equal(parseProviderRetryAfter(' 1.5 ', now), 1500)
  assert.equal(parseProviderRetryAfter(new Date(now + 60000).toUTCString(), now), 60000)
  assert.equal(parseProviderRetryAfter('999999999999', now, 21600000), 21600000)
  for (const value of [null, '', '-1', '1second', '10junk', '1e6', 'Infinity', 'NaN', 'garbage'])
    assert.equal(parseProviderRetryAfter(value, now), null, String(value))
})
