#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch, totalmem } from 'node:os';
const here = dirname(fileURLToPath(import.meta.url));
const candidate = resolve(here, '../..');
const baseline = resolve(process.argv[2] ?? join(candidate, '../future-code-first'));
const output = resolve(process.argv[3] ?? join(here, 'results'));
const repetitions = Number(process.env.FC_REPETITIONS ?? 4);
const sha = s => createHash('sha256').update(s).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const contract = JSON.parse(readFileSync(join(here, 'contract.json')));
if (git(baseline, 'rev-parse', 'HEAD') !== contract.baseline || git(candidate, 'rev-parse', 'HEAD') !== contract.candidate) throw new Error('Pinned revision mismatch');
for (const root of [baseline, candidate]) if (git(root, 'diff', 'HEAD', '--', 'src')) throw new Error('Compared production source is dirty');
mkdirSync(output, { recursive: true });
const sourcePaths = ['src/utils/toolResultStorage.ts', 'src/constants/toolLimits.ts', 'src/services/tools/StreamingToolExecutor.ts', 'src/utils/abortController.ts'];
const manifest = { generatedAt: new Date().toISOString(), contractSha256: sha(readFileSync(join(here, 'contract.json'))),
  runtime: { node: process.version, python: execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cpuCount: cpus().length, totalMemory: totalmem() },
  source: Object.fromEntries(Object.entries({ baseline, candidate }).map(([label, root]) => [label, {
    commit: git(root, 'rev-parse', 'HEAD'), root,
    files: Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(join(root, path)))])),
  }])),
  adapterHashes: Object.fromEntries(['arm.mjs', 'run.mjs', 'streaming-tool-executor-loader.mjs', 'tool-result-budget-loader.mjs'].map(p => [p, sha(readFileSync(join(here, p)))])),
  liveModelCalls: 0, billingTokens: null, dollars: null };
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const samples = [];
function arm(mode, scenario, label, repetition, input = '-') {
  const dir = join(output, `${mode}-${scenario}-${repetition}-${label}`);
  mkdirSync(dir, { recursive: true });
  const started = performance.now();
  const args = ['--experimental-strip-types', '--unhandled-rejections=strict', join(here, 'arm.mjs'), mode,
    label === 'baseline' ? baseline : candidate, input, dir, scenario];
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: mode === 'humaneval' ? 120_000 : 8000, maxBuffer: 5_000_000 });
  writeFileSync(join(dir, 'stdout.txt'), child.stdout ?? ''); writeFileSync(join(dir, 'stderr.txt'), child.stderr ?? '');
  const result = existsSync(join(dir, 'result.json')) ? JSON.parse(readFileSync(join(dir, 'result.json'))) : null;
  const events = existsSync(join(dir, 'events.jsonl')) ? readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const sample = { mode, scenario, label, repetition, processWallMs: performance.now() - started, exitCode: child.status, signal: child.signal,
    errorCode: child.error?.code ?? null, result, eventCounts: { effects: events.filter(e => e.kind === 'effect').length,
      testPasses: events.filter(e => e.kind === 'test-pass').length, pairedResults: events.filter(e => e.kind === 'result').length }, directory: dir.slice(output.length + 1) };
  samples.push(sample); writeFileSync(join(output, 'samples.json'), JSON.stringify(samples, null, 2) + '\n');
  console.log(JSON.stringify({ mode, scenario, label, repetition, exit: child.status, accepted: result?.accepted ?? false,
    bytes: result?.requestBytes, publicTests: sample.eventCounts.testPasses }));
  return sample;
}
// Freeze actual commands and retain their complete, unmodified TAP outputs.
const tests = readdirSync(join(candidate, 'tests/foundry')).filter(f => f.endsWith('.test.ts')).sort().slice(0, 12);
const logs = [];
const commandRecords = [];
mkdirSync(join(output, 'command-outputs'), { recursive: true });
for (const file of tests) {
  const args = ['--experimental-strip-types', '--test', '--test-concurrency=1', `tests/foundry/${file}`];
  const run = spawnSync(process.execPath, args, { cwd: candidate, encoding: 'utf8', timeout: 120000, maxBuffer: 10_000_000 });
  if (run.error) throw run.error;
  const content = (run.stdout ?? '') + (run.stderr ?? '');
  const path = join(output, 'command-outputs', `${file}.txt`); writeFileSync(path, content); logs.push(content);
  commandRecords.push({ file, argv: [process.execPath, ...args], exitCode: run.status, bytes: Buffer.byteLength(content), sha256: sha(content) });
}
writeFileSync(join(output, 'commands.json'), JSON.stringify(commandRecords, null, 2) + '\n');
for (const [size, count] of [['small', 1], ['medium', 4], ['large', 12]]) {
  const input = join(output, `context-${size}-input.json`); writeFileSync(input, JSON.stringify(logs.slice(0, count)));
  for (let r = 0; r < repetitions; r++) for (const label of r % 4 === 0 || r % 4 === 3 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) arm('context', size, label, r, input);
}
// The first commit ALREADY implements optional aggregate offloading: record
// its enabled behavior too, instead of treating the feature as wholly new.
arm('context', 'legacy-flag-on', 'baseline', 0, join(output, 'context-large-input.json'));
const scenarios = ['healthy', 'ordinary-error-result', 'stream-throw-before-result', 'stream-throw-after-effect', 'empty-stream-after-effect', 'context-modifier-throw', 'schema-preflight-throw'];
for (const scenario of scenarios) for (let r = 0; r < repetitions; r++)
  for (const label of r % 4 === 0 || r % 4 === 3 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) arm('executor', scenario, label, r);
const dataset = join(here, 'data', 'HumanEval.json');
if (existsSync(dataset)) for (const scenario of ['healthy', 'stream-throw-after-result']) for (let r = 0; r < repetitions; r++)
  for (const label of r % 4 === 0 || r % 4 === 3 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) arm('humaneval', scenario, label, r, dataset);
console.log(JSON.stringify({ completedArms: samples.length, output, allRawCommandsPassed: commandRecords.every(c => c.exitCode === 0) }));
