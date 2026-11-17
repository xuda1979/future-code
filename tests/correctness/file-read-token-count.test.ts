import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { countFileReadTokens } from '../../src/tools/FileReadTool/tokenBudget.ts';
register('./file-read-token-count-loader.mjs', import.meta.url);
const { countTokensWithAPI } = await import('../../src/services/tokenEstimation.ts');

function state(provider = 'firstParty') {
  const calls: any[] = [];
  const errors: unknown[] = [];
  const client = {
    beta: { messages: { countTokens: async (...args: any[]) => { calls.push(args); return { input_tokens: 42 }; } } },
    send: async (...args: any[]) => { calls.push(args); return { inputTokens: 42 }; },
  };
  const value = { provider, calls, errors, foundation: true, metadataCalls: 0, initializations: 0,
    init: async () => { value.initializations++; return client; } };
  (globalThis as any).__fileReadTokenCountTest = value;
  return { value, client, calls, errors };
}

test('optional token-count signal reaches the SDK request', async () => {
  const f = state();
  const controller = new AbortController();
  assert.equal(await countTokensWithAPI('local file', { signal: controller.signal }), 42);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]![1]?.signal, controller.signal);
});

test('optional token-count signal reaches Bedrock transport', async () => {
  const f = state('bedrock');
  const controller = new AbortController();
  assert.equal(await countTokensWithAPI('local file', { signal: controller.signal }), 42);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]![1]?.abortSignal, controller.signal);
});

for (const provider of ['firstParty', 'bedrock']) {
  test(`cancelled ${provider} initialization cannot later start a token RPC`, async () => {
    const f = state(provider);
    let release!: (client: any) => void;
    f.value.init = () => new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    const count = countTokensWithAPI('local file', { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error('deadline reached'));
    release(f.client);
    assert.equal(await count, null);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.errors, []);
  });

  test(`a bounded read releases hung ${provider} initialization and prevents its late RPC`, { timeout: 2500 }, async () => {
    const f = state(provider);
    let release!: (client: any) => void;
    f.value.init = () => new Promise(resolve => { release = resolve; });
    assert.equal(await countFileReadTokens('x'.repeat(30), 10, countTokensWithAPI), 30);
    release(f.client);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.errors, []);
  });
}

test('ordinary token counters preserve the previous request contract', async () => {
  const f = state();
  assert.equal(await countTokensWithAPI('local file'), 42);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]![1], undefined);
  assert.equal(await countTokensWithAPI(''), 0);
});

test('bounded Bedrock profile counts start no uncancellable metadata or transport work', async () => {
  const f = state('bedrock');
  f.value.foundation = false;
  assert.equal(await countFileReadTokens('x'.repeat(30), 10, countTokensWithAPI), 30);
  assert.equal(f.value.initializations, 0);
  assert.equal(f.value.metadataCalls, 0);
  assert.equal(f.calls.length, 0);
});

test('ordinary Bedrock profile counts retain model resolution and the exact result', async () => {
  const f = state('bedrock');
  f.value.foundation = false;
  assert.equal(await countTokensWithAPI('local file'), 42);
  assert.equal(f.value.initializations, 1);
  assert.equal(f.value.metadataCalls, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]![1], undefined);
});
