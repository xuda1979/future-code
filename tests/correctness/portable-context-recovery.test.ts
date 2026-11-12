import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableAutoGoal, readAutoGoal, parkActiveAutoGoal, pauseAutoGoal, shouldPauseGoalAfterTerminal,
  supersedeAutoGoal, recordGoalSteering } from '../../src/commands/goal/auto.ts';

register('./portable-context-loader.mjs', import.meta.url);
const { autoCompactIfNeeded } = await import('../../src/services/compact/autoCompact.ts');

async function fixture(run: (h: any, ctx: any, cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'portable-context-'));
  const previous = process.cwd();
  const keys = ['DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT'];
  const saved = keys.map(k => process.env[k]);
  for (const k of keys) delete process.env[k];
  const h = { enabled: true, tokens: 1000, calls: [] as any[], fail: false,
    result: { summaryMessages: [{ type: 'user', message: { content: 'saved summary' } }] }, sessionResult: undefined as any };
  (globalThis as any).__portableCompact = h;
  process.chdir(cwd);
  try {
    await run(h, { options: { mainLoopModel: 'test-model', isNonInteractiveSession: false },
      abortController: new AbortController() }, cwd);
  } finally {
    process.chdir(previous);
    for (let i = 0; i < keys.length; i++) {
      if (saved[i] === undefined) delete process.env[keys[i]!]; else process.env[keys[i]!] = saved[i];
    }
    delete (globalThis as any).__portableCompact;
    rmSync(cwd, { recursive: true, force: true });
  }
}
const source = 'repl_main_thread' as any;
const compact = (messages: any[], ctx: any, tracking?: any, force = false) =>
  autoCompactIfNeeded(messages, ctx, {} as any, source, tracking, undefined, force);

test('provider overflow can force one portable compact below the estimated threshold', () => fixture(async (h, ctx, cwd) => {
  enableAutoGoal('Run and verify the experiment', cwd);
  const messages = [{ type: 'user', message: { content: 'immutable research request' } }] as any[];
  assert.equal((await compact(messages, ctx)).wasCompacted, false);
  assert.equal(h.calls.length, 0);
  const result = await compact(messages, ctx, undefined, true);
  assert.equal(result.wasCompacted, true);
  assert.equal(result.compactionResult, h.result);
  assert.equal(result.consecutiveFailures, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][3], true, 'automatic repair cannot ask an interactive summary question');
  assert.equal(h.calls[0][5], true);
}));

test('forced compact preserves opt-outs, aborts, and fork recursion guards', () => fixture(async (h, ctx) => {
  const messages = [] as any[];
  for (const enabled of [false, true]) {
    h.enabled = enabled;
    if (enabled) process.env.DISABLE_AUTO_COMPACT = '1';
    assert.equal((await compact(messages, ctx, undefined, true)).wasCompacted, false);
  }
  delete process.env.DISABLE_AUTO_COMPACT;
  for (const querySource of ['compact', 'session_memory'] as any[]) {
    assert.equal((await autoCompactIfNeeded(messages, ctx, {} as any, querySource, undefined, undefined, true)).wasCompacted, false);
  }
  process.env.DISABLE_COMPACT = '1';
  assert.equal((await compact(messages, ctx, undefined, true)).wasCompacted, false);
  delete process.env.DISABLE_COMPACT;
  ctx.abortController.abort('user-cancel');
  assert.equal((await compact(messages, ctx, undefined, true)).wasCompacted, false);
  assert.equal(h.calls.length, 0);
}));

test('failed portable repair returns its real diagnostic and obeys the existing circuit breaker', () => fixture(async (h, ctx) => {
  h.fail = true;
  let tracking: any = { compacted: false, turnCounter: 0, turnId: 'turn', consecutiveFailures: 0 };
  for (let n = 1; n <= 3; n++) {
    const result = await compact([], ctx, tracking, true);
    assert.equal(result.wasCompacted, false);
    assert.equal(result.consecutiveFailures, n);
    assert.match(result.failureReason!, /summary transport failed/);
    tracking = { ...tracking, consecutiveFailures: n };
  }
  assert.equal((await compact([], ctx, tracking, true)).wasCompacted, false);
  assert.equal(h.calls.length, 3);
}));

test('session-memory failure falls back to ordinary summarization without losing the active objective', () => fixture(async (h, ctx, cwd) => {
  enableAutoGoal('Run and verify the experiment', cwd);
  h.sessionFail = true;
  const result = await compact([], ctx, undefined, true);
  assert.equal(result.wasCompacted, true);
  assert.equal(result.compactionResult, h.result);
  assert.equal(h.calls.length, 1);
}));

test('successful session-memory recovery resets failures like ordinary compaction', () => fixture(async (h, ctx) => {
  h.sessionResult = h.result;
  const result = await compact([], ctx, { consecutiveFailures: 2 }, true);
  assert.equal(result.compactionResult, h.result);
  assert.equal(result.consecutiveFailures, 0);
  assert.equal(h.calls.length, 0);
}));

test('only at actual compaction, retire repeated host deltas while preserving human instructions and complete tool evidence', () => fixture(async (h, ctx, cwd) => {
  enableAutoGoal('Run and verify the experiment', cwd);
  const reminder = (n: number) => ({ type: 'user', isMeta: true,
    message: { content: '[Host-driven autonomous goal continuation ' + n + ']\nExecute the next useful step for the current host objective. End-turn is not completion.' } });
  const first = reminder(1), latest = reminder(2);
  const human = { ...first, isMeta: false };
  const notification = { ...first, origin: { kind: 'task-notification' } };
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'trial' }] } };
  const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'trial', content: 'measured evidence' }] } };
  const messages = [first, human, notification, call, result, latest] as any[];
  const before = structuredClone(messages);
  await compact(messages, ctx, undefined, true);
  assert.deepEqual(h.calls[0][0], [human, notification, call, result, latest]);
  assert.deepEqual(h.calls[0][2].forkContextMessages, h.calls[0][0], 'forked summary uses the same retired view');
  assert.deepEqual(messages, before, 'durable history cannot be rewritten by the request view');
}));

test('production main loop withholds recoverable overflow and calls the portable repair before parking', () => {
  const source = readFileSync(new URL('../../src/query.ts', import.meta.url), 'utf8');
  const recovery = source.indexOf('if (isWithheld413 && portableContextRecoveryEnabled)');
  const modelError = source.indexOf('if (lastMessage?.isApiErrorMessage)', recovery);
  assert.ok(recovery > 0 && modelError > recovery);
  const branch = source.slice(recovery, source.indexOf('// Check for max_output_tokens', recovery));
  assert.match(branch, /await deps\.autocompact\(/);
  assert.match(branch, /hasAttemptedReactiveCompact: true/);
  assert.match(branch, /buildPostCompactMessages/);
  assert.match(branch, /taskBudgetRemaining = Math\.max/);
  assert.match(branch, /continue/);
  assert.match(source, /portableContextRecoveryEnabled &&[\s\S]*?isPromptTooLongMessage\(message\)/);
  assert.match(source, /autoGoalTerminalDiagnostic\(terminal\.reason/);
});

// Execute the production recovery branch verbatim. Only its model/summary and
// UI boundaries are injected; host goal transitions use the real durable store.
const querySourceText = readFileSync(new URL('../../src/query.ts', import.meta.url), 'utf8');
const branchStart = querySourceText.indexOf('if (isWithheld413 && portableContextRecoveryEnabled)');
const branchEnd = querySourceText.indexOf('if ((isWithheld413 || isWithheldMedia) && reactiveCompact)', branchStart);
assert.ok(branchStart > 0 && branchEnd > branchStart);
const AsyncGenerator = Object.getPrototypeOf(async function* () {}).constructor;
const executeRecovery = new AsyncGenerator('ctx', `
  const { deps, messagesForQuery, toolUseContext, systemPrompt, userContext, systemContext, querySource,
    tracking, snipTokensFreed, params, buildPostCompactMessages, finalContextTokensFromLastResponse,
    createSystemMessage, readAutoGoal, hasMainThreadQueuedCommand, getCommandQueueSnapshot,
    lastMessage, parkGoal, autoGoalTerminalDiagnostic, modelApiFailureReason, executeStopFailureHooks,
    portableContextGoalVersion } = ctx;
  const isWithheld413 = true, portableContextRecoveryEnabled = true;
  const maxOutputTokensRecoveryCount = 0, silentResponseRecoveryCount = 0, turnCount = 1;
  let taskBudgetRemaining, state, portableContextRepairPending = false;
  for (let iteration = 0; iteration < 1; iteration++) {
    ${querySourceText.slice(branchStart, branchEnd)}
  }
  return { reason: 'test-observed-retry', state, taskBudgetRemaining, portableContextRepairPending };
`);

for (const success of [false, true]) {
  for (const handoff of ['interrupt', 'user-cancel', 'queued', 'pause', 'supersede', 'steer', 'none']) {
    test('portable repair reconciles ' + handoff + ' after ' + (success ? 'success' : 'failure'), () => fixture(async (_h, ctx, cwd) => {
      enableAutoGoal('Original experiment', cwd, 4);
      const initial = readAutoGoal(cwd)!;
      const summary = { type: 'user', message: { content: 'durable summary' } };
      let parked = 0;
      const injection = {
        deps: { autocompact: async () => {
          if (handoff === 'interrupt' || handoff === 'user-cancel') ctx.abortController.abort(handoff);
          if (handoff === 'pause') pauseAutoGoal(cwd);
          if (handoff === 'supersede') supersedeAutoGoal('New experiment', cwd);
          if (handoff === 'steer') recordGoalSteering('Use the new instrument', cwd);
          return success ? { compactionResult: { summaryMessages: [summary] } } : { failureReason: 'summary unavailable' };
        } },
        messagesForQuery: [{ type: 'user', message: { content: 'original request' } }], toolUseContext: ctx,
        systemPrompt: [], userContext: {}, systemContext: {}, querySource: source, tracking: undefined,
        snipTokensFreed: 0, params: { taskBudget: { total: 100 } },
        buildPostCompactMessages: (result: any) => result.summaryMessages,
        finalContextTokensFromLastResponse: () => 20,
        createSystemMessage: (content: string) => ({ type: 'system', content }),
        readAutoGoal: () => readAutoGoal(cwd),
        hasMainThreadQueuedCommand: () => handoff === 'queued',
        getCommandQueueSnapshot: () => [],
        lastMessage: { type: 'assistant', isApiErrorMessage: true },
        parkGoal: (reason: string) => { parked++; return parkActiveAutoGoal(reason, cwd); },
        autoGoalTerminalDiagnostic: (_reason: string, detail: string) => detail,
        modelApiFailureReason: () => 'HTTP 413: real provider context limit',
        executeStopFailureHooks: () => {},
        portableContextGoalVersion: JSON.stringify([initial.goal, initial.revision ?? 1, initial.activeSteering ?? []]),
      };
      const yielded: any[] = [];
      const generator = executeRecovery(injection);
      let end: any;
      for (;;) { const result = await generator.next(); if (result.done) { end = result.value; break; } yielded.push(result.value); }
      if (handoff === 'interrupt' || handoff === 'user-cancel') {
        assert.equal(end.reason, 'aborted_streaming');
        assert.equal(parked, 0, 'old overflow must not park before cancellation semantics are applied');
        if (shouldPauseGoalAfterTerminal(end.reason, ctx.abortController.signal.reason)) parkActiveAutoGoal('operator cancellation', cwd);
        assert.equal(readAutoGoal(cwd)!.state, handoff === 'interrupt' ? 'ACTIVE' : 'PAUSED');
      } else if (handoff !== 'none') {
        assert.equal(end.reason, 'completed');
        assert.equal(parked, 0, 'old overflow cannot pause a new instruction or queued handoff');
        assert.equal(readAutoGoal(cwd)!.state, handoff === 'pause' ? 'PAUSED' : 'ACTIVE');
      } else if (success) {
        assert.equal(end.reason, 'test-observed-retry');
        assert.equal(end.state.hasAttemptedReactiveCompact, true);
        assert.equal(end.taskBudgetRemaining, 80);
        assert.deepEqual(end.state.messages, [summary]);
        assert.equal(parked, 0);
        assert.equal(readAutoGoal(cwd)!.state, 'ACTIVE');
      } else {
        assert.equal(end.reason, 'prompt_too_long');
        assert.equal(parked, 1);
        assert.match(readAutoGoal(cwd)!.reason!, /HTTP 413.*Compaction: summary unavailable/);
      }
      if (success) assert.ok(yielded.includes(summary), 'saved compact boundary/summary is always delivered');
      assert.equal(readAutoGoal(cwd)!.maxContinuations, 4);
      assert.equal(readAutoGoal(cwd)!.totalContinuations, 0);
    }));
  }
}
