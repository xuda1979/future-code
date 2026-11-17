import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register, stripTypeScriptTypes } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { createRoutineDecisionPolicy, isRoutineDecisionCurrent, isRoutineDecisionRequest,
  routineDecisionModelTimeout, recoverRoutineDecision, resetRoutineDecisionAfterTools } from '../../src/utils/routineDecisionPolicy.ts'
import { watchModelStream, isModelProgress, ModelRequestDeadlineError, ModelStreamStalledError,
  modelStallAction } from '../../src/utils/modelStreamLiveness.ts'
register('./streaming-tool-executor-loader.mjs', import.meta.url)
const { StreamingToolExecutor } = await import('../../src/services/tools/StreamingToolExecutor.ts')
const savedRoutineTimeout = process.env.FUTURE_CODE_ROUTINE_MODEL_TIMEOUT_MS
delete process.env.FUTURE_CODE_ROUTINE_MODEL_TIMEOUT_MS
after(() => {
  if (savedRoutineTimeout === undefined) delete process.env.FUTURE_CODE_ROUTINE_MODEL_TIMEOUT_MS
  else process.env.FUTURE_CODE_ROUTINE_MODEL_TIMEOUT_MS = savedRoutineTimeout
})

const human = (text: unknown) => ({ type: 'user', message: { content: text } })
const objective = 'replace "old" with "new" in src/app.ts'
const goal = () => ({ state: 'ACTIVE', goal: objective, revision: 1, activeSteering: [] as string[] })

test('only complete routine imperatives on active short main-thread goals opt in', () => {
  for (const text of [objective, 'rename old.txt to new.txt', 'set enabled to true in config.json',
    'run npm test', 'run python3 -m pytest -q', 'add model local-llm with API URL https://example.invalid/v1'])
    assert.equal(isRoutineDecisionRequest(text), true, text)
  for (const text of ['prove P != NP', 'research quantum computing', 'derive a formula', 'fix the bug',
    'design test architecture', 'why is run npm test slow?', 'run npm test and redesign the system',
    'replace the application', 'run training', 'rename the entire project', 'do not run npm test',
    'run npm test\nthen fix everything', 'run `rm -rf /`'])
    assert.equal(isRoutineDecisionRequest(text), false, text)
  for (const [main, currentGoal, short] of [[false, goal(), true], [true, null, true],
    [true, { ...goal(), state: 'PAUSED' }, true], [true, goal(), false],
    [true, { ...goal(), goal: 'Research a new algorithm' }, true]] as const)
    assert.equal(createRoutineDecisionPolicy([human(objective)], main, currentGoal, short), undefined)
  assert.ok(createRoutineDecisionPolicy([human(objective)], true, goal(), true))
  assert.equal(createRoutineDecisionPolicy([human(objective), human([{ type: 'image' }])], true, goal(), true), undefined)
  assert.equal(createRoutineDecisionPolicy([human('derive a proof'), { ...human(objective), isMeta: true }], true, goal(), true), undefined)
})

test('corrections are bounded without limiting goal lifetime or granting tools', () => {
  const state = createRoutineDecisionPolicy([human(objective)], true, goal(), true)!
  assert.equal(routineDecisionModelTimeout(state), 120000)
  assert.equal(routineDecisionModelTimeout(state, '0'), undefined)
  assert.equal(routineDecisionModelTimeout(state, '30000'), 30000)
  assert.equal(routineDecisionModelTimeout(state, 'NaN'), 120000)
  const opts = { admittedTools: 0, aborted: false, currentModel: 'primary', fallbackModel: 'fallback' }
  assert.equal(recoverRoutineDecision(state, { ...opts, admittedTools: 1 }), null)
  assert.equal(recoverRoutineDecision(state, { ...opts, aborted: true }), null)
  assert.equal(state.expiries, 0)
  assert.equal(recoverRoutineDecision(state, opts)?.kind, 'retry')
  assert.match(state.guidance!, /permissions, hooks and independent verification/)
  assert.equal(recoverRoutineDecision(state, opts)?.kind, 'fallback')
  assert.equal(recoverRoutineDecision(state, { ...opts, currentModel: 'fallback' })?.kind, 'release')
  assert.equal(routineDecisionModelTimeout(state), undefined)
  assert.equal(recoverRoutineDecision(state, opts), null)
  resetRoutineDecisionAfterTools(state)
  assert.equal(state.expiries, 0)
  assert.equal(routineDecisionModelTimeout(state), 120000)
  assert.equal(isRoutineDecisionCurrent(state, { ...goal(), revision: 2 }), false)
  assert.equal(isRoutineDecisionCurrent(state, { ...goal(), activeSteering: ['new constraint'] }), false)
  assert.equal(isRoutineDecisionCurrent(state, { ...goal(), horizon: 'long' }), false)
})

// Execute the actual query request construction, watch invocation and recovery
// branch. Isolate UI/API adapters; use the real stream watchdog and executor.
// This certifies that boundary, not an unavailable full CLI/module graph.
const source = readFileSync(new URL('../../src/query.ts', import.meta.url), 'utf8')
const setupStart = source.indexOf('          if (routineDecision && !gitDelivery) {')
const setupEnd = source.indexOf("          queryCheckpoint('query_api_streaming_start')", setupStart)
const watchStart = source.indexOf('          for await (const message of watchModelStream', setupEnd)
const watchEnd = source.indexOf('            if (isModelProgress(message))', watchStart)
const catchStart = source.indexOf('          // Soft routine latency recovery')
const catchEnd = source.indexOf('          // A blackholed request', catchStart)
assert.ok(setupStart > 0 && setupEnd > setupStart && watchStart > setupEnd && watchEnd > watchStart && catchStart > watchEnd && catchEnd > catchStart)

async function runBoundary(options: { fallback?: string; succeedAt?: number; admitBeforeTimeout?: boolean;
  complex?: boolean; queued?: boolean; steer?: boolean; cancel?: boolean; disabled?: boolean; slowSuccess?: boolean } = {}) {
  let currentGoal = goal()
  const originalGoal = structuredClone(currentGoal)
  const originalThinking = { type: 'enabled', budgetTokens: 32000 }
  const requests: any[] = [], notices: any[] = []
  const counts = { effects: 0, permissionChecks: 0, receipts: 0 }
  const tools = [{ name: 'Write', inputSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
    isConcurrencySafe: () => false, interruptBehavior: () => 'cancel' }]
  const toolUseContext: any = { abortController: new AbortController(), options: { tools, thinkingConfig: originalThinking,
    mainLoopModel: 'primary', agentDefinitions: { activeAgents: [] } },
    getAppState: () => ({ toolPermissionContext: { mode: 'bypassPermissions', marker: 'original-policy' } }),
    setInProgressToolUseIDs: () => {}, setHasInterruptibleToolInProgress: () => {} }
  const canUseTool = async () => { counts.permissionChecks++; return { behavior: 'allow' } }
  ;(globalThis as any).__futureStreamingToolTest = async function* (block: any, _message: any, permission: any) {
    await permission()
    counts.effects++
    await delay(55) // Tool work may outlive the scaled model decision deadline.
    counts.receipts++
    yield { message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: block.id, content: 'actual written candidate; verification remains required' }] } } }
  }
  const deps = { callModel: async function* (args: any) {
    requests.push(args)
    assert.equal(args.thinkingConfig, originalThinking)
    assert.equal(args.options.effortValue, 'max')
    assert.deepEqual(await args.options.getToolPermissionContext(), { mode: 'bypassPermissions', marker: 'original-policy' })
    const call = requests.length
    if (options.steer && call === 1) currentGoal = { ...currentGoal, revision: 2, activeSteering: ['new instruction'] }
    if (options.cancel && call === 1) toolUseContext.abortController.abort('operator pause')
    yield { type: 'assistant', uuid: `thinking-${call}`, message: { content: [{ type: 'thinking', thinking: 'deliberating', signature: 'model-bound' }] } }
    if (options.admitBeforeTimeout || call >= (options.succeedAt ?? 2)) {
      if (options.slowSuccess) for (let i = 0; i < 22 && !args.signal.aborted; i++) {
        await delay(3)
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } }
      }
      yield { type: 'assistant', uuid: `effect-${call}`, message: { content: [{ type: 'tool_use', id: 'effect', name: 'Write', input: {} }] } }
      if (!options.admitBeforeTimeout) return
    }
    const finite = options.complex || options.disabled || (options.steer && call > 1)
    for (let i = 0; !args.signal.aborted && (!finite || i < 22); i++) {
      await delay(3)
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } }
    }
  } }
  const scope = { deps, StreamingToolExecutor, toolUseContext, canUseTool, notices, requests, counts,
    routineDecisionModelTimeout: (state: any) => routineDecisionModelTimeout(state, options.disabled ? '0' : undefined),
    isRoutineDecisionCurrent, recoverRoutineDecision, ModelRequestDeadlineError, ModelStreamStalledError, modelStallAction, isModelProgress,
    watchModelStream: (factory: any, opts: any) => watchModelStream(factory, { ...opts,
      ...(opts.maxDurationMs === undefined ? {} : { maxDurationMs: opts.maxDurationMs / 6000 }) }),
    modelStreamIdleTimeout: () => 1000, gitDeliveryModelTimeout: () => 120000,
    readAutoGoal: () => currentGoal, isPersistentRetryEnabled: () => true, isForegroundRetrySource: () => true,
    getCommandQueueSnapshot: () => options.queued ? [{}] : [], hasMainThreadQueuedCommand: (queue: any[]) => queue.length > 0,
    stripSignatureBlocks: (messages: any[]) => messages.map(message => message.type === 'assistant' ? { ...message,
      message: { ...message.message, content: message.message.content.filter((block: any) => block.type !== 'thinking') } } : message),
    appendGoalRequestAnchor: (messages: any[]) => [...messages, human('[Current objective] ' + currentGoal.goal + ' revision ' + currentGoal.revision)],
    createUserMessage: (value: any) => ({ ...human(value.content), isMeta: value.isMeta }),
    createSystemMessage: (content: string) => ({ type: 'system', content }), prependUserContext: (messages: any[]) => messages,
    state: createRoutineDecisionPolicy([human(options.complex ? 'derive a new theorem' : objective)], true, currentGoal, !options.complex),
    fallbackModel: options.fallback,
  }
  const body = `async function* run() {
    let routineDecision = state, currentModel = 'primary', messagesForQuery = [${JSON.stringify(human(objective))}],
      goalRequestMessages = messagesForQuery, assistantMessages = [], toolResults = [], toolUseBlocks = [], needsFollowUp = false,
      streamingToolExecutor = new StreamingToolExecutor(toolUseContext.options.tools, canUseTool, toolUseContext);
    const gitDelivery = false, gitModelBudget = {remainingMs:240000}, GIT_DELIVERY_GUIDANCE = '', fullSystemPrompt = ['verification stays required'],
      userContext = {}, config = {gates:{fastModeEnabled:false}}, appState = {effortValue:'max',mcp:{tools:[],clients:[]}},
      params = {}, maxOutputTokensOverride = undefined, dumpPromptsFetch = undefined, querySource = 'repl_main_thread',
      queryTracking = {}, skipCacheWrite = false, mainGoalThread = true, autoGoalPolicy = 'immutable authority', useStreamingToolExecution = true;
    let modelStallRecoveries = 0, attemptWithFallback = true, streamingFallbackOccured = false;
    while (attemptWithFallback) {
      attemptWithFallback = false;
      let routineDeadline;
      try {
        ${source.slice(setupStart, setupEnd)}
        ${source.slice(watchStart, watchEnd)}
          if (message.type === 'assistant') {
            assistantMessages.push(message);
            for (const block of message.message.content) if (block.type === 'tool_use') {
              toolUseBlocks.push(block); streamingToolExecutor.addTool(block, message);
            }
          }
        }
      } catch (innerError) {
        ${source.slice(catchStart, catchEnd)}
        throw innerError;
      }
    }
    for await (const update of streamingToolExecutor.getRemainingResults()) toolResults.push(update);
    return {currentModel, routineDecision, toolResults, mainModel:toolUseContext.options.mainLoopModel};
  }
  `
  const compiled = stripTypeScriptTypes(body, { mode: 'transform' }) + '\nreturn run();'
  const iterator = new Function(...Object.keys(scope), compiled)(...Object.values(scope))
  let result: any
  for (;;) {
    const next = await iterator.next()
    if (next.done) { result = next.value; break }
    notices.push(next.value)
  }
  if (!options.steer) assert.deepEqual(currentGoal, originalGoal, 'latency recovery never changes goal authority')
  assert.equal(toolUseContext.abortController.signal.aborted, !!options.cancel, 'only operator cancellation can abort tool work')
  return { requests, notices, counts, result }
}

test('real query boundary interrupts thinking once, then performs one permitted tool without stopping autonomy', async () => {
  const run = await runBoundary()
  assert.equal(run.requests.length, 2)
  assert.match(run.requests[1].messages.at(-1).message.content, /Routine decision recovery/)
  assert.equal(run.notices.filter(n => n.type === 'tombstone').length, 1)
  assert.equal(run.counts.effects, 1)
  assert.equal(run.counts.permissionChecks, 1)
  assert.equal(run.counts.receipts, 1)
})
test('configured fallback retains runtime context and exhausted corrections release the deadline automatically', async () => {
  const fallback = await runBoundary({ fallback: 'fallback', succeedAt: 3 })
  assert.deepEqual(fallback.requests.map(r => r.options.model), ['primary', 'primary', 'fallback'])
  assert.equal(fallback.result.mainModel, 'fallback', 'existing runtime-context fallback survives tool followups')
  assert.equal(fallback.counts.effects, 1)
  const released = await runBoundary({ succeedAt: 3, slowSuccess: true })
  assert.equal(released.requests.length, 3)
  assert.equal(released.result.routineDecision.released, true)
  assert.ok(released.notices.some(n => /continuing autonomously with normal reasoning/.test(n.content ?? '')))
  const releasedFallback = await runBoundary({ fallback: 'fallback', succeedAt: 4, slowSuccess: true })
  assert.deepEqual(releasedFallback.requests.map(r => r.options.model), ['primary', 'primary', 'fallback', 'fallback'])
  assert.equal(releasedFallback.counts.effects, 1)
})
test('admitted effects outlive a model deadline and are collected once without retry', async () => {
  const run = await runBoundary({ admitBeforeTimeout: true })
  assert.equal(run.requests.length, 1)
  assert.equal(run.counts.effects, 1)
  assert.equal(run.counts.receipts, 1)
  assert.equal(run.notices.filter(n => n.type === 'tombstone').length, 0)
})
test('complex tasks and explicit opt-out retain normal continuous reasoning', async () => {
  for (const opts of [{ complex: true }, { disabled: true }]) {
    const run = await runBoundary(opts)
    assert.equal(run.requests.length, 1)
    assert.equal(run.notices.length, 0)
  }
})
test('queued work, changed authority and operator cancellation cannot revive a stale routine policy', async () => {
  const queued = await runBoundary({ queued: true })
  assert.equal(queued.requests.length, 1)
  assert.equal(queued.counts.effects, 0)
  const steered = await runBoundary({ steer: true })
  assert.equal(steered.requests.length, 2)
  assert.equal(steered.result.routineDecision, undefined)
  assert.ok(!steered.requests[1].messages.some((m: any) => /Routine decision recovery/.test(m.message.content)))
  const cancelled = await runBoundary({ cancel: true })
  assert.equal(cancelled.requests.length, 1)
  assert.equal(cancelled.counts.effects, 0)
})
