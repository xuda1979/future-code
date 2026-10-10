import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { selectToolResultsForBudget, toolResultBudgetEnabled, toolResultBudgetLimit } from '../../src/utils/toolResultBudgetPolicy.ts'

register('./tool-result-budget-loader.mjs', import.meta.url)
const storage = await import('../../src/utils/toolResultStorage.ts')
const previousDirectory = process.env.FUTURE_CODE_TEST_RESULT_DIR
const previousLimit = process.env.FUTURE_CODE_TOOL_RESULT_BUDGET_CHARS
const previousDisable = process.env.FUTURE_CODE_DISABLE_TOOL_RESULT_BUDGET
delete process.env.FUTURE_CODE_TOOL_RESULT_BUDGET_CHARS
delete process.env.FUTURE_CODE_DISABLE_TOOL_RESULT_BUDGET
after(() => {
  for (const [key, value] of Object.entries({
    FUTURE_CODE_TEST_RESULT_DIR: previousDirectory,
    FUTURE_CODE_TOOL_RESULT_BUDGET_CHARS: previousLimit,
    FUTURE_CODE_DISABLE_TOOL_RESULT_BUDGET: previousDisable,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function fixture(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tool-result-budget-'))
  process.env.FUTURE_CODE_TEST_RESULT_DIR = dir
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}
function batch(contents: string[]) {
  return [{ type: 'user', message: { content: contents.map((content, i) => ({
    type: 'tool_result', tool_use_id: `result-${i}`, content,
  })) } }] as Parameters<typeof storage.enforceToolResultBudget>[0]
}

test('external conversations provision the budget without remote flags', () => {
  assert.ok(storage.provisionContentReplacementState())
  assert.equal(toolResultBudgetEnabled(undefined, undefined), true)
  assert.equal(toolResultBudgetEnabled(false, undefined), false)
  assert.equal(toolResultBudgetEnabled(true, '1'), false)
})

test('local batch targets win; invalid settings retain safe defaults', () => {
  assert.equal(toolResultBudgetLimit(undefined, undefined), 32_000)
  assert.equal(toolResultBudgetLimit(200_000, '16000'), 16_000)
  assert.equal(toolResultBudgetLimit(200_000, 'invalid'), 200_000)
  for (const value of ['0', '-1', 'Infinity', '7999', '1000001', '16000.5']) {
    assert.equal(toolResultBudgetLimit(null, value), 32_000)
  }
})

test('selection includes preview cost and avoids making small outputs larger', () => {
  const results = [{ size: 40_000 }, { size: 40_000 }, { size: 20_000 }]
  assert.deepEqual(selectToolResultsForBudget(results, 0, 32_000, 2512), results.slice(0, 2))
  assert.deepEqual(results.map(r => r.size), [40_000, 40_000, 20_000])
  assert.deepEqual(selectToolResultsForBudget(Array.from({ length: 40 }, () => ({ size: 1000 })), 0, 32_000, 2512), [])
})

test('400K batch becomes references; complete receipts and original transcript survive', () => fixture(async () => {
  const contents = Array.from({ length: 10 }, (_, i) => `${i}:` + 'receipt\n'.repeat(5000))
  const messages = batch(contents)
  const state = storage.createContentReplacementState()
  const result = await storage.enforceToolResultBudget(messages, state)
  assert.equal(result.newlyReplaced.length, 10)
  const visible = JSON.stringify(result.messages).length
  assert.ok(visible < 32_000, `Expected bounded payload, got ${visible}`)
  for (let i = 0; i < contents.length; i++) {
    assert.equal(readFileSync(storage.getToolResultPath(`result-${i}`, false), 'utf8'), contents[i])
  }
  assert.deepEqual(messages, batch(contents))
  const next = await storage.enforceToolResultBudget(messages, state)
  assert.deepEqual(next.messages, result.messages)
  assert.deepEqual(next.newlyReplaced, [])
  const resumed = storage.reconstructContentReplacementState(messages, result.newlyReplaced)
  const replay = await storage.enforceToolResultBudget(messages, resumed)
  assert.deepEqual(replay.messages, result.messages)
  assert.deepEqual(replay.newlyReplaced, [])
}))

test('resume freezes already seen output instead of changing a cached prefix', () => fixture(async () => {
  const messages = batch(['important\n'.repeat(5000)])
  const state = storage.reconstructContentReplacementState(messages, [])
  const result = await storage.enforceToolResultBudget(messages, state)
  assert.equal(result.messages, messages)
  assert.deepEqual(result.newlyReplaced, [])
}))

test('storage failure retains full output and cannot fabricate a reference', () => fixture(async dir => {
  mkdirSync(join(dir, 'session'))
  writeFileSync(storage.getToolResultsDir(), 'not a directory')
  const messages = batch(['receipt\n'.repeat(6000)])
  const state = storage.createContentReplacementState()
  const result = await storage.enforceToolResultBudget(messages, state)
  assert.equal(result.messages, messages)
  assert.deepEqual(result.newlyReplaced, [])
  assert.equal(state.replacements.size, 0)
}))

test('Read and images retain their exemptions; no record is emitted without persistence', () => fixture(async () => {
  const messages = [
    { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 'result-0', name: 'Read' }] } },
    ...batch(['file\n'.repeat(10_000)]),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'image', content: [{ type: 'image', source: { type: 'base64', data: 'pixels' } }] }] } },
  ] as Parameters<typeof storage.enforceToolResultBudget>[0]
  const records: unknown[] = []
  const result = await storage.applyToolResultBudget(messages, storage.createContentReplacementState(), r => records.push(...r), new Set(['Read']))
  assert.equal(result, messages)
  assert.deepEqual(records, [])
}))
