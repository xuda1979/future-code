import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { MEMORY_TYPES, parseMemoryType, TYPES_SECTION_COMBINED, TYPES_SECTION_INDIVIDUAL, WHAT_NOT_TO_SAVE_SECTION } from '../../src/memdir/memoryTypes.ts'
register('./project-experience-loader.mjs', import.meta.url)
const { buildMemoryPrompt } = await import('../../src/memdir/memdir.ts')
const { buildCombinedMemoryPrompt } = await import('../../src/memdir/teamMemPrompts.ts')
const { buildExtractAutoOnlyPrompt, buildExtractCombinedPrompt } = await import('../../src/services/extractMemories/prompts.ts')
const { scanMemoryFiles, formatMemoryManifest } = await import('../../src/memdir/memoryScan.ts')

test('project experience is a first-class backwards-compatible memory type', () => {
  for (const kind of ['user', 'feedback', 'project', 'reference', 'experience']) assert.equal(parseMemoryType(kind), kind)
  assert.equal(MEMORY_TYPES.length, 5)
  for (const unknown of [undefined, null, 'procedure', 4]) assert.equal(parseMemoryType(unknown), undefined)
  for (const section of [TYPES_SECTION_COMBINED, TYPES_SECTION_INDIVIDUAL]) {
    const prompt = section.join('\n')
    assert.match(prompt, /<name>experience<\/name>/)
    for (const field of ['Conditions', 'Observation', 'Evidence', 'Lesson', 'Limits']) assert.ok(prompt.includes(`**${field}:**`))
    assert.match(prompt, /never permission.*proof of completion.*independent checks/)
    assert.match(prompt, /Fresh contradictory evidence wins/)
  }
  assert.doesNotMatch(WHAT_NOT_TO_SAVE_SECTION.join('\n'), /- Debugging solutions or fix recipes/)
})
test('foreground, team and optional extraction writers all receive the autonomous learning contract', () => {
  for (const prompt of [buildMemoryPrompt({ displayName: 'auto memory', memoryDir: '/test/missing/' }),
    buildCombinedMemoryPrompt(), buildExtractAutoOnlyPrompt(12, ''), buildExtractCombinedPrompt(12, '')]) {
    assert.match(prompt, /Autonomously save a concise lesson/)
    assert.match(prompt, /Do not create a lesson for every tool call/)
    assert.match(prompt, /never in the project-neutral runtime or another project/)
    assert.match(prompt, /not transcripts, credentials or secrets/)
    assert.match(prompt, /Honor memory opt-outs and forget requests/)
  }
})
test('experience survives a fresh disk read, is indexed for selective recall, and stays within the selected project directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-experience-'))
  const projectA = join(root, 'project-a') + sep, projectB = join(root, 'project-b') + sep
  mkdirSync(projectA); mkdirSync(projectB)
  ;(globalThis as any).__experienceDir = projectA
  try {
    const name = 'experience_delivery.md'
    const lesson = 'Conditions: local delivery\nEvidence: fixture receipt\nLesson: stage before commit\nLimits: advice only'
    // JSON is valid YAML; production frontmatter parsing, file reads, type
    // parsing, manifests and prompt/index loading remain real in this test.
    writeFileSync(join(projectA, name), '---\n' + JSON.stringify({ type: 'experience', description: 'delivery ordering lesson' }) + '\n---\n' + lesson)
    writeFileSync(join(projectA, 'MEMORY.md'), '- [Delivery ordering](experience_delivery.md) — stage before commit')
    const recalled = await scanMemoryFiles(projectA, new AbortController().signal)
    assert.equal(recalled.length, 1)
    assert.equal(recalled[0]!.type, 'experience')
    assert.match(formatMemoryManifest(recalled), /\[experience\] experience_delivery.md/)
    assert.equal(readFileSync(recalled[0]!.filePath, 'utf8').split('---\n').at(-1), lesson)
    assert.match(buildMemoryPrompt({ displayName: 'auto memory', memoryDir: projectA }), /\[Delivery ordering\]\(experience_delivery.md\)/)
    assert.deepEqual(await scanMemoryFiles(projectB, new AbortController().signal), [])
    assert.doesNotMatch(buildMemoryPrompt({ displayName: 'auto memory', memoryDir: projectB }), /\[Delivery ordering\]/)
  } finally { delete (globalThis as any).__experienceDir; rmSync(root, { recursive: true, force: true }) }
})
