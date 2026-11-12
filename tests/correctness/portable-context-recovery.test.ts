import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableAutoGoal } from '../../src/commands/goal/auto.ts';

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
