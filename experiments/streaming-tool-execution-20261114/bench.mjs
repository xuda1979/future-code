#!/usr/bin/env node
// A/B benchmark: REAL StreamingToolExecutor (streaming admission — new default)
// vs REAL runTools from toolOrchestration.ts (buffered admission — previous
// main behavior), under identical simulated stream-arrival schedules.
//
// Both arms run the same stubbed tool generator (__benchToolRun) with the same
// per-tool work; only the admission policy differs. The benchmark doubles as a
// correctness gate: every scenario must produce exactly one tool_result per
// admitted tool_use, with no losses or duplicates.
//
// Methodology:
// - Stream simulation: each tool_use block "finishes arriving" every
//   interarrivalMs; after the last block, trailingMs of text streams before
//   the assistant message completes (models the model's post-tool-call prose).
// - Buffered arm (main today): blocks are collected during the stream; runTools
//   starts only after the full message completes — exactly query.ts's
//   non-streaming path.
// - Streaming arm (new default): executor.addTool is called the moment each
//   block completes; completed results are polled every POLL_MS during the
//   stream (message-update cadence) and getRemainingResults is drained at
//   stream end — exactly query.ts's streaming path.
// - Metrics: totalMs (stream start -> last result collected), firstResultMs,
//   admission latency per tool (work start minus block arrival).
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

register('./bench-loader.mjs', import.meta.url);
const { StreamingToolExecutor } = await import('../../src/services/tools/StreamingToolExecutor.ts');
const { runTools } = await import('../../src/services/tools/toolOrchestration.ts');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Tool definitions mirror tests/correctness/streaming-tool-executor.test.ts:
// Read is concurrency-safe; Bash/Write are effectful (serial).
const TOOL_DEFS = ['Read', 'Bash', 'Write'].map(name => ({
  name,
  inputSchema: { safeParse: data => ({ success: true, data }) },
  isConcurrencySafe: () => name === 'Read',
  interruptBehavior: () => 'cancel',
}));

const SCENARIOS = [
  { name: 'readonly-4', tools: ['Read', 'Read', 'Read', 'Read'], interarrivalMs: 300, trailingMs: 1500, workMs: 500 },
  { name: 'serial-4', tools: ['Bash', 'Bash', 'Bash', 'Bash'], interarrivalMs: 300, trailingMs: 1500, workMs: 800 },
  { name: 'mixed-6', tools: ['Read', 'Bash', 'Read', 'Bash', 'Read', 'Bash'], interarrivalMs: 250, trailingMs: 2000, workMs: 600 },
];
const REPS = 3;
const POLL_MS = 100;

function makeContext() {
  const abortController = new AbortController();
  let inProgress = new Set();
  return {
    abortController,
    options: { tools: TOOL_DEFS, mcpClients: [] },
    setInProgressToolUseIDs: update => { inProgress = update(inProgress); },
    setHasInterruptibleToolInProgress: () => {},
  };
}

async function runOnce(arm, scenario) {
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  const blocks = scenario.tools.map((name, i) => ({ type: 'tool_use', id: `tool-${i}`, name, input: { i } }));
  const arrivals = new Map();
  const starts = new Map();
  const collected = new Map(); // tool_use_id -> first collection time
  let duplicates = 0;
  const canUseTool = async () => ({ behavior: 'allow' });
  const context = makeContext();

  // Identical simulated tool work for both arms.
  globalThis.__benchToolRun = async function* (toolUse, _assistantMessage, canUse) {
    if (typeof canUse === 'function') await canUse(toolUse);
    starts.set(toolUse.id, now());
    await sleep(scenario.workMs);
    yield { message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'ok' }] } } };
  };

  const collect = update => {
    const message = update?.message;
    if (message?.type === 'user' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result') {
          if (collected.has(block.tool_use_id)) duplicates++;
          else collected.set(block.tool_use_id, now());
        }
      }
    }
  };

  const simulateStream = async onBlockArrived => {
    for (let i = 0; i < blocks.length; i++) {
      await sleep(scenario.interarrivalMs);
      arrivals.set(blocks[i].id, now());
      onBlockArrived(i);
    }
    await sleep(scenario.trailingMs);
  };

  if (arm === 'streaming') {
    const executor = new StreamingToolExecutor(TOOL_DEFS, canUseTool, context);
    let streaming = true;
    const poller = (async () => {
      while (streaming) {
        await sleep(POLL_MS);
        for (const update of executor.getCompletedResults()) collect(update);
      }
    })();
    await simulateStream(i =>
      executor.addTool(blocks[i], { uuid: `assistant-${i}`, message: { id: `response-${i}` } }));
    streaming = false;
    await poller;
    for await (const update of executor.getRemainingResults()) collect(update);
  } else {
    await simulateStream(() => {});
    const assistantMessage = {
      type: 'assistant', uuid: 'assistant-0',
      message: { id: 'response-0', role: 'assistant', content: blocks },
    };
    for await (const update of runTools(blocks, [assistantMessage], canUseTool, context)) collect(update);
  }

  // Correctness gate: exactly one tool_result per admitted tool_use, no dups.
  const expected = blocks.map(b => b.id).sort();
  assert.deepEqual([...collected.keys()].sort(), expected, `${arm}/${scenario.name}: tool_result set mismatch`);
  assert.equal(duplicates, 0, `${arm}/${scenario.name}: duplicate tool_results`);

  const admissions = blocks.map(b => starts.get(b.id) - arrivals.get(b.id));
  const times = [...collected.values()];
  return {
    arm, scenario: scenario.name,
    totalMs: Math.max(...times),
    firstResultMs: Math.min(...times),
    avgAdmissionMs: admissions.reduce((a, b) => a + b, 0) / admissions.length,
    maxAdmissionMs: Math.max(...admissions),
  };
}

const median = values => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const runs = [];
for (const scenario of SCENARIOS) {
  for (const arm of ['buffered', 'streaming']) {
    await runOnce(arm, scenario); // warmup, discarded
    for (let rep = 0; rep < REPS; rep++) runs.push(await runOnce(arm, scenario));
    process.stderr.write(`done ${scenario.name}/${arm}\n`);
  }
}

const summary = [];
for (const scenario of SCENARIOS) {
  const row = { scenario: scenario.name };
  for (const arm of ['buffered', 'streaming']) {
    const rs = runs.filter(r => r.scenario === scenario.name && r.arm === arm);
    row[arm] = {
      totalMs: median(rs.map(r => r.totalMs)),
      firstResultMs: median(rs.map(r => r.firstResultMs)),
      avgAdmissionMs: median(rs.map(r => r.avgAdmissionMs)),
      maxAdmissionMs: median(rs.map(r => r.maxAdmissionMs)),
    };
  }
  row.speedupTotal = row.buffered.totalMs / row.streaming.totalMs;
  row.speedupFirstResult = row.buffered.firstResultMs / row.streaming.firstResultMs;
  summary.push(row);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'data');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'results.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  node: process.version,
  reps: REPS,
  pollMs: POLL_MS,
  scenarios: SCENARIOS,
  runs,
  summary,
}, null, 2));

console.table(summary.map(({ scenario, buffered, streaming, speedupTotal, speedupFirstResult }) => ({
  scenario,
  bufferedTotalMs: Math.round(buffered.totalMs),
  streamingTotalMs: Math.round(streaming.totalMs),
  speedupTotal: +speedupTotal.toFixed(2),
  bufferedFirstMs: Math.round(buffered.firstResultMs),
  streamingFirstMs: Math.round(streaming.firstResultMs),
  speedupFirst: +speedupFirstResult.toFixed(2),
})));
console.table(summary.map(({ scenario, buffered, streaming }) => ({
  scenario,
  bufferedAvgAdmitMs: Math.round(buffered.avgAdmissionMs),
  streamingAvgAdmitMs: Math.round(streaming.avgAdmissionMs),
  bufferedMaxAdmitMs: Math.round(buffered.maxAdmissionMs),
  streamingMaxAdmitMs: Math.round(streaming.maxAdmissionMs),
})));
