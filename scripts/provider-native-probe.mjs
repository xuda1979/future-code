#!/usr/bin/env node
// Optional @opencode/ai arm for bench-provider-terminal.py. This exercises
// OpenCode's published native provider transport, not its full coding CLI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [runtime, endpoint, roundsText, directory] = process.argv.slice(2);
const rounds = Number(roundsText);
assert.ok(runtime && endpoint && directory && Number.isSafeInteger(rounds) && rounds > 0);
const packageRoot = resolve(runtime, 'node_modules/@opencode/ai');
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(manifest.version, '2.3.0', 'Pin the native comparison dependency');
const exported = key => import(pathToFileURL(resolve(packageRoot, manifest.exports[key].import)));
const { ai, tool, Message } = await exported('.');
const { OpenAICompatible } = await exported('./providers');
const provider = OpenAICompatible.configure({ provider: 'local-fixture', baseURL: endpoint, apiKey: 'local-fixture-key' });
const model = provider.model('local-fixture');
const tools = [tool({ name: 'Read', description: 'Read a UTF-8 file.', input: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } })];
const initialMessages = () => [Message.user('Read fixture.txt and report the receipt.')];
let messages = initialMessages();
const receipts = [], timings = [];
let warmup;
for (let index = 0; index <= rounds; index++) {
  const began = performance.now();
  const calls = [];
  let ready, terminal, reasoning = '';
  for await (const event of ai.stream({ model, messages, tools, maxTokens: 1024 })) {
    if (event.type === 'reasoning-delta') reasoning += event.text;
    if (event.type === 'tool-call') { ready = performance.now() - began; calls.push(event); }
    if (event.type === 'finish') terminal = event;
  }
  const complete = performance.now() - began;
  assert.equal(terminal?.reason.normalized, 'tool-calls');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.id, `call-inspect-${index + 1}`);
  assert.equal(call.name, 'Read');
  assert.deepEqual(call.input, { file_path: 'fixture.txt' });
  assert.equal(reasoning, 'Inspect the fixture.');
  const usage = { input_tokens: terminal.usage.inputTokens, output_tokens: terminal.usage.outputTokens };
  assert.deepEqual(usage, { input_tokens: 8, output_tokens: 3 });
  const content = await readFile(join(directory, call.input.file_path));
  if (index === 0) { warmup = { tool_ready_ms: ready, complete_ms: complete }; messages = initialMessages(); continue; }
  receipts.push({ tool: call.name, arguments: call.input, output_sha256: createHash('sha256').update(content).digest('hex'), usage });
  timings.push({ tool_ready_ms: ready, complete_ms: complete });
  messages = [...messages, terminal.message, Message.tool({ id: call.id, name: call.name,
    result: { type: 'text', value: content.toString('utf8') } })];
}
// Python recomputes the receipt hash under one canonical JSON encoder for all
// arms. Do not compare hashes of two languages' serialization conventions.
process.stdout.write(JSON.stringify({ rounds, upstream_requests: rounds + 1, warmup,
  bridge_total_ms: timings.reduce((sum, item) => sum + item.complete_ms, 0), timings, receipts,
  package_version: manifest.version, node_version: process.version }));
