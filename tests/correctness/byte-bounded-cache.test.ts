import test from 'node:test'
import assert from 'node:assert/strict'
import { ByteBoundedCache, estimateGraphBytes } from '../../src/utils/byteBoundedCache.ts'

test('byte eviction preserves the recently used working set', () => {
  const cache = new ByteBoundedCache<string>(10, 700, s => s.length * 2)
  cache.set('a', 'a'.repeat(30))
  cache.set('b', 'b'.repeat(30))
  assert.equal(cache.get('a'), 'a'.repeat(30))
  cache.set('c', 'c'.repeat(30))
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 'a'.repeat(30))
  assert.equal(cache.get('c'), 'c'.repeat(30))
  assert.equal(cache.size, 2)
  assert.equal(cache.calculatedBytes, 508)
})

test('entry eviction uses LRU and never clears the entire cache', () => {
  const cache = new ByteBoundedCache<number>(2, 1024, () => 8)
  cache.set('a', 0)
  cache.set('b', 1)
  assert.equal(cache.get('a'), 0)
  cache.set('c', 2)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 0)
  assert.equal(cache.get('c'), 2)
})

test('replacement, oversized values and clear maintain exact charge accounting', () => {
  const cache = new ByteBoundedCache<string>(3, 600, s => s.length * 2)
  cache.set('a', 'small')
  cache.set('b', 'small')
  cache.set('a', 'x'.repeat(100))
  assert.equal(cache.calculatedBytes, 598)
  cache.set('huge', 'x'.repeat(1000))
  assert.equal(cache.size, 2, 'A one-off oversized value must not evict hot entries')
  cache.set('a', 'x'.repeat(1000))
  assert.equal(cache.get('a'), undefined, 'A replacement must not leave stale data')
  assert.equal(cache.get('b'), 'small')
  assert.equal(cache.calculatedBytes, 204)
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(cache.calculatedBytes, 0)
})

test('empty keys, Unicode and lone surrogates survive lossless key copies', () => {
  const cache = new ByteBoundedCache<number>(4, 2000, () => 8)
  for (const key of ['', '中文👩‍🔬', '\ud800', '\udc00']) cache.set(key, key.length)
  for (const key of ['', '中文👩‍🔬', '\ud800', '\udc00']) assert.equal(cache.get(key), key.length)
  cache.set('extra', 9)
  assert.equal(cache.get(''), undefined)
  assert.ok(cache.calculatedBytes <= cache.maxBytes)
})

test('invalid charges and invalid limits cannot disable the memory bound', () => {
  for (const charge of [-1, NaN, Infinity, 1.5]) {
    const cache = new ByteBoundedCache<number>(1, 1024, () => charge)
    cache.set('key', 1)
    assert.equal(cache.size, 0)
    assert.equal(cache.calculatedBytes, 0)
  }
  for (const bad of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => new ByteBoundedCache(bad, 1024, () => 1), RangeError)
    assert.throws(() => new ByteBoundedCache(1, bad, () => 1), RangeError)
  }
})

test('nested token graphs, custom array fields, sharing and cycles are charged safely', () => {
  const token = { raw: 'x'.repeat(1000), tokens: [{ text: '中文' }] }
  const shared = [token, token]
  const distinct = [token, { raw: token.raw, tokens: [{ text: '中文' }] }]
  assert.ok(estimateGraphBytes(shared, 10000) < estimateGraphBytes(distinct, 10000))
  assert.ok(estimateGraphBytes({ raw: 'x'.repeat(10000) }, 100) > 100)
  const cycle: any = { token }
  cycle.self = cycle
  assert.ok(estimateGraphBytes(cycle, 10000) < 10000)
  const tokens: any = []
  tokens.links = { ref: { href: 'x'.repeat(2000) } }
  assert.ok(estimateGraphBytes(tokens, 10000) > 4000)
})

test('long mixed promotion/replacement sequences agree with an independent Map LRU', () => {
  const cache = new ByteBoundedCache<number>(7, 2000, () => 8)
  const reference = new Map<string, number>()
  for (let i = 0; i < 4000; i++) {
    const key = String((i * 17 + Math.floor(i / 7)) % 23)
    if (i % 3) {
      const expected = reference.get(key)
      if (reference.has(key)) { reference.delete(key); reference.set(key, expected!) }
      assert.equal(cache.get(key), expected)
    } else {
      reference.delete(key)
      reference.set(key, i)
      while (reference.size > 7) reference.delete(reference.keys().next().value!)
      cache.set(key, i)
    }
    assert.equal(cache.size, reference.size)
    assert.ok(cache.calculatedBytes <= cache.maxBytes)
    if (i % 227 === 0) { cache.clear(); reference.clear() }
  }
})
