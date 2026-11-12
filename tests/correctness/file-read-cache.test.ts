import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

register('./file-read-cache-loader.mjs', import.meta.url)
const { fileReadCache: cache } = await import('../../src/utils/fileReadCache.ts')

function fixture(run: (f: {
  path: (name: string) => string
  reads: Map<string, number>
  write: (name: string, content: string | Buffer) => string
}) => void): void {
  const dir = fs.mkdtempSync(join(tmpdir(), 'file-read-cache-'))
  const reads = new Map<string, number>()
  const previous = (globalThis as any).__fileReadCacheTest
  ;(globalThis as any).__fileReadCacheTest = {
    encoding: (path: string) => path.endsWith('.utf16') ? 'utf16le' : 'utf8',
    fs: {
      statSync: fs.statSync,
      readFileSync: (path: string, options: any) => {
        reads.set(path, (reads.get(path) ?? 0) + 1)
        return fs.readFileSync(path, options)
      },
    },
  }
  cache.clear()
  try {
    run({
      path: name => join(dir, name),
      reads,
      write: (name, content) => {
        const path = join(dir, name)
        fs.writeFileSync(path, content)
        return path
      },
    })
  } finally {
    cache.clear()
    ;(globalThis as any).__fileReadCacheTest = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('cache retains a bounded byte budget across many large files', () => fixture(f => {
  const content = 'x'.repeat(512 * 1024)
  for (let i = 0; i < 40; i++) {
    assert.equal(cache.readFile(f.write(`large-${i}`, content)).content, content)
  }
  const stats = cache.getStats()
  assert.ok(stats.size < 40, 'byte limit must evict before the count limit')
  assert.equal(stats.maxBytes, 16 * 1024 * 1024)
  assert.ok(stats.retainedBytes <= stats.maxBytes)
  assert.ok(stats.retainedBytes >= content.length * 2, 'must exercise retained production cache data')
}))

test('oversized reads are complete and do not flush the small hot working set', () => fixture(f => {
  const hot = f.write('hot', 'frequently edited\r\n')
  const largeContent = '量'.repeat(9 * 1024 * 1024)
  const large = f.write('oversize', largeContent)
  assert.equal(cache.readFile(hot).content, 'frequently edited\n')
  const before = cache.getStats()
  assert.equal(cache.readFile(large).content, largeContent)
  assert.deepEqual(cache.getStats(), before)
  assert.equal(cache.readFile(large).content, largeContent)
  cache.readFile(hot)
  assert.equal(f.reads.get(large), 2)
  assert.equal(f.reads.get(hot), 1)
}))

test('hits refresh LRU order and avoid file reads', () => fixture(f => {
  const first = f.write('first', 'first')
  const second = f.write('second', 'second')
  cache.readFile(first)
  cache.readFile(second)
  for (let i = 2; i < 1000; i++) cache.readFile(f.write(`small-${i}`, `value-${i}`))
  assert.equal(cache.getStats().size, 1000)
  cache.readFile(first)
  cache.readFile(f.write('new', 'new'))
  assert.equal(cache.getStats().size, 1000)
  assert.ok(cache.getStats().entries.includes(first), 'hot first entry must survive eviction')
  assert.ok(!cache.getStats().entries.includes(second), 'least recently used entry must be evicted')
  cache.readFile(first)
  assert.equal(f.reads.get(first), 1)
}))

test('size, ctime and inode identity invalidate files even when mtime is unchanged', () => fixture(f => {
  const path = f.write('changing', 'one')
  // Pin timestamps explicitly rather than depending on the host filesystem's
  // clock resolution. File data and inode identity still come from real files.
  let ctime = 2000
  ;(globalThis as any).__fileReadCacheTest.fs.statSync = (p: string) => ({
    ...fs.statSync(p), mtimeMs: 1000, ctimeMs: ctime,
  })
  cache.readFile(path)
  fs.writeFileSync(path, 'a much longer value')
  assert.equal(cache.readFile(path).content, 'a much longer value')

  ctime++
  fs.writeFileSync(path, 'new same sized text')
  assert.equal(cache.readFile(path).content, 'new same sized text')

  const replacement = f.write('replacement', 'a different content')
  fs.renameSync(replacement, path)
  assert.equal(cache.readFile(path).content, 'a different content')
  assert.equal(f.reads.get(path), 4)
}))

test('replacement byte charges track the new value and oversize replacement removes the old copy', () => fixture(f => {
  const hot = f.write('hot', 'keep')
  const changing = f.write('changing', 'x'.repeat(1024))
  cache.readFile(hot)
  const hotBytes = cache.getStats().retainedBytes
  cache.readFile(changing)
  const before = cache.getStats().retainedBytes
  fs.writeFileSync(changing, 'x'.repeat(4096))
  cache.readFile(changing)
  assert.equal(cache.getStats().retainedBytes - before, (4096 - 1024) * 2)
  fs.writeFileSync(changing, 'x'.repeat(9 * 1024 * 1024))
  assert.equal(cache.readFile(changing).content.length, 9 * 1024 * 1024)
  assert.equal(cache.getStats().retainedBytes, hotBytes)
  assert.deepEqual(cache.getStats().entries, [hot])
}))

test('clear and invalidate release accounting; deleting and recreating a file re-reads it', () => fixture(f => {
  const a = f.write('a', 'abc')
  const b = f.write('b', 'longer')
  cache.readFile(a)
  const one = cache.getStats().retainedBytes
  cache.readFile(b)
  const both = cache.getStats().retainedBytes
  assert.ok(both > one)
  cache.invalidate(b)
  assert.equal(cache.getStats().retainedBytes, one)
  cache.invalidate(b)
  assert.equal(cache.getStats().retainedBytes, one)
  fs.unlinkSync(a)
  assert.throws(() => cache.readFile(a), { code: 'ENOENT' })
  assert.equal(cache.getStats().retainedBytes, 0)
  f.write('a', 'recreated')
  assert.equal(cache.readFile(a).content, 'recreated')
  cache.clear()
  assert.deepEqual(cache.getStats(), { size: 0, entries: [], retainedBytes: 0, maxBytes: 16 * 1024 * 1024 })
}))

test('stale read failures remove obsolete cached content and its byte charge', () => fixture(f => {
  const path = f.write('stale', 'old value')
  cache.readFile(path)
  f.write('stale', 'changed value')
  const state = (globalThis as any).__fileReadCacheTest
  state.fs.readFileSync = () => { throw new Error('read failed') }
  assert.throws(() => cache.readFile(path), /read failed/)
  assert.equal(cache.getStats().size, 0)
  assert.equal(cache.getStats().retainedBytes, 0)
}))

test('UTF-16 content and CRLF normalization stay identical on hits and misses', () => fixture(f => {
  const path = f.write('unicode.utf16', Buffer.from('量子\r\n🚀\r\n', 'utf16le'))
  assert.deepEqual(cache.readFile(path), { content: '量子\n🚀\n', encoding: 'utf16le' })
  assert.deepEqual(cache.readFile(path), { content: '量子\n🚀\n', encoding: 'utf16le' })
  assert.equal(f.reads.get(path), 1)
}))
