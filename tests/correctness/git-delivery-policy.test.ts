import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { gitDeliveryPolicy, gitDeliveryModelTimeout, isGitDeliveryRequest, GIT_DELIVERY_GUIDANCE } from '../../src/utils/gitDeliveryPolicy.ts'
import { watchModelStream, isModelProgress, ModelRequestDeadlineError, modelStallAction } from '../../src/utils/modelStreamLiveness.ts'

const human = (content: unknown) => ({ type: 'user', message: { content } })
test('only complete Git delivery imperatives receive a time budget', () => {
  for (const text of ['git add,commit and push', 'Please commit the changes and push to origin.',
    'stage all changed files then commit and push', 'just git push', 'commit'])
    assert.equal(isGitDeliveryRequest(text), true, text)
  for (const text of ['Fix the bug then commit and push', 'Why does git push take hours?',
    'review git commit', 'commit to a research plan', 'do not commit and push', 'git push failed',
    'git push --force', 'implement a commit cache', 'git push\nexplain the algorithm',
    'commit "fix push"', '', 'commit ' + 'all '.repeat(100)])
    assert.equal(isGitDeliveryRequest(text), false, text)
})
test('policy uses the latest human instruction, never tool output, host reminders or child context', () => {
  const history = [human('commit and push'), { type: 'assistant' },
    human([{ type: 'tool_result', content: 'fix the project' }]),
    { ...human('research the system'), isMeta: true }]
  const before = structuredClone(history)
  assert.equal(gitDeliveryPolicy(history, true), true)
  assert.equal(gitDeliveryPolicy(history, false), false)
  assert.equal(gitDeliveryPolicy([...history, human('research the system')], true), false)
  assert.equal(gitDeliveryPolicy([human('research the system'), { ...human('commit'), origin: { type: 'agent' } }], true), false)
  assert.equal(gitDeliveryPolicy([...history, human([{ type: 'image' }])], true), false)
  assert.equal(gitDeliveryPolicy([human([{ type: 'text', text: 'commit and push' }])], true), true)
  assert.equal(gitDeliveryPolicy([{ ...human('commit and push'), isCompactSummary: true }], true), false)
  assert.equal(gitDeliveryPolicy([human('research'), { ...human('commit'), toolUseResult: 'tool output' }], true), false)
  assert.deepEqual(history, before)
})
test('continuous thinking and host retry heartbeats cannot extend a Git model request', async () => {
  for (const kind of ['thinking', 'retry']) {
    let requestSignal: AbortSignal | undefined
    async function* provider(signal: AbortSignal) {
      requestSignal = signal
      while (!signal.aborted) {
        await delay(3)
        yield kind === 'thinking' ? { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } }
          : { type: 'system', subtype: 'api_error', retryInMs: 65000, retryAttempt: 1 }
      }
    }
    await assert.rejects(async () => {
      for await (const _ of watchModelStream(provider, { signal: new AbortController().signal,
        timeoutMs: 1000, maxDurationMs: 30, isProgress: isModelProgress })) {}
    }, ModelRequestDeadlineError)
    assert.equal(requestSignal?.aborted, true)
  }
})
test('model time is shared across rounds and exhaustion prevents another provider invocation', async () => {
  const timeBudget = { remainingMs: 50 }
  const options = { signal: new AbortController().signal, timeoutMs: 1000, maxDurationMs: 1000,
    timeBudget, isProgress: isModelProgress }
  let calls = 0
  async function* model() { calls++; await delay(30); yield { type: 'assistant' } }
  for await (const _ of watchModelStream(model, options)) {}
  assert.ok(timeBudget.remainingMs < 30)
  await assert.rejects(async () => { for await (const _ of watchModelStream(model, options)) {} }, ModelRequestDeadlineError)
  assert.equal(timeBudget.remainingMs, 0)
  await assert.rejects(async () => { for await (const _ of watchModelStream(model, options)) {} }, ModelRequestDeadlineError)
  assert.equal(calls, 2)
})
test('ordinary long reasoning retains idle-only semantics and cancellation wins', async () => {
  let count = 0
  async function* reasoning() {
    for (let i = 0; i < 12; i++) {
      await delay(4)
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } }
    }
  }
  for await (const _ of watchModelStream(reasoning, { signal: new AbortController().signal, timeoutMs: 30, isProgress: isModelProgress })) count++
  assert.equal(count, 12)
  const controller = new AbortController()
  async function* hung() { await new Promise(() => {}); yield { type: 'assistant' } }
  const task = (async () => { for await (const _ of watchModelStream(hung, { signal: controller.signal,
    timeoutMs: 1000, maxDurationMs: 1000, isProgress: isModelProgress })) {} })()
  controller.abort('operator pause')
  await task
})

test('production recovery bounds deadlines even for active goals/persistent mode and preserves admitted effects', () => {
  const source = readFileSync(new URL('../../src/query.ts', import.meta.url), 'utf8')
  const start = source.indexOf('          let activeGoalOnStall = false')
  const end = source.indexOf('          if (innerError instanceof ModelStreamStalledError', start)
  assert.ok(start > 0 && end > start)
  // Execute the actual policy at the query boundary, with both persistent
  // flags enabled. The real stream and executor have separate effect tests.
  const decide = new Function('scope', `const {readAutoGoal, mainGoalThread, isPersistentRetryEnabled,
    isForegroundRetrySource, querySource, ModelRequestDeadlineError, modelStallAction,
    toolUseBlocks, modelStallRecoveries, toolUseContext, innerError} = scope;
    ${source.slice(start, end)}
    return { persistentModelRetry, stallAction };`)
  const scope = { readAutoGoal: () => ({ state: 'ACTIVE' }), mainGoalThread: true,
    isPersistentRetryEnabled: () => true, isForegroundRetrySource: () => true, querySource: 'repl_main_thread',
    ModelRequestDeadlineError, modelStallAction, toolUseBlocks: [] as unknown[], modelStallRecoveries: 0,
    toolUseContext: { abortController: new AbortController() }, innerError: new ModelRequestDeadlineError(120000) }
  assert.deepEqual(decide(scope), { persistentModelRetry: false, stallAction: 'retry' })
  assert.deepEqual(decide({ ...scope, modelStallRecoveries: 1 }), { persistentModelRetry: false, stallAction: 'block' })
  assert.deepEqual(decide({ ...scope, toolUseBlocks: [{}] }), { persistentModelRetry: false, stallAction: 'collect' })
  assert.equal(decide({ ...scope, innerError: new Error('ordinary outage') }).persistentModelRetry, true)
  scope.toolUseContext.abortController.abort()
  assert.equal(decide(scope).stallAction, 'block')
  assert.match(source, /gitDeliveryPolicy\(params.messages, mainGoalThread\)/)
  assert.ok(source.indexOf('gitDeliveryPolicy(params.messages') < source.indexOf('while (true)'))
  assert.match(source, /cmd.mode === 'prompt' && !cmd.isMeta && cmd.origin === undefined\)\)\s+gitDelivery = false/)
  assert.match(source, /timeBudget: gitModelBudget/)
})
test('scope guidance retains acceptance and reconciles uncertain effects; timeout is configurable', () => {
  assert.match(GIT_DELIVERY_GUIDANCE, /hooks, signing, permissions and independent acceptance intact/)
  assert.match(GIT_DELIVERY_GUIDANCE, /reconcile local HEAD and the remote ref/)
  assert.equal(gitDeliveryModelTimeout('60000'), 60000)
  for (const value of ['', '0', '-1', 'NaN', 'Infinity', '5000000']) assert.equal(gitDeliveryModelTimeout(value), 120000)
  const prompt = readFileSync(new URL('../../src/tools/BashTool/prompt.ts', import.meta.url), 'utf8')
  assert.match(prompt, /3\. Run the following commands sequentially/)
  assert.match(prompt, /After staging succeeds, create the commit/)
})
