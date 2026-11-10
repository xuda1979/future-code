import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./streaming-tool-executor-loader.mjs', import.meta.url);
const { StreamingToolExecutor } = await import('../../src/services/tools/StreamingToolExecutor.ts');

const result = (id: string, content = 'actual evidence') => ({ message: { type: 'user', message: { content: [
  { type: 'tool_result', tool_use_id: id, content },
] } } });
function fixture(run: (...args: any[]) => AsyncGenerator<any>) {
  (globalThis as any).__futureStreamingToolTest = run;
  let inProgress = new Set<string>();
  const tools = ['Read', 'Write', 'Bash'].map(name => ({ name,
    inputSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
    isConcurrencySafe: () => name === 'Read', interruptBehavior: () => 'cancel',
  }));
  const context = { abortController: new AbortController(), options: { tools, mcpClients: [] },
    setInProgressToolUseIDs: (update: (value: Set<string>) => Set<string>) => { inProgress = update(inProgress); },
    setHasInterruptibleToolInProgress: () => {}, marker: 'original' };
  const executor = new StreamingToolExecutor(tools as any, (() => {}) as any, context as any);
  const add = (id: string, name = 'Read') => executor.addTool({ id, name, input: {} } as any,
    { uuid: `assistant-${id}`, message: { id: `response-${id}` } } as any);
  const drain = async () => {
    const updates = [];
    for await (const update of executor.getRemainingResults()) updates.push(update);
    return updates.flatMap(update => update.message?.type === 'user' && Array.isArray(update.message.message.content)
      ? update.message.message.content.filter((block: any) => block.type === 'tool_result') : []);
  };
  return { executor, add, drain, context, inProgress: () => [...inProgress] };
}

test('a throwing tool stream becomes one paired error and later work completes', { timeout: 2000 }, async () => {
  const f = fixture(async function* (call) {
    if (call.id === 'broken') throw new Error('plugin stream exploded');
    yield result(call.id);
  });
  f.add('broken'); f.add('next');
  const blocks = await f.drain();
  assert.deepEqual(blocks.map((block: any) => block.tool_use_id), ['broken', 'next']);
  assert.equal(blocks[0]!.is_error, true);
  assert.match(String(blocks[0]!.content), /plugin stream exploded.*effects may already exist/s);
  assert.deepEqual(f.inProgress(), []);
  assert.equal(f.context.abortController.signal.aborted, false);
});

test('post-result context failure preserves actual evidence and never fabricates success', { timeout: 2000 }, async () => {
  const f = fixture(async function* (call) {
    yield { ...result(call.id, 'measured output that must survive'), contextModifier: {
      modifyContext: () => { throw new Error('context update failed'); },
    } };
  });
  f.add('change', 'Write');
  const blocks = await f.drain();
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.is_error, true);
  assert.match(String(blocks[0]!.content), /measured output that must survive/);
  assert.match(String(blocks[0]!.content), /context update failed/);
  assert.deepEqual(f.inProgress(), []);
});

test('an empty stream cannot silently lose an admitted call result', { timeout: 2000 }, async () => {
  const f = fixture(async function* () {});
  f.add('empty');
  const blocks = await f.drain();
  assert.equal(blocks.length, 1); assert.equal(blocks[0]!.is_error, true);
  assert.match(String(blocks[0]!.content), /ended without a result/);
});

test('parallel reads overlap and a write remains an ordering barrier', { timeout: 2000 }, async () => {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async function* (call) {
    started.push(call.id);
    if (call.id === 'read-a' || call.id === 'read-b') await gate;
    yield result(call.id);
  });
  f.add('read-a'); f.add('read-b'); f.add('write', 'Write'); f.add('read-c');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['read-a', 'read-b']);
  release(); await f.drain();
  assert.deepEqual(started, ['read-a', 'read-b', 'write', 'read-c']);
});

test('context modifiers finish before the next exclusive tool starts', { timeout: 2000 }, async () => {
  const observed: string[] = [];
  const f = fixture(async function* (call, _message, _permission, context) {
    observed.push(context.marker);
    yield { ...result(call.id), ...(call.id === 'first' ? { contextModifier: {
      modifyContext: (previous: any) => ({ ...previous, marker: 'updated' }),
    } } : {}) };
  });
  f.add('first', 'Write'); f.add('second', 'Write');
  await f.drain(); assert.deepEqual(observed, ['original', 'updated']);
});

test('discard rejects admitted effects while collection executes them exactly once', { timeout: 2000 }, async () => {
  let executions = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async function* (call) { executions++; await gate; yield result(call.id); });
  f.add('effect', 'Write');
  assert.throws(() => f.executor.discard(), /collect their actual results/);
  release(); const blocks = await f.drain();
  assert.equal(executions, 1); assert.equal(blocks.length, 1);
});

test('discard before admission is safe and never starts later stale work', { timeout: 2000 }, async () => {
  let executions = 0;
  const f = fixture(async function* (call) { executions++; yield result(call.id); });
  f.executor.discard(); f.add('stale'); await f.drain();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executions, 0);
});

test('a Bash framework failure cancels dependent siblings without cancelling the user goal', { timeout: 2000 }, async () => {
  const executed: string[] = [];
  const f = fixture(async function* (call) {
    executed.push(call.id);
    if (call.id === 'bash') throw new Error('shell result transport failed');
    yield result(call.id);
  });
  f.add('bash', 'Bash'); f.add('dependent', 'Write');
  const blocks = await f.drain();
  assert.deepEqual(executed, ['bash']); assert.equal(blocks.length, 2);
  assert.ok(blocks.every((block: any) => block.is_error));
  assert.equal(f.context.abortController.signal.aborted, false); assert.deepEqual(f.inProgress(), []);
});

test('a throwing concurrency preflight cannot lose a call before normal tool validation', { timeout: 2000 }, async () => {
  const f = fixture(async function* (call) {
    const update = result(call.id, 'schema validation failed');
    (update.message.message.content[0] as any).is_error = true;
    yield update;
  });
  f.context.options.tools[0]!.inputSchema.safeParse = () => { throw new Error('schema predicate failed'); };
  assert.doesNotThrow(() => f.add('invalid'));
  const blocks = await f.drain();
  assert.equal(blocks.length, 1); assert.equal(blocks[0]!.tool_use_id, 'invalid');
  assert.equal(blocks[0]!.is_error, true); assert.deepEqual(f.inProgress(), []);
});
