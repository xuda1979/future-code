import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { countFileReadTokens, FILE_READ_TOKEN_COUNT_TIMEOUT_MS } from '../../src/tools/FileReadTool/tokenBudget.ts';

test('small and exact-byte-boundary reads remain entirely local', async () => {
  let calls = 0;
  const count = async () => { calls++; return 1; };
  assert.equal(await countFileReadTokens('', 10, count), 0);
  assert.equal(await countFileReadTokens('1234567890', 10, count), 10);
  assert.equal(await countFileReadTokens('中🙂', 7, count), 7);
  assert.equal(calls, 0);
});

test('healthy exact counts preserve token-budget boundaries and clean listeners', async () => {
  const controller = new AbortController();
  let child!: AbortSignal;
  assert.equal(await countFileReadTokens('x'.repeat(30), 10, async (_content, options) => {
    child = options.signal;
    return 10;
  }, controller.signal), 10);
  assert.equal(child.aborted, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(await countFileReadTokens('x'.repeat(30), 10, async () => 11), 11);
});

test('unavailable and invalid counters retain the conservative UTF8 bound', async () => {
  for (const content of ['中'.repeat(20), '{"a":1},'.repeat(10)]) {
    for (const invalid of [null, NaN, Infinity, -1, 0, 1.5, '1']) {
      assert.equal(await countFileReadTokens(content, 10, async () => invalid as any), Buffer.byteLength(content));
    }
  }
});

test('synchronous throws and asynchronous rejections cannot bypass the token guard', async () => {
  const content = '中'.repeat(20);
  assert.equal(await countFileReadTokens(content, 10, () => { throw new Error('counter unavailable'); }), 60);
  assert.equal(await countFileReadTokens(content, 10, async () => { throw new Error('counter unavailable'); }), 60);
});

test('a hanging counter has a one-second deadline and receives transport abort', { timeout: 2500 }, async () => {
  assert.equal(FILE_READ_TOKEN_COUNT_TIMEOUT_MS, 1000);
  const controller = new AbortController();
  let child!: AbortSignal;
  const started = performance.now();
  assert.equal(await countFileReadTokens('x'.repeat(30), 10, async (_content, options) => {
    child = options.signal;
    return new Promise(() => {});
  }, controller.signal), 30);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 2000, `elapsed ${elapsed}`);
  assert.equal(child.aborted, true);
  assert.equal(controller.signal.aborted, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('caller cancellation releases a hung counter promptly and clears listeners', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let child!: AbortSignal;
  const reason = new Error('operator cancelled the file read');
  const count = countFileReadTokens('x'.repeat(30), 10, async (_content, options) => {
    child = options.signal;
    return new Promise(() => {});
  }, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(count, error => error === reason);
  assert.equal(child.aborted, true);
  assert.equal(child.reason, reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('pre-cancellation starts no counter even for a local read', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  let calls = 0;
  for (const text of ['x', 'x'.repeat(30)]) {
    await assert.rejects(countFileReadTokens(text, 10, async () => { calls++; return 1; }, controller.signal), /already cancelled/);
  }
  assert.equal(calls, 0);
});

test('late counter rejection is observed after caller cancellation', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let rejectLate!: (reason: unknown) => void;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const count = countFileReadTokens('x'.repeat(30), 10, () => new Promise((_resolve, reject) => { rejectLate = reject; }), controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error('cancel'));
    await assert.rejects(count, /cancel/);
    rejectLate(new Error('late SDK rejection'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('late counter rejection after timeout cannot change the bound or become unhandled', { timeout: 2500 }, async () => {
  let rejectLate!: (reason: unknown) => void;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const count = countFileReadTokens('x'.repeat(30), 10,
      () => new Promise((_resolve, reject) => { rejectLate = reject; }));
    assert.equal(await count, 30);
    rejectLate(new Error('late SDK rejection'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('actual FileRead validation uses the bounded counter and preserves an explicit range error', async () => {
  const source = readFileSync(new URL('../../src/tools/FileReadTool/FileReadTool.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function validateContentTokens('), source.indexOf('\ntype ImageResult ='));
  class BudgetError extends Error {}
  const build = new Function('countFileReadTokens', 'countTokensWithAPI', 'MaxFileReadTokenExceededError', 'getDefaultFileReadingLimits',
    stripTypeScriptTypes(body, { mode: 'transform' }) + '; return validateContentTokens;');
  const validate = build(countFileReadTokens, async () => null, BudgetError, () => ({ maxTokens: 10 }));
  await validate('1234567890', 10);
  await assert.rejects(validate('中'.repeat(20), 10), BudgetError);
  assert.match(source, /validateContentTokens\(cellsJson, maxTokens, context\.abortController\.signal\)/);
  assert.match(source, /validateContentTokens\(content, maxTokens, context\.abortController\.signal\)/);
  assert.match(source, /measured count or conservative UTF-8 byte bound/);
});
