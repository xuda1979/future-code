// Time the production query's display-summary consume block, not a live model
// or end-to-end R&D task. The simulated label service has declared latency.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.argv[2], steps = Number(process.argv[3] ?? 1), delayMs = Number(process.argv[4] ?? 250);
const source = readFileSync(resolve(root, 'src/query.ts'), 'utf8');
const start = source.indexOf('    if (pendingToolUseSummary) {');
const end = source.indexOf('    if (!needsFollowUp) {', start);
if (start < 0 || end <= start) throw new Error('Cannot locate production consume block');
const block = source.slice(start, end);
const consume = new Function('pendingToolUseSummary', `return (async function* () { ${block} })()`);
const usesPoll = block.includes('pendingToolUseSummary.take()');
const Task = usesPoll ? (await import(pathToFileURL(resolve(root, 'src/utils/opportunisticTask.ts')).href)).OpportunisticTask : null;
const task = Task ? new Task() : null, parent = new AbortController();
let calls = 0, labels = 0;
const before = performance.now();
for (let i = 0; i < steps; i++) {
  const service = signal => { calls++; return delay(delayMs, 'optional display label', { signal }); };
  let pending;
  if (task) { task.start(parent.signal, service); pending = task; }
  else pending = service(parent.signal);
  for await (const _ of consume(pending)) labels++;
}
const elapsedMs = performance.now() - before;
task?.[Symbol.dispose]();
await new Promise(resolve => setImmediate(resolve));
process.stdout.write(JSON.stringify({ steps, simulatedLabelLatencyMs: delayMs, elapsedMs, calls, labels,
  parentAborted: parent.signal.aborted }) + '\n');
