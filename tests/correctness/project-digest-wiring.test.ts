import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Dependency-free wiring regression for the session-start project digest
 * (src/utils/projectDigest.ts wired into getSystemContext in src/context.ts).
 * Mining evidence: 1451/1623 sessions made zero file edits in their first 12
 * tool calls while re-deriving host-known facts (ls -la x690, sed -n x680,
 * grep -n x549, git status x360 openers). If this wiring silently disappears,
 * sessions regress to layout probing. Read-only assertions, no imports from
 * the runtime graph — mirrors read-dedup-wiring.test.ts.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('getSystemContext still collects and returns the project digest', () => {
  const source = readFileSync(resolve(root, 'src/context.ts'), 'utf8')
  assert.match(
    source,
    /import \{ collectProjectDigest \} from '\.\/utils\/projectDigest\.js'/,
    'collectProjectDigest import must remain wired',
  )
  assert.match(
    source,
    /const projectDigest = collectProjectDigest\(\)/,
    'digest must be collected inside getSystemContext',
  )
  assert.match(
    source,
    /\.\.\.\(projectDigest && \{ projectDigest \}\)/,
    'digest must be returned as a system-context key',
  )
  assert.match(
    source,
    /has_project_digest: projectDigest !== null/,
    'digest presence must stay observable in diagnostics',
  )
})

test('projectDigest module keeps the killswitch, CCR, and bare-mode guards', () => {
  const source = readFileSync(resolve(root, 'src/utils/projectDigest.ts'), 'utf8')
  assert.match(
    source,
    /FUTURE_CODE_DISABLE_PROJECT_DIGEST/,
    'killswitch env var must remain',
  )
  assert.match(
    source,
    /FUTURE_CODE_REMOTE/,
    'CCR (FUTURE_CODE_REMOTE) skip must remain',
  )
  assert.match(
    source,
    /FUTURE_CODE_SIMPLE/,
    'bare-mode env guard must remain',
  )
  assert.match(
    source,
    /argv\.includes\('--bare'\)/,
    'bare-mode argv guard must remain',
  )
})

test('projectDigest module keeps the bounded-output guarantees', () => {
  const source = readFileSync(resolve(root, 'src/utils/projectDigest.ts'), 'utf8')
  assert.match(
    source,
    /MAX_DIGEST_CHARS = \d+/,
    'hard character cap must remain',
  )
  assert.match(
    source,
    /digest truncated/,
    'truncation marker must remain',
  )
  assert.match(
    source,
    /MAX_MANIFEST_BYTES/,
    'manifest size cap must remain',
  )
})

test('projectDigest directive preserves verification rigor', () => {
  const source = readFileSync(resolve(root, 'src/utils/projectDigest.ts'), 'utf8')
  assert.match(
    source,
    /Act directly/,
    'act-directly directive must remain',
  )
  assert.match(
    source,
    /snapshot can go stale/,
    'staleness warning must remain — the digest is not a freshness oracle',
  )
  assert.match(
    source,
    /verify every work outcome with concrete checks/,
    'verification directive must remain',
  )
})

test('projectDigest module stays dependency-free for the offline Node gate', () => {
  const source = readFileSync(resolve(root, 'src/utils/projectDigest.ts'), 'utf8')
  const imports = [...source.matchAll(/^import .*?from '([^']+)'/gm)].map(m => m[1])
  assert.ok(imports.length > 0, 'module must import node builtins')
  for (const specifier of imports) {
    assert.match(
      specifier,
      /^node:/,
      `non-builtin import '${specifier}' would break the offline gate`,
    )
  }
})
