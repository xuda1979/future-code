// Production executor, deterministic tool service. A separate process lets the
// parent detect event-loop starvation, which an in-process timer cannot stop.
import { register } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay, setImmediate as turn } from 'node:timers/promises';
register('../streaming-tool-executor-loader.mjs', import.meta.url);
const root = process.argv[2] ?? fileURLToPath(new URL('../../../', import.meta.url));
const scenario = process.argv[3] ?? 'blocked';
const count = Number(process.argv[4] ?? 500);
const { StreamingToolExecutor } = await import(pathToFileURL(resolve(root, 'src/services/tools/StreamingToolExecutor.ts')).href);
const definitions = ['Read', 'Write'].map(name => ({ name,
  inputSchema: { safeParse: data => ({ success: true, data }) },
  isConcurrencySafe: () => name === 'Read', interruptBehavior: () => 'cancel',
}));
let inProgress = new Set(), effects = 0, heartbeat = 0, subscriptions = 0;
const started = [];
const context = { abortController: new AbortController(), options: { tools: definitions },
  setInProgressToolUseIDs: update => { inProgress = update(inProgress); },
  setHasInterruptibleToolInProgress() {},
};
const result = id => ({ message: { type: 'user', message: { content: [
  { type: 'tool_result', tool_use_id: id, content: `actual:${id}` },
] } } });
let release;
const gate = new Promise(resolve => { release = resolve; });
globalThis.__futureStreamingToolTest = async function* (call, _message, _permission, toolContext) {
  started.push(call.id);
  if (call.name === 'Write') effects++;
  if (scenario === 'blocked' && call.id === 'write') await delay(30);
  if (scenario === 'cancel' && call.id === 'write') {
    await new Promise(resolve => toolContext.abortController.signal.addEventListener('abort', resolve, { once: true }));
  }
  if (scenario === 'progress' && call.id === 'slow') await gate;
  if (scenario === 'progress' && call.id === 'noisy') {
    for (let i = 0; i < count; i++) {
      await turn();
      yield { message: { type: 'progress', sequence: i } };
    }
    // Let the collector drain the final progress and receipt before completion.
    setTimeout(release, 5);
  }
  yield result(call.id);
};
const executor = new StreamingToolExecutor(definitions, () => {}, context);
function add(id, name = 'Read') {
  executor.addTool({ id, name, input: {} }, { uuid: `assistant:${id}` });
}
const timer = setInterval(() => { heartbeat++; }, 2);
const before = performance.now();
if (scenario === 'blocked' || scenario === 'cancel') {
  add('write', 'Write'); add('missing', 'Unknown'); add('after');
  if (scenario === 'cancel') setTimeout(() => context.abortController.abort('interrupt'), 30);
}
else if (scenario === 'progress') {
  add('slow'); add('noisy');
  // Count observers added to the same long-lived production completion promise.
  const promise = executor.tools[0].promise, original = promise.then;
  promise.then = function (...args) { subscriptions++; return original.apply(this, args); };
} else if (scenario === 'short') { add('read'); add('write', 'Write'); }
else throw new Error(`Unknown scenario: ${scenario}`);
const receipts = [], progress = [];
for await (const update of executor.getRemainingResults()) {
  if (update.message?.type === 'user') receipts.push(...update.message.message.content);
  if (update.message?.type === 'progress') progress.push(update.message.sequence);
}
clearInterval(timer);
const elapsedMs = performance.now() - before;
process.stdout.write(JSON.stringify({ scenario, elapsedMs, heartbeat, subscriptions, effects, started,
  inProgress: [...inProgress], aborted: context.abortController.signal.aborted, receipts,
  progressCount: progress.length,
  progressHash: createHash('sha256').update(JSON.stringify(progress)).digest('hex'),
}) + '\n');
