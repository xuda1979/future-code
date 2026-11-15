import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_DIGEST_CHARS,
  collectProjectDigest,
  formatProjectDigest,
  projectDigestDisabled,
  selectLayoutEntries,
} from '../../src/utils/projectDigest.ts'

// ---------------------------------------------------------------------------
// selectLayoutEntries (pure)
// ---------------------------------------------------------------------------

test('selectLayoutEntries filters noise, sorts dirs first, and caps output', () => {
  const names = [
    { name: 'zz-file.txt', isDir: false },
    { name: 'node_modules', isDir: true },
    { name: 'b-dir', isDir: true },
    { name: 'a-dir', isDir: true },
    { name: '.hidden', isDir: false },
    { name: 'package-lock.json', isDir: false },
    { name: 'a-file.ts', isDir: false },
    { name: 'package.json', isDir: false },
  ]
  const { shown, hidden } = selectLayoutEntries(names, 4)
  // Dirs first, sorted; noise and dotfiles dropped; cap applied.
  // Survivors: a-dir/, b-dir/, a-file.ts, package.json, zz-file.txt.
  assert.deepEqual(shown, ['a-dir/', 'b-dir/', 'a-file.ts', 'package.json'])
  assert.equal(hidden, 1)

  const capped = selectLayoutEntries(names, 2)
  assert.deepEqual(capped.shown, ['a-dir/', 'b-dir/'])
  assert.equal(capped.hidden, 3)
})

test('selectLayoutEntries tolerates dot-prefixed directories', () => {
  const { shown } = selectLayoutEntries([{ name: '.git', isDir: true }, { name: '.env', isDir: false }], 10)
  assert.deepEqual(shown, [])
})

// ---------------------------------------------------------------------------
// formatProjectDigest (pure)
// ---------------------------------------------------------------------------

test('formatProjectDigest returns null when nothing to show', () => {
  assert.equal(
    formatProjectDigest({ rootShown: [], rootHidden: 0, srcShown: null, srcHidden: 0 }, null),
    null,
  )
  assert.equal(
    formatProjectDigest(
      { rootShown: [], rootHidden: 0, srcShown: null, srcHidden: 0 },
      { scripts: [] },
    ),
    null,
  )
})

test('formatProjectDigest renders layout, manifest, scripts, and act-directly directive', () => {
  const out = formatProjectDigest(
    { rootShown: ['src/', 'tests/', 'package.json'], rootHidden: 3, srcShown: ['main.tsx'], srcHidden: 0 },
    {
      name: 'demo',
      version: '1.2.3',
      entry: 'src/main.tsx',
      scripts: [
        ['test', 'node scripts/test-correctness.mjs'],
        ['build', 'tsc'],
      ],
    },
  )
  assert.ok(out)
  assert.match(out, /Top-level: src\/ tests\/ package\.json \(\+3 more\)/)
  assert.match(out, /src\/: main\.tsx/)
  assert.match(out, /Manifest: demo@1\.2\.3 \| entry: src\/main\.tsx/)
  assert.match(out, /test: node scripts\/test-correctness\.mjs/)
  assert.match(out, /Act directly:/)
  assert.match(out, /verify every work outcome with concrete checks/)
})

test('formatProjectDigest clips long script commands', () => {
  const long = 'x'.repeat(300)
  const out = formatProjectDigest(
    { rootShown: ['a'], rootHidden: 0, srcShown: null, srcHidden: 0 },
    { name: 'demo', scripts: [['big', long]] },
  )
  assert.ok(out)
  assert.ok(!out.includes(long))
  assert.match(out, /big: x{120}\.\.\./)
})

test('formatProjectDigest truncates at the hard character cap', () => {
  // 500 entries x ~16 chars + separators overflows the 4000-char cap.
  const many = Array.from({ length: 500 }, (_, i) => `long-entry-name-${i}`)
  const out = formatProjectDigest(
    { rootShown: many, rootHidden: 0, srcShown: null, srcHidden: 0 },
    null,
  )
  assert.ok(out)
  assert.ok(out.length <= MAX_DIGEST_CHARS + 40, `digest length ${out.length} exceeds cap`)
  assert.match(out, /\(digest truncated\)/)
})

// ---------------------------------------------------------------------------
// projectDigestDisabled (guards)
// ---------------------------------------------------------------------------

const GUARD_VARS = [
  'FUTURE_CODE_DISABLE_PROJECT_DIGEST',
  'FUTURE_CODE_REMOTE',
  'FUTURE_CODE_SIMPLE',
] as const

function clearGuards() {
  const saved: Record<string, string | undefined> = {}
  for (const v of GUARD_VARS) {
    saved[v] = process.env[v]
    delete process.env[v]
  }
  return saved
}

function restoreGuards(saved: Record<string, string | undefined>) {
  for (const v of GUARD_VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
}

test('projectDigestDisabled honors killswitch, CCR, and bare mode', () => {
  const saved = clearGuards()
  try {
    assert.equal(projectDigestDisabled({}, []), false)
    assert.equal(projectDigestDisabled({ FUTURE_CODE_DISABLE_PROJECT_DIGEST: '1' }, []), true)
    assert.equal(projectDigestDisabled({ FUTURE_CODE_DISABLE_PROJECT_DIGEST: 'false' }, []), false)
    assert.equal(projectDigestDisabled({ FUTURE_CODE_REMOTE: 'true' }, []), true)
    assert.equal(projectDigestDisabled({ FUTURE_CODE_SIMPLE: 'yes' }, []), true)
    assert.equal(projectDigestDisabled({}, ['future-code', '--bare']), true)
  } finally {
    restoreGuards(saved)
  }
})

// ---------------------------------------------------------------------------
// collectProjectDigest (filesystem, temp fixtures)
// ---------------------------------------------------------------------------

test('collectProjectDigest builds a digest from a real project fixture', () => {
  const saved = clearGuards()
  const dir = mkdtempSync(join(tmpdir(), 'digest-fixture-'))
  try {
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture-app',
        version: '0.0.1',
        main: 'src/index.ts',
        scripts: { test: 'node --test', start: 'bun src/index.ts' },
      }),
    )
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {}\n')
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    const out = collectProjectDigest(dir)
    assert.ok(out, 'digest should be produced for a valid project dir')
    assert.match(out, /Top-level: src\/ package\.json/)
    assert.ok(!out.includes('node_modules'), 'node_modules must be filtered')
    assert.ok(!out.includes('package-lock.json'), 'lockfiles must be filtered')
    assert.match(out, /src\/: index\.ts/)
    assert.match(out, /fixture-app@0\.0\.1/)
    assert.match(out, /entry: src\/index\.ts/)
    assert.match(out, /test: node --test/)
  } finally {
    restoreGuards(saved)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectProjectDigest returns null for empty and missing directories', () => {
  const saved = clearGuards()
  const dir = mkdtempSync(join(tmpdir(), 'digest-empty-'))
  try {
    // Empty dir: no entries -> null.
    assert.equal(collectProjectDigest(dir), null)
    // Nonexistent dir: readdir fails -> null.
    assert.equal(collectProjectDigest(join(dir, 'no-such-dir')), null)
  } finally {
    restoreGuards(saved)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectProjectDigest respects the killswitch', () => {
  const saved = clearGuards()
  const dir = mkdtempSync(join(tmpdir(), 'digest-kill-'))
  try {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }))
    process.env.FUTURE_CODE_DISABLE_PROJECT_DIGEST = '1'
    assert.equal(collectProjectDigest(dir), null)
    delete process.env.FUTURE_CODE_DISABLE_PROJECT_DIGEST
    assert.ok(collectProjectDigest(dir))
  } finally {
    restoreGuards(saved)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectProjectDigest ignores malformed package.json and falls back to layout only', () => {
  const saved = clearGuards()
  const dir = mkdtempSync(join(tmpdir(), 'digest-badmanifest-'))
  try {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'package.json'), '{not json')
    const out = collectProjectDigest(dir)
    assert.ok(out)
    assert.match(out, /Top-level: src\/ package\.json/)
    assert.ok(!out.includes('Manifest:'), 'malformed manifest must be skipped')
  } finally {
    restoreGuards(saved)
    rmSync(dir, { recursive: true, force: true })
  }
})
