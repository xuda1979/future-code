import test from 'node:test'
import assert from 'node:assert/strict'
import { readRangeCovers } from '../../src/utils/readRangeCoverage.ts'

/**
 * Behavioral test for the pure coverage predicate behind Read dedup.
 * Dependency-free so the offline correctness gate can run it under
 * node --experimental-strip-types (same convention as reblock-guard.test.ts).
 *
 * Semantics under test (see src/utils/readRangeCoverage.ts header for the
 * invariant proofs):
 *   - cached [o, o+l) covers requested [O, O+L) iff O >= o (normalized) and
 *     O+L <= o+l (Infinity when the cached read was uncapped).
 */

test('exact same range is covered', () => {
  assert.equal(
    readRangeCovers({ offset: 1, limit: 50 }, { offset: 1, limit: 50 }),
    true,
  )
})

test('smaller limit at the same start is covered', () => {
  assert.equal(
    readRangeCovers({ offset: 1, limit: 50 }, { offset: 1, limit: 10 }),
    true,
  )
})

test('strict inner subrange is covered', () => {
  assert.equal(
    readRangeCovers({ offset: 10, limit: 100 }, { offset: 50, limit: 20 }),
    true,
  )
})

test('request starting before the cached range is not covered', () => {
  assert.equal(
    readRangeCovers({ offset: 10, limit: 100 }, { offset: 5, limit: 10 }),
    false,
  )
})

test('request extending past a capped end is not covered', () => {
  assert.equal(
    readRangeCovers({ offset: 1, limit: 50 }, { offset: 1, limit: 51 }),
    false,
  )
  assert.equal(
    readRangeCovers({ offset: 10, limit: 100 }, { offset: 105, limit: 10 }),
    false,
  )
})

test('uncapped cached read covers any later subrange', () => {
  assert.equal(
    readRangeCovers(
      { offset: 1, limit: undefined },
      { offset: 500, limit: 2000 },
    ),
    true,
  )
  assert.equal(
    readRangeCovers(
      { offset: 1, limit: undefined },
      { offset: 1, limit: undefined },
    ),
    true,
  )
})

test('uncapped cached read does not cover an earlier start', () => {
  assert.equal(
    readRangeCovers({ offset: 10, limit: undefined }, { offset: 1, limit: 5 }),
    false,
  )
})

test('capped cached read never covers an uncapped request', () => {
  assert.equal(
    readRangeCovers({ offset: 1, limit: 5000 }, { offset: 1, limit: undefined }),
    false,
  )
})

test('offsets 0 and 1 normalize to the same start', () => {
  assert.equal(
    readRangeCovers({ offset: 0, limit: 50 }, { offset: 1, limit: 50 }),
    true,
  )
  assert.equal(
    readRangeCovers({ offset: 1, limit: 50 }, { offset: 0, limit: 50 }),
    true,
  )
  assert.equal(
    readRangeCovers({ offset: 0, limit: 50 }, { offset: 2, limit: 49 }),
    true,
  )
})

test('zero-limit edge cases stay conservative', () => {
  assert.equal(
    readRangeCovers({ offset: 5, limit: 0 }, { offset: 5, limit: 0 }),
    true,
  )
  assert.equal(
    readRangeCovers({ offset: 5, limit: 0 }, { offset: 5, limit: 1 }),
    false,
  )
  // Empty request past the cached end is conservatively not covered — a
  // missed micro-dedup, never a wrong stub.
  assert.equal(
    readRangeCovers({ offset: 1, limit: 50 }, { offset: 100, limit: 0 }),
    false,
  )
})
