import test from 'node:test'
import assert from 'node:assert/strict'
import { workingContextThreshold } from '../../src/services/compact/workingContextPolicy.ts'

test('long goals compact at the operating target before the provider window fills', () => {
  assert.equal(workingContextThreshold(167_000, true, undefined), 64_000)
  assert.equal(workingContextThreshold(167_000, false, undefined), 167_000)
  assert.equal(workingContextThreshold(24_000, true, '64000'), 24_000)
})
test('operator targets never enlarge a provider limit, invalid values use the default', () => {
  assert.equal(workingContextThreshold(167_000, true, '32000'), 32_000)
  assert.equal(workingContextThreshold(167_000, true, '1000000'), 167_000)
  for (const value of ['0', '-1', 'NaN', 'Infinity', '5000']) assert.equal(workingContextThreshold(167_000, true, value), 64_000)
})
