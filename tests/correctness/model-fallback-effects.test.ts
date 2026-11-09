import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendGoalRequestAnchor } from '../../src/commands/goal/context.ts';
import { enableAutoGoal } from '../../src/commands/goal/auto.ts';

// Execute production recovery decisions with an instrumented stream/executor.
// The real executor's tool lifetimes, errors and ordering have separate tests.
const source = readFileSync(new URL('../../src/query.ts', import.meta.url), 'utf8');
const streamingStart = source.indexOf('            if (streamingFallbackOccured) {');
const streamingEnd = source.indexOf('            // Backfill tool_use', streamingStart);
const catchStart = source.indexOf('          if (innerError instanceof FallbackTriggeredError && fallbackModel) {');
const catchEnd = source.indexOf('          throw innerError', catchStart);
assert.ok(streamingStart > 0 && streamingEnd > streamingStart && catchStart > 0 && catchEnd > catchStart);
const streamingBlock = source.slice(streamingStart, streamingEnd);
const catchBlock = source.slice(catchStart, catchEnd);
class FallbackTriggeredError extends Error {
  originalModel = 'primary'; fallbackModel = 'fallback';
}
const meta = (value: any) => ({ type: 'user', isMeta: value.isMeta, message: { content: value.content } });

async function recover(mode: 'streaming' | 'catch', admitted: boolean, options: { ant?: boolean; ordinary?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'model-fallback-'));
  enableAutoGoal('Preserve the actual task outcome', cwd);
  const oldUserType = process.env.USER_TYPE;
  if (options.ant) process.env.USER_TYPE = 'ant'; else delete process.env.USER_TYPE;
  const counters = { discards: 0, creations: 0, accepted: [] as string[] };
  class Executor {
    constructor(..._args: unknown[]) { counters.creations++; }
    discard() { counters.discards++; }
  }
  const state = {
    assistantMessages: admitted ? [{ type: 'assistant', uuid: 'original', message: { content: [{ type: 'tool_use', id: 'effect' }] } }] : [],
    toolUseBlocks: admitted ? [{ id: 'effect', name: 'Write' }] : [],
    toolResults: admitted ? ['existing receipt'] : [],
    messagesForQuery: [{ type: 'user', message: { content: 'original signed history' } }],
    goalRequestMessages: [{ type: 'user', message: { content: 'original signed history' } }],
    streamingToolExecutor: new Executor(),
    toolUseContext: { options: { tools: [], mainLoopModel: 'primary' }, abortController: new AbortController() },
    innerError: options.ordinary ? new Error('provider transport failed') : new FallbackTriggeredError('switch requested'),
  };
  const scope = {
    state, counters, StreamingToolExecutor: Executor, FallbackTriggeredError,
    logEvent: () => {}, renderModelName: (value: string) => value,
    createSystemMessage: (content: string) => ({ type: 'system', content }), createUserMessage: meta,
    stripSignatureBlocks: (messages: any[]) => messages.map(message => ({ ...message, stripped: true })),
    appendGoalRequestAnchor: (messages: any[], opts: any) => appendGoalRequestAnchor(messages, { ...opts, cwd }),
    yieldMissingToolResultBlocks: async function* () {},
  };
  const block = mode === 'streaming' ? streamingBlock : catchBlock + '\nthrow innerError;';
  const body = `async function* run() {
    let { assistantMessages, toolUseBlocks, toolResults, messagesForQuery, goalRequestMessages,
      streamingToolExecutor, toolUseContext, innerError } = state;
    let streamingFallbackOccured = true, needsFollowUp = toolUseBlocks.length > 0;
    let currentModel = 'primary', attemptWithFallback = false;
    const fallbackModel = 'fallback', mainGoalThread = true, autoGoalPolicy = 'fixed policy', canUseTool = () => {};
    const queryChainIdForAnalytics = 'query', queryTracking = { depth: 0 };
    const chunks = ${mode === 'streaming' ? "['fallback-tool', 'fallback-text', 'fallback-final']" : "['catch']"};
    for (const chunk of chunks) {
      ${block}
      counters.accepted.push(chunk);
      if (chunk === 'fallback-tool') toolUseBlocks.push({id:'new-effect'});
      assistantMessages.push({type:'assistant', uuid:chunk});
    }
    return { assistantMessages, toolUseBlocks, toolResults, messagesForQuery, goalRequestMessages,
      streamingFallbackOccured, needsFollowUp, currentModel, attemptWithFallback };
  }`;
  try {
    const compiled = stripTypeScriptTypes(body, { mode: 'transform' }) + '\nreturn run();';
    const iterator = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
    const emitted = [];
    for (;;) {
      const item = await iterator.next();
      if (item.done) return { ...item.value, emitted, counters };
      emitted.push(item.value);
    }
  } finally {
    if (oldUserType === undefined) delete process.env.USER_TYPE; else process.env.USER_TYPE = oldUserType;
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('one streaming fallback resets an empty attempt once, not on every subsequent chunk', async () => {
  const result = await recover('streaming', false);
  assert.equal(result.counters.discards, 1); assert.equal(result.counters.creations, 2);
  assert.deepEqual(result.counters.accepted, ['fallback-tool', 'fallback-text', 'fallback-final']);
  assert.equal(result.toolUseBlocks[0].id, 'new-effect');
  assert.equal(result.streamingFallbackOccured, false);
});

for (const mode of ['streaming', 'catch'] as const) {
  test(`${mode} fallback preserves admitted calls, receipts and executor for collection`, async () => {
    const result = await recover(mode, true);
    assert.equal(result.counters.discards, 0); assert.equal(result.counters.creations, 1);
    assert.deepEqual(result.counters.accepted, []);
    assert.equal(result.toolUseBlocks[0].id, 'effect');
    assert.deepEqual(result.toolResults, ['existing receipt']);
    assert.equal(result.assistantMessages[0].uuid, 'original');
    assert.ok(!result.emitted.some((message: any) => message.type === 'tombstone'));
    assert.match(result.emitted[0].content, /collecting actual/);
    assert.equal(result.attemptWithFallback, false);
  });
}

test('ordinary provider errors collect admitted effects instead of fabricating missing receipts', async () => {
  const result = await recover('catch', true, { ordinary: true });
  assert.equal(result.counters.discards, 0); assert.equal(result.toolUseBlocks[0].id, 'effect');
  assert.match(result.emitted[0].content, /provider transport failed.*collecting actual/);
});

test('a provider error before tool admission still propagates to normal error handling', async () => {
  await assert.rejects(recover('catch', false, { ordinary: true }), /provider transport failed/);
});

test('signature sanitization rebuilds the retry payload and retains the fresh objective anchor', async () => {
  const result = await recover('catch', false, { ant: true });
  assert.equal(result.currentModel, 'fallback'); assert.equal(result.attemptWithFallback, true);
  assert.ok(result.messagesForQuery[0].stripped);
  assert.ok(result.goalRequestMessages.some((message: any) => message.stripped));
  assert.match(result.goalRequestMessages.at(-1).message.content, /Preserve the actual task outcome/);
});
