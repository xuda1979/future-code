// Execute the actual production REPL callbacks with isolated UI/SDK services.
// This snapshot cannot load the entire packaged CLI's internal dependencies.
// Callback bodies are read from source, never copied into the test fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QueryGuard } from '../../src/utils/QueryGuard.ts'
import { QueryActivityMonitor, formatQueryActivity } from '../../src/utils/queryActivity.ts'
import { isHumanTurn } from '../../src/utils/messagePredicates.ts'
import { DeferredHookGate, waitForForegroundPreparation } from '../../src/utils/foregroundPreparation.ts'
import { autoGoalReportPath, decideAutoGoalContinuation, enableAutoGoal, parkActiveAutoGoal, readAutoGoal, resumeAutoGoalFromInput } from '../../src/commands/goal/auto.ts'
import { runWithAutoGoalSession } from '../../src/utils/autoGoalSession.ts'
import { trustedGoalInputs } from '../../src/commands/goal/input.ts'
import { configureAutoGoalSession, getAutoGoalSessionId } from '../../src/utils/autoGoalSession.ts'
import { runWithWorkload, WORKLOAD_CRON, getWorkload } from '../../src/utils/workloadContext.ts'

const source = readFileSync(new URL('../../src/screens/REPL.tsx', import.meta.url), 'utf8')
const noop = () => {}
function callback(name: string, nextMarker: string, scope: Record<string, unknown>): (...args: any[]) => Promise<void> {
  const start = source.indexOf(`  const ${name} = useCallback(`)
  assert.ok(start >= 0, `${name} must exist in production source`)
  const end = source.indexOf(nextMarker, start)
  assert.ok(end > start)
  const block = source.slice(start, end).trim()
  const match = /^const \w+ = useCallback\(([\s\S]*), \[[^\]]*\]\);$/.exec(block)
  assert.ok(match, `extract exactly one ${name} callback`)
  const body = stripTypeScriptTypes(`const invoke = (${match[1]});`, { mode: 'transform' })
  return new Function(...Object.keys(scope), `${body}\nreturn invoke;`)(...Object.values(scope))
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'repl-liveness-'))
  const guard = new QueryGuard(), messagesRef = { current: [] as any[] }, errors: unknown[] = []
  const state = { mcp: { clients: [] }, toolPermissionContext: { alwaysAllowRules: { command: [] } } }
  let modelCalls = 0, currentController: AbortController | null = null
  const setMessages = (update: (messages: any[]) => any[]) => { messagesRef.current = update(messagesRef.current) }
  const scope: Record<string, any> = {
    runWithAutoGoalSession, commands: [{ name: 'loop', type: 'prompt', source: 'builtin' }],
    findCommand: (name: string, commands: any[]) => commands.find(command => command.name === name),
    isAgentSwarmsEnabled: () => false, queryGuard: guard, QueryActivityMonitor, formatQueryActivity,
    queryActivityRef: { current: null }, setQueryActivityStatus: noop, resetTimingRefs: noop,
    setMessages, messagesRef, responseLengthRef: { current: 0 }, apiMetricsRef: { current: [] },
    feature: () => false, setStreamingToolUses: noop, setStreamingText: noop, isHumanTurn,
    resumeAutoGoalFromInput: (input: string, options: any) => resumeAutoGoalFromInput(input, { ...options, cwd: dir }),
    createUserMessage: (input: any) => ({ type: 'user', isMeta: input.isMeta, message: { content: input.content } }),
    awaitPendingHooks: async () => {}, mrOnBeforeQuery: async () => true, mrOnTurnComplete: async () => {},
    parkActiveAutoGoal: (reason: string) => parkActiveAutoGoal(reason, dir),
    reportRequestError: (error: unknown) => { errors.push(error); messagesRef.current.push({ type: 'system', error: String(error) }) },
    errorMessage: (error: any) => error?.message ?? String(error), setLastQueryCompletionTime: noop,
    skipIdleCheckRef: { current: false }, resetLoadingState: noop, sendBridgeResultRef: { current: noop },
    setAppState: (update: (state: any) => any) => update(state),
    loadingStartTimeRef: { current: Date.now() }, totalPausedMsRef: { current: 0 }, proactiveActive: false,
    setAbortController: (controller: AbortController | null) => { currentController = controller },
    logEvent: noop, enqueue: noop, getContentText: (content: unknown) => content,
    store: { getState: () => state, setState: (update: (state: any) => any) => Object.assign(state, update(state)) },
    initialMcpClients: [], mergeClients: () => [],
    diagnosticTracker: { handleQueryStart: noop }, getConnectedIdeClient: () => undefined,
    maybeMarkProjectOnboardingComplete: noop, titleDisabled: true, toolPermissionContext: { additionalWorkingDirectories: new Map() },
    getToolUseContext: () => ({ options: { tools: [], mcpClients: [] } }), queryCheckpoint: noop,
    checkAndDisableBypassPermissionsIfNeeded: async () => {},
    waitForForegroundPreparation: (phase: string, start: () => Promise<any>, options: any) =>
      waitForForegroundPreparation(phase, start, { ...options, timeoutMs: 20 }),
    getSystemPrompt: async () => [], getUserContext: async () => ({}), getSystemContext: async () => ({}),
    getCoordinatorUserContext: () => ({}), isScratchpadEnabled: () => false,
    buildEffectiveSystemPrompt: () => [], mainThreadAgentDefinition: undefined, customSystemPrompt: undefined,
    appendSystemPrompt: undefined, resetTurnHookDuration: noop, resetTurnToolDuration: noop,
    resetTurnClassifierDuration: noop, canUseTool: noop, getQuerySourceForREPL: () => 'repl_main_thread',
    query: async function* () { modelCalls++; yield { type: 'assistant', message: { content: 'working' } } },
    onQueryEvent: noop, logQueryProfileReport: noop, onTurnComplete: async () => {},
  }
  const build = () => {
    scope.onQueryImpl = callback('onQueryImpl', '  const onQuery = useCallback(', scope)
    return callback('onQuery', '  // Handle initial message', scope)
  }
  return { dir, scope, guard, messagesRef, errors, setMessages, build,
    calls: () => modelCalls, controller: () => currentController,
    close: () => { guard.forceEnd(); rmSync(dir, { recursive: true, force: true }) } }
}
const human = (content = 'continue') => ({ type: 'user', message: { content } })

function inputExecutor(scope: Record<string, unknown>): (params: any) => Promise<void> {
  scope = { runWithAutoGoalSession, runWithWorkload, trustedGoalInputs, ...scope }
  const inputSource = readFileSync(new URL('../../src/utils/handlePromptSubmit.ts', import.meta.url), 'utf8')
  const start = inputSource.indexOf('async function executeUserInput(')
  assert.ok(start >= 0)
  const body = stripTypeScriptTypes(inputSource.slice(start), { mode: 'transform' })
  return new Function(...Object.keys(scope), `${body}\nreturn executeUserInput;`)(...Object.values(scope))
}

test('real REPL echoes a continue, reports a hung startup hook, and resumes the same goal after recovery', async () => {
  const f = fixture()
  try {
    enableAutoGoal('Complete verified work', f.dir)
    let finish!: (messages: any[]) => void
    const gate = new DeferredHookGate(new Promise<any[]>(resolve => { finish = resolve }))
    f.scope.awaitPendingHooks = (signal: AbortSignal) => gate.wait(messages => f.setMessages(old => [...messages, ...old]),
      { signal, timeoutMs: 20 })
    const run = f.build()
    await assert.rejects(run([human()], new AbortController(), true, [], 'fixture-model', undefined, 'continue'), /SessionStart hooks/)
    assert.equal(f.calls(), 0)
    assert.equal(f.messagesRef.current[0].type, 'user', 'echo must precede hook waiting')
    assert.match(String(f.errors[0]), /SessionStart hooks/)
    assert.equal(f.guard.isActive, false)
    assert.equal(readAutoGoal(f.dir)?.state, 'PAUSED')
    finish([{ type: 'system', context: 'required startup context' }])
    await run([human()], new AbortController(), true, [], 'fixture-model', undefined, 'continue')
    assert.equal(f.calls(), 1)
    assert.equal(readAutoGoal(f.dir)?.state, 'ACTIVE')
    assert.equal(f.messagesRef.current.filter(m => m.context).length, 1)
    assert.ok(f.messagesRef.current.some(m => m.isMeta && m.message.content.includes('Resume the durable goal')))
    assert.equal(f.guard.isActive, false)
  } finally { f.close() }
})

test('real REPL finishes cleanup despite hanging completion observers', async () => {
  const f = fixture()
  try {
    f.scope.mrOnTurnComplete = () => new Promise<void>(() => {})
    f.scope.onTurnComplete = () => new Promise<void>(() => {})
    const run = f.build()
    for (let i = 0; i < 2; i++) {
      await run([human()], new AbortController(), true, [], 'fixture-model', undefined, 'continue')
      assert.equal(f.guard.isActive, false)
      assert.equal(f.controller(), null)
    }
    assert.equal(f.calls(), 2)
    assert.deepEqual(f.errors, [])
  } finally { f.close() }
})

test('real REPL surfaces a context deadline before calling the model', async () => {
  const f = fixture()
  try {
    f.scope.getSystemContext = () => new Promise(() => {})
    await assert.rejects(f.build()([human()], new AbortController(), true, [], 'fixture-model', undefined, 'continue'),
      /system\/user context loading/)
    assert.equal(f.calls(), 0)
    assert.match(String(f.errors[0]), /Request preparation stalled/)
    assert.equal(f.guard.isActive, false)
  } finally { f.close() }
})

test('task notifications cannot rearm a paused root goal through the real REPL callback', async () => {
  const f = fixture()
  try {
    enableAutoGoal('Remain paused', f.dir)
    parkActiveAutoGoal('operator pause', f.dir)
    const notification = { ...human(), origin: { kind: 'task-notification' } }
    await f.build()([notification], new AbortController(), true, [], 'fixture-model', undefined, 'continue')
    assert.equal(readAutoGoal(f.dir)?.state, 'PAUSED')
  } finally { f.close() }
})

test('a before-query callback cannot silently discard a human continue', async () => {
  const f = fixture()
  try {
    enableAutoGoal('Finish work', f.dir)
    await f.build()([human()], new AbortController(), true, [], 'fixture-model', async () => false, 'continue')
    assert.equal(f.calls(), 0)
    assert.match(String(f.errors[0]), /stopped by onBeforeQuery/)
    assert.equal(readAutoGoal(f.dir)?.state, 'PAUSED')
    assert.equal(f.guard.isActive, false)
  } finally { f.close() }
})

test('real input dispatch owns startup preparation before UserPromptSubmit and a stale finally cannot unlock a new input', async () => {
  const guard = new QueryGuard(), order: string[] = []
  let controller!: AbortController, finish!: () => void, placeholderClears = 0, queryCalls = 0
  const execute = inputExecutor({
    createAbortController: () => new AbortController(), queryCheckpoint: noop,
    runWithWorkload: (_: unknown, run: () => Promise<void>) => run(),
    processUserInput: async () => { order.push('prompt-hook'); return { messages: [human()], shouldQuery: true } },
    fileHistoryEnabled: () => false, isAutoGoalMainThread: () => false,
    errorMessage: String,
  })
  const params = {
    queryGuard: guard, messages: [], mainLoopModel: 'fixture-model', queuedCommands: [{ value: 'continue', mode: 'prompt' }],
    setAbortController: (value: AbortController) => { controller = value },
    setUserInputOnProcessing: () => { placeholderClears++ },
    prepareForInput: () => new Promise<void>(resolve => { order.push('startup-hook'); finish = resolve }),
    getToolUseContext: () => ({}), setToolJSX: noop, resetHistory: noop,
    onQuery: async () => { queryCalls++ },
  }
  const old = execute(params)
  assert.equal(guard.isActive, true, 'reservation must precede the first hook wait')
  assert.deepEqual(order, ['startup-hook'])
  controller.abort(new Error('operator pause'))
  guard.forceEnd()
  guard.reserve() // a newer input is now preparing
  const newEpoch = guard.epoch
  finish() // non-cooperative old hook finally returns
  await assert.rejects(old, /operator pause/)
  assert.equal(guard.epoch, newEpoch)
  assert.equal(guard.isActive, true, 'old cancellation cannot release the new reservation')
  assert.equal(placeholderClears, 0, 'old finally cannot erase the new input placeholder')
  assert.equal(queryCalls, 0)
  assert.deepEqual(order, ['startup-hook'], 'a cancelled startup cannot launch a prompt hook or tool')
  guard.forceEnd()
})

test('failed startup preparation releases the real input reservation and stale controller', async () => {
  const guard = new QueryGuard()
  let controller: AbortController | null = null, placeholderClears = 0
  const execute = inputExecutor({ createAbortController: () => new AbortController(),
    isAutoGoalMainThread: () => false, errorMessage: String })
  await assert.rejects(execute({ queryGuard: guard, setAbortController: (value: AbortController | null) => { controller = value },
    prepareForInput: async () => { throw new Error('startup dependency failed') },
    setUserInputOnProcessing: () => { placeholderClears++ },
  }), /startup dependency failed/)
  assert.equal(guard.isActive, false)
  assert.equal(controller, null)
  assert.equal(placeholderClears, 1)
})

test('new human input clears inherited cron scope before startup failure parking', async () => {
  const f = fixture()
  let selected = 'old-session'
  configureAutoGoalSession(() => selected)
  try {
    enableAutoGoal('Old session objective', f.dir)
    const execute = inputExecutor({ createAbortController: () => new AbortController(), runWithWorkload,
      isAutoGoalMainThread: (source: string) => source === 'repl_main_thread', errorMessage: String,
      parkActiveAutoGoal: (reason: string) => parkActiveAutoGoal(reason, f.dir) })
    await runWithAutoGoalSession(async () => {
      selected = 'new-session'
      runWithAutoGoalSession(() => enableAutoGoal('New session objective', f.dir), true)
      await runWithWorkload(WORKLOAD_CRON, async () => {
        await assert.rejects(execute({ queryGuard: f.guard, querySource: 'repl_main_thread',
          queuedCommands: [{ mode: 'prompt', value: 'continue' }], setAbortController: noop,
          setUserInputOnProcessing: noop, prepareForInput: async () => {
            assert.equal(getWorkload(), undefined)
            assert.equal(getAutoGoalSessionId(), 'new-session')
            throw new Error('human startup failed')
          } }), /human startup failed/)
      })
      assert.equal(readAutoGoal(f.dir)?.state, 'ACTIVE', 'outgoing session is unaffected')
    })
    assert.equal(readAutoGoal(f.dir)?.state, 'PAUSED')
    assert.match(readAutoGoal(f.dir)!.reason!, /human startup failed/)
  } finally { configureAutoGoalSession(undefined); f.close() }
})

test('actual queue batching separates scheduled ticks from unrelated human status questions', async () => {
  const source = readFileSync(new URL('../../src/utils/queueProcessor.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('type ProcessQueueParams'))
    .replace(/export function /g, 'function '), { mode: 'transform' })
  for (const cronFirst of [true, false]) {
    const human = { mode: 'prompt', value: 'What is the status?' }, cron = { mode: 'prompt', value: 'monitor saved task',
      workload: WORKLOAD_CRON, isMeta: true }
    let pending = cronFirst ? [cron, human] : [human, cron]
    const calls: any[][] = []
    const scope = { peek: (match: (value: any) => boolean) => pending.find(match),
      dequeue: (match: (value: any) => boolean) => pending.splice(pending.findIndex(match), 1)[0],
      dequeueAllMatching: (match: (value: any) => boolean) => {
        const batch = pending.filter(match); pending = pending.filter(value => !match(value)); return batch
      }, hasCommandsInQueue: () => pending.length > 0 }
    const process = new Function(...Object.keys(scope), `${code}\nreturn processQueueIfReady;`)(...Object.values(scope))
    const executeInput = async (batch: any[]) => { calls.push(batch) }
    assert.equal(process({ executeInput }).processed, true)
    assert.equal(pending.length, 1)
    assert.equal(process({ executeInput }).processed, true)
    assert.deepEqual(calls, cronFirst ? [[cron], [human]] : [[human], [cron]])
    assert.equal(pending.length, 0)
  }
})

test('real REPL updates the active objective when user provides a new objective and prevents drifting to the old objective', async () => {
  const f = fixture()
  try {
    enableAutoGoal('Old objective: legacy module cleanup', f.dir)
    const run = f.build()
    const newObjectiveMsg = { type: 'user', message: { content: 'New objective: implement autonomous drift guard and send a PR' } }
    await run([newObjectiveMsg], new AbortController(), true, [], 'fixture-model', undefined, 'New objective: implement autonomous drift guard and send a PR')
    assert.equal(f.calls(), 1)
    const current = readAutoGoal(f.dir)!
    assert.equal(current.state, 'ACTIVE')
    assert.equal(current.goal, 'implement autonomous drift guard and send a PR')
    assert.equal(current.previousGoal, 'Old objective: legacy module cleanup')
    assert.equal(current.revision, 2)
    assert.ok(f.messagesRef.current.some(m => m.isMeta && m.message.content.includes('Active objective updated to: implement autonomous drift guard and send a PR')))
    assert.ok(f.messagesRef.current.some(m => m.isMeta && m.message.content.includes('supersedes previous objective: Old objective: legacy module cleanup')))
  } finally { f.close() }
})

test('the real input-to-REPL path replaces stale REVIEW with the typed monitoring loop', async () => {
  const f = fixture()
  try {
    enableAutoGoal('test arg', f.dir)
    writeFileSync(autoGoalReportPath(f.dir), '# test arg\nStatus: completed\n')
    decideAutoGoalContinuation({ cwd: f.dir, mainThread: true, withinTurnBudget: true })
    assert.equal(readAutoGoal(f.dir)?.state, 'REVIEW')
    const loop = '/loop continue: monitor quantum-gpt and all sessions; improve, test, build, commit, push and resume'
    const execute = inputExecutor({
      createAbortController: () => new AbortController(), queryCheckpoint: noop,
      runWithWorkload: (_: unknown, run: () => Promise<void>) => run(),
      processUserInput: async () => ({ messages: [human('<command-name>/loop</command-name>'),
        { ...human('expanded loop task'), isMeta: true }], shouldQuery: true }),
      fileHistoryEnabled: () => false, isAutoGoalMainThread: () => false, errorMessage: String,
    })
    await execute({ queryGuard: f.guard, messages: [], mainLoopModel: 'fixture-model',
      queuedCommands: [{ value: loop, mode: 'prompt' }], setAbortController: noop,
      setUserInputOnProcessing: noop, getToolUseContext: () => ({}), setToolJSX: noop,
      resetHistory: noop, onQuery: f.build() })
    assert.equal(f.calls(), 1)
    assert.equal(readAutoGoal(f.dir)?.goal, loop)
    assert.equal(readAutoGoal(f.dir)?.state, 'ACTIVE')
    assert.equal(readAutoGoal(f.dir)?.loop?.kind, 'continuous')
  } finally { f.close() }
})

for (const mode of ['scheduled', 'mixed', 'blocked-human'] as const) {
  test('real input provenance after slash expansion: ' + mode, async () => {
    const f = fixture()
    try {
      enableAutoGoal('Paused operator experiment', f.dir)
      parkActiveAutoGoal('operator pause', f.dir)
      const scheduled = { value: '/loop inspect scheduled job', mode: 'prompt', isMeta: true }
      const requested = '/loop monitor quantum-gpt and improve all future-code sessions'
      const commands = mode === 'scheduled' ? [scheduled] : [scheduled, { value: requested, mode: 'prompt' }]
      const execute = inputExecutor({
        createAbortController: () => new AbortController(), queryCheckpoint: noop,
        runWithWorkload: (_: unknown, run: () => Promise<void>) => run(),
        processUserInput: async ({ input }: { input: string }) => ({ messages: [human('visible slash metadata')],
          shouldQuery: !(mode === 'blocked-human' && input === requested) }),
        fileHistoryEnabled: () => false, isAutoGoalMainThread: () => false, errorMessage: String,
      })
      await execute({ queryGuard: f.guard, messages: [], mainLoopModel: 'fixture-model', queuedCommands: commands,
        setAbortController: noop, setUserInputOnProcessing: noop, getToolUseContext: () => ({}),
        setToolJSX: noop, resetHistory: noop, onQuery: f.build() })
      assert.equal(f.calls(), 1)
      assert.equal(readAutoGoal(f.dir)?.goal, mode === 'mixed' ? requested : 'Paused operator experiment')
      assert.equal(readAutoGoal(f.dir)?.state, mode === 'mixed' ? 'ACTIVE' : 'PAUSED')
    } finally { f.close() }
  })
}
