import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileSuggestionFilter } from '../../src/hooks/fileSuggestionIgnores.js'

test('root and nested ignore rules use their own base for tracked and untracked Git paths', () => {
  const keep = fileSuggestionFilter([
    { prefix: '', patterns: '/artifacts/\n*.log' },
    { prefix: 'src/', patterns: '/build/\n!keep.log' },
  ])!
  expect(['artifacts/run', 'other/build/tool', 'other/keep.log', 'src/build/tool',
    'src/keep.log', 'src2/keep.log', 'src/real\nsource.ts'].filter(keep)).toEqual([
    'other/build/tool', 'src/keep.log', 'src/real\nsource.ts',
  ])
  expect(fileSuggestionFilter([])).toBeNull()
})

test('research results can be omitted from code browsing while checker sources and manifests stay discoverable', () => {
  const patterns = readFileSync(new URL('../../.rgignore', import.meta.url), 'utf8')
  const keep = fileSuggestionFilter([{ prefix: '', patterns }])!
  const paper = 'hact-paper/Adaptive_HACT_v5/'
  expect(keep(paper + 'data/observations/observations.zip.part0000')).toBe(false)
  expect(keep(paper + 'results/v5/practical.json')).toBe(false)
  expect(keep(paper + 'results/installed_check_release_record.py')).toBe(true)
  expect(keep(paper + 'RELEASE_MANIFEST.json')).toBe(true)
  expect(keep('src/config/example.json')).toBe(true)
})
