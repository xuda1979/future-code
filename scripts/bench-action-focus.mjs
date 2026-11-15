#!/usr/bin/env node
// Host diagnostic overhead only: no model, job, training or productivity score.
import { performance } from 'node:perf_hooks';
import { actionFocusReview } from '../src/commands/goal/actionFocus.ts';

function pair(id, name, input, content, is_error = false) {
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } },
  ];
}
const observations = n => Array.from({ length: n }, (_, i) => pair(`read-${i}`, 'Read',
  { file_path: `src/file-${i}.ts` }, `source-${i}`)).flat();
const failure = Array.from({ length: 3 }, (_, i) => pair(`fail-${i}`, 'Bash', { command: 'probe' }, 'unavailable', true)).flat();
const review = observations(12);
const old = Array.from({ length: 100_000 }, () => ({ type: 'user', isMeta: true, message: { content: 'old host reminder' } }));
const cases = [
  ['ordinary_discovery', observations(5)],
  ['repeated_failure', failure],
  ['observation_review', review],
  ['long_history_same_tail', [...old, ...review]],
  ['large_receipts', Array.from({ length: 12 }, (_, i) => pair(`large-${i}`, 'Read',
    { file_path: `file-${i}` }, 'x'.repeat(32_000))).flat()],
];
const samples = 1000;
const result = { kind: 'HOST_DIAGNOSTIC_MICROBENCHMARK', node: process.version, platform: process.platform,
  samples, results: [], limitations: 'Local request-diagnostic overhead only; no live-model productivity or time saved measured.' };
for (const [name, history] of cases) {
  for (let i = 0; i < 100; i++) actionFocusReview(history, '/workspace/.future-code/goal.md');
  const times = [];
  let warningBytes = 0;
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    const diagnostic = actionFocusReview(history, '/workspace/.future-code/goal.md');
    times.push(performance.now() - start);
    warningBytes = Buffer.byteLength(diagnostic ?? '');
  }
  times.sort((a, b) => a - b);
  result.results.push({ name, history_messages: history.length, warning_bytes: warningBytes,
    p50_ms: times[Math.floor(samples * .5)], p95_ms: times[Math.floor(samples * .95)], max_ms: times.at(-1) });
}
console.log(JSON.stringify(result, null, 2));
