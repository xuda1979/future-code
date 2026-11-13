import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, register } from 'node:module'
import { readFileSync } from 'node:fs'

if (!process.versions.bun) register('./source-loader.mjs', import.meta.url)
;(globalThis as any).require = createRequire(import.meta.url)
const { marked } = await import('marked')
const { cachedLexer, clearMarkdownTokenCache, getMarkdownTokenCacheStats } = await import('../../src/utils/markdownLexer.ts')
const { default: Output } = await import('../../src/ink/output.ts')
const { CharPool, HyperlinkPool, StylePool, createScreen, cellAt } = await import('../../src/ink/screen.ts')
const { lineWidth } = await import('../../src/ink/line-width-cache.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')

test('cached and transient Markdown return identical complete parser tokens', () => {
  clearMarkdownTokenCache()
  for (const content of [
    '# 中文与 Unicode 👩‍🔬\n\n**bold** and [link](https://example.com)\n',
    '| a | b |\n|---|---|\n| 1 | 2 |\n',
    '```ts\nconst x = "值"\n',
    '- first\n  - nested\n\n> quoted\n',
    '**ref** [example][id]\n\n[id]: https://example.com\n',
    '# lone surrogate \ud800 and \udc00\n',
  ]) {
    const expected = marked.lexer(content)
    assert.deepEqual(cachedLexer(content), expected)
    assert.deepEqual(cachedLexer(content, false), expected)
    assert.equal(cachedLexer(content), cachedLexer(content), 'Historical remount must hit the token cache')
  }
})

test('one-use streaming variants do not pollute the completed-message cache', () => {
  clearMarkdownTokenCache()
  const history = cachedLexer('**keep this history hot**')
  const before = getMarkdownTokenCacheStats()
  for (let i = 0; i < 600; i++) cachedLexer('```ts\n' + 'const x = 1;\n'.repeat(20) + i, false)
  assert.deepEqual(getMarkdownTokenCacheStats(), before)
  assert.equal(cachedLexer('**keep this history hot**'), history)
  const source = readFileSync(new URL('../../src/components/Markdown.tsx', import.meta.url), 'utf8')
  assert.ok(source.includes('<Markdown cache={false}>{stablePrefix}</Markdown>'))
  assert.ok(source.includes('<Markdown cache={false}>{unstableSuffix}</Markdown>'))
})

test('large historical parses stay within bytes and entry limits without truncation', () => {
  clearMarkdownTokenCache()
  for (let i = 0; i < 510; i++) {
    const content = '```text\n' + i + 'x'.repeat(10000) + '\n```'
    assert.deepEqual(cachedLexer(content), marked.lexer(content))
    assert.ok(getMarkdownTokenCacheStats().bytes <= getMarkdownTokenCacheStats().maxBytes)
  }
  const before = getMarkdownTokenCacheStats()
  const oversized = '```text\n' + 'x'.repeat(5 * 1024 * 1024) + '\n```'
  assert.deepEqual(cachedLexer(oversized), marked.lexer(oversized))
  assert.deepEqual(getMarkdownTokenCacheStats(), before)
})

test('plain-text fast path remains uncached and unchanged', () => {
  clearMarkdownTokenCache()
  assert.deepEqual(cachedLexer('plain 中文'), [{ type: 'paragraph', raw: 'plain 中文', text: 'plain 中文', tokens: [{ type: 'text', raw: 'plain 中文', text: 'plain 中文' }] }])
  assert.equal(getMarkdownTokenCacheStats().entries, 0)
})

test('screen cells, styles, hyperlinks and Unicode survive eviction and resize', () => {
  const styles = new StylePool()
  const screen = createScreen(120, 4, styles, new CharPool(), new HyperlinkPool())
  const output = new Output({ width: 120, height: 4, stylePool: styles, screen })
  const lines = ['\x1b[31mred\x1b[0m 中👩‍🔬', '\x1b]8;;https://example.com\x07link\x1b]8;;\x07', 'a\tb', 'עברית العربية']
  const frame = () => {
    output.reset(120, 4, screen)
    lines.forEach((line, y) => output.write(0, y, line))
    output.get()
    return Array.from({ length: 480 }, (_, i) => cellAt(screen, i % 120, Math.floor(i / 120)))
  }
  const expected = frame()
  assert.equal(expected[0]!.char, 'r')
  assert.equal(expected[120]!.hyperlink, 'https://example.com')
  for (let i = 0; i < 2000; i++) {
    output.reset(120, 4, screen)
    output.write(0, 0, String(i).padStart(6, '0') + 'x'.repeat(114))
    output.get()
    const cache = (output as any).charCache
    assert.ok(cache.calculatedBytes <= cache.maxBytes)
  }
  assert.deepEqual(frame(), expected)
  output.reset(60, 4, screen)
  output.write(0, 0, lines[0]!)
  output.get()
  assert.equal(cellAt(screen, 0, 0)!.char, 'r')
  const chars = (output as any).charCache
  const before = chars.size
  frame()
  assert.equal(chars.size, before, 'Repeated unchanged frames reuse cached lines')
})

test('line width results remain exact for ANSI, Unicode and oversize keys', () => {
  for (const value of ['', 'normal', '中文', '\x1b[31mred\x1b[0m', '👩‍🔬', 'a'.repeat(600000)]) {
    assert.equal(lineWidth(value), stringWidth(value))
    assert.equal(lineWidth(value), stringWidth(value))
  }
})
