import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Dependency-free wiring regression for coverage-based Read dedup
 * (src/utils/readRangeCoverage.ts wired into FileReadTool.ts).
 *
 * Why static: FileReadTool.ts pulls zod, analytics, skills, image and PDF
 * utilities — none installable in the hermetic offline gate. The pure
 * predicate has its own behavioral test (read-range-coverage.test.ts);
 * this file pins the wiring so a refactor can't silently drop back to
 * exact-match dedup or remove the mtime/killswitch/partial-view guards.
 */

const sourcePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/tools/FileReadTool/FileReadTool.ts',
)
const source = readFileSync(sourcePath, 'utf8')

test('dedup condition uses the coverage predicate', () => {
  assert.match(
    source,
    /import \{ readRangeCovers \} from '\.\.\/\.\.\/utils\/readRangeCoverage\.js'/,
    'FileReadTool must import readRangeCovers',
  )
  assert.match(
    source,
    /readRangeCovers\(\s*\{ offset: existingState\.offset, limit: existingState\.limit \},\s*\{ offset, limit \},\s*\)/,
    'dedup must call readRangeCovers with cached then requested ranges',
  )
  assert.doesNotMatch(
    source,
    /const rangeMatch =/,
    'exact-match rangeMatch must be gone — coverage supersedes it',
  )
})

test('dedup keeps its safety guards', () => {
  assert.match(
    source,
    /tengu_read_dedup_killswitch/,
    'feature killswitch must remain',
  )
  assert.match(
    source,
    /!existingState\.isPartialView/,
    'partial-view (auto-injected) entries must stay excluded',
  )
  assert.match(
    source,
    /existingState\.offset !== undefined/,
    'non-Read (Edit/Write) entries must stay excluded',
  )
  assert.match(
    source,
    /mtimeMs === existingState\.timestamp/,
    'mtime equality check must remain — coverage alone is not freshness',
  )
  assert.match(
    source,
    /type: 'file_unchanged' as const/,
    'file_unchanged stub return must remain',
  )
})
