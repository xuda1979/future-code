#!/usr/bin/env node
// Actual production validator and token-count service + real SDK/loopback HTTP.
// Worker decisions and counter values are controlled; no live LLM is called.
import assert from 'node:assert/strict';
import { register, stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import Future from '@future/sdk';

const self = fileURLToPath(import.meta.url), root = resolve(dirname(self), '..');
const fixture = join(root, 'experiments/task-productivity-20261117');
const contract = JSON.parse(readFileSync(join(fixture, 'contract.json'), 'utf8'));
const cases = contract.design.counter_cases, maxTokens = 25000;
const hash = value => createHash('sha256').update(value).digest('hex');
const paths = ['src/tools/FileReadTool/FileReadTool.ts', 'src/services/tokenEstimation.ts', 'src/tools/FileReadTool/tokenBudget.ts'];
const hashes = directory => Object.fromEntries(paths.map(path => [path, existsSync(join(directory, path)) ? hash(readFileSync(join(directory, path))) : null]));

async function validator(source, counter) {
  const text = readFileSync(join(source, paths[0]), 'utf8'), tokenSource = readFileSync(join(source, paths[1]), 'utf8');
  const body = text.slice(text.indexOf('async function validateContentTokens('), text.indexOf('\ntype ImageResult ='));
  const error = text.slice(text.indexOf('export class MaxFileReadTokenExceededError'), text.indexOf('\n// Common image extensions'));
  const estimates = tokenSource.slice(tokenSource.indexOf('export function roughTokenCountEstimation('), tokenSource.indexOf('/**\n * Estimates token count for a Message'));
  assert(body.startsWith('async function validateContentTokens('));
  assert(error.startsWith('export class MaxFileReadTokenExceededError'));
  assert(estimates.startsWith('export function roughTokenCountEstimation('));
  const legacy = body.includes('roughTokenCountEstimationForFileType');
  const helper = legacy ? undefined : (await import(pathToFileURL(join(source, paths[2])))).countFileReadTokens;
  const code = stripTypeScriptTypes([estimates.replace(/^export /gm, ''), error.replace(/^export /gm, ''), body].join('\n'), { mode: 'transform' });
  // Execute the exact selected production declarations, not a reimplementation.
  const api = new Function('countTokensWithAPI', 'countFileReadTokens', 'getDefaultFileReadingLimits',
    code + ';return {validateContentTokens,MaxFileReadTokenExceededError};')(counter, helper, () => ({ maxTokens }));
  return { legacy, bodySha256: hash(body), validate: (content, extension, signal) => legacy
    ? api.validateContentTokens(content, extension, maxTokens)
    : api.validateContentTokens(content, maxTokens, signal), BudgetError: api.MaxFileReadTokenExceededError };
}

async function probe(source, scenario) {
  register('../tests/correctness/file-read-token-count-loader.mjs', import.meta.url);
  const { countTokensWithAPI } = await import(pathToFileURL(join(source, paths[1])));
  const directory = mkdtempSync(join(tmpdir(), 'future-file-read-task-'));
  const responseCounts = [], openResponses = new Set(), responseClosures = [], transportErrors = [];
  let requests = 0, closedBeforeResponse = 0, initializations = 0, expired = false;
  const observation = new AbortController();
  const server = createServer((request, response) => {
    requests++; openResponses.add(response); let body = '';
    responseClosures.push(new Promise(resolve => response.once('close', resolve)));
    request.on('data', chunk => { body += chunk; });
    response.on('close', () => { if (!response.writableEnded) closedBeforeResponse++; openResponses.delete(response); });
    request.on('end', () => {
      const input = JSON.parse(body); responseCounts.push({ contentSha256: hash(input.messages[0].content), contentChars: input.messages[0].content.length });
      if (scenario === 'counter-stalled') return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: scenario === 'counter-oversize' ? maxTokens + 1 : scenario === 'counter-unavailable' ? null : 9000 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Future({ apiKey: 'local-experiment-fixture', baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0, timeout: 600000,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([observation.signal, ...(options.signal ? [options.signal] : [])]) }) });
  globalThis.__fileReadTokenCountTest = { provider: 'firstParty', errors: transportErrors, init: async () => { initializations++; return client; } };
  const api = await validator(source, countTokensWithAPI);
  const path = scenario === 'counter-local-json' ? 'config.json' : 'calc.mjs';
  const initial = path.endsWith('.json') ? JSON.stringify({ port: 8080, enabled: true, padding: 'x'.repeat(20000) }) + '\n' :
    '// ' + 'fixture comment '.repeat(2600) + '\nexport const sum=(a,b)=>a-b;\n';
  writeFileSync(join(directory, path), initial);
  const start = performance.now();
  let fullReadGuard = 'PENDING', rangeReads = 0, mutations = 0, timer;
  async function task() {
    const content = readFileSync(join(directory, path), 'utf8');
    let accepted;
    try {
      await api.validate(content, path.endsWith('.json') ? 'json' : 'mjs', observation.signal);
      if (expired) return null;
      fullReadGuard = 'ACCEPTED'; accepted = content;
    } catch (error) {
      if (expired) return null;
      assert(error instanceof api.BudgetError, String(error)); fullReadGuard = 'REJECTED_REQUIRES_RANGE';
      if (scenario !== 'counter-oversize') {
        accepted = '';
        // Real smaller ranges; bytes are preserved exactly and each range must
        // independently satisfy the unchanged per-read output budget.
        for (let offset = 0; offset < content.length; offset += 6000) {
          const range = content.slice(offset, offset + 6000);
          await api.validate(range, path.endsWith('.json') ? 'json' : 'mjs', observation.signal);
          assert(!expired); accepted += range; rangeReads++;
        }
        assert.equal(accepted, content);
      }
    }
    if (scenario === 'counter-oversize') assert.equal(fullReadGuard, 'REJECTED_REQUIRES_RANGE');
    else {
      assert.equal(typeof accepted, 'string');
      const changed = path.endsWith('.json') ? JSON.stringify({ ...JSON.parse(accepted), port: 9090 }) + '\n' : accepted.replace('=>a-b;', '=>a+b;');
      assert.notEqual(changed, initial); writeFileSync(join(directory, path), changed); mutations++;
    }
    const check = spawnSync(process.execPath, [join(fixture, 'check-file-task.mjs'), directory, scenario], { encoding: 'utf8', timeout: 5000 });
    assert.equal(check.status, 0, check.stderr);
    return { verdict: 'PASS', completionWallMs: performance.now() - start, independentCheck: JSON.parse(check.stdout) };
  }
  try {
    const work = task();
    const result = await Promise.race([work, new Promise(resolve => {
      timer = setTimeout(() => { expired = true; resolve({ verdict: 'CENSORED', completionWallMs: null, independentCheck: null }); }, contract.design.counter_observation_ms);
    })]);
    clearTimeout(timer);
    if (scenario === 'counter-stalled' && result.verdict === 'PASS') {
      // Yield to actual socket-close events before cleanup. Synchronous artifact
      // checking can otherwise delay observation of an already aborted fetch.
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('production count transport did not close after abort')), 500);
        Promise.all(responseClosures).then(() => { clearTimeout(deadline); resolve(); });
      });
    }
    const observationWallMs = performance.now() - start;
    const closedByProductionBeforeCleanup = closedBeforeResponse;
    observation.abort(new Error('experiment observation ended'));
    for (const response of openResponses) response.destroy();
    await work;
    await new Promise(resolve => setImmediate(resolve));
    return { scenario, ...result, taskSolved: result.verdict === 'PASS' && scenario !== 'counter-oversize',
      outcome: result.verdict === 'CENSORED' ? 'CENSORED' : scenario === 'counter-oversize' ? 'OVERSIZE_GUARD_PASSED_NO_REPAIR' : 'REPAIR_PASSED',
      observationWallMs, observationLimitMs: contract.design.counter_observation_ms,
      fullReadGuard, rangeReads, mutations, counterRequests: requests, clientInitializations: initializations,
      closedBeforeResponse, closedByProductionBeforeCleanup, transportErrors: transportErrors.length, responseCounts, validatorBodySha256: api.bodySha256,
      artifactBefore: hash(initial), artifactAfter: hash(readFileSync(join(directory, path))), artifactBytes: Buffer.byteLength(initial),
      adapter: 'exact production validation declarations and token-count service, actual installed SDK, controlled loopback counter; no live model' };
  } finally {
    clearTimeout(timer); observation.abort(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); delete globalThis.__fileReadTokenCountTest;
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--probe') {
  const [source, scenario] = process.argv.slice(3); assert(cases.includes(scenario));
  process.stdout.write(JSON.stringify(await probe(resolve(source), scenario)));
} else {
  const [baseline, output, sampleText = String(contract.design.samples_per_arm_per_case)] = process.argv.slice(2);
  assert(baseline && output, 'usage: node scripts/bench-file-read-task.mjs BASELINE OUTPUT [SAMPLES]');
  const samples = Number(sampleText); assert(Number.isSafeInteger(samples) && samples > 0 && samples <= 20);
  const sources = { baseline: resolve(baseline), candidate: root }, frozenSources = Object.fromEntries(Object.entries(sources).map(([arm, directory]) => [arm, hashes(directory)]));
  const sourceRevisions = Object.fromEntries(Object.entries(sources).map(([arm, directory]) => [arm, {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(),
    dirtyMeasuredPaths: execFileSync('git', ['status', '--porcelain', '--', ...paths], { cwd: directory, encoding: 'utf8' }).trim() }]));
  assert.equal(sourceRevisions.baseline.head, contract.baseline); assert.equal(sourceRevisions.baseline.dirtyMeasuredPaths, '');
  const inputs = [self, join(fixture, 'check-file-task.mjs'), join(fixture, 'contract.json'), join(root, 'tests/correctness/file-read-token-count-loader.mjs'),
    join(root, 'node_modules/@future/sdk/package.json')];
  const frozenInputs = Object.fromEntries(inputs.map(path => [path.replace(root + '/', ''), hash(readFileSync(path))]));
  const runs = [];
  for (let sample = 0; sample < samples; sample++) for (const scenario of cases) for (const arm of sample % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', self, '--probe', sources[arm], scenario], { encoding: 'utf8', timeout: 12000, maxBuffer: 2_000_000 });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr); runs.push({ sample, arm, ...JSON.parse(child.stdout) });
  }
  const summary = {};
  for (const scenario of cases) {
    summary[scenario] = {};
    const rows = runs.filter(row => row.scenario === scenario);
    if (scenario !== 'counter-stalled') assert.equal(new Set(rows.map(row => row.artifactAfter)).size, 1, 'paired artifacts differ');
    for (const arm of Object.keys(sources)) {
      const selected = rows.filter(row => row.arm === arm), finished = selected.filter(row => row.verdict === 'PASS');
      const median = values => values.length ? values.sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
      assert(selected.every(row => row.verdict === (scenario === 'counter-stalled' && arm === 'baseline' ? 'CENSORED' : 'PASS')));
      if (scenario === 'counter-local-json') assert(selected.every(row => row.counterRequests === (arm === 'baseline' ? 1 : 0)));
      if (scenario === 'counter-stalled' && arm === 'candidate') assert(selected.every(row => row.fullReadGuard === 'REJECTED_REQUIRES_RANGE' && row.rangeReads > 0 && row.closedByProductionBeforeCleanup === 1));
      if (scenario === 'counter-oversize') assert(selected.every(row => row.fullReadGuard === 'REJECTED_REQUIRES_RANGE' && row.mutations === 0));
      summary[scenario][arm] = { protocolPasses: finished.length, completedRepairs: selected.filter(row => row.taskSolved).length,
        guardrailPasses: finished.filter(row => row.outcome === 'OVERSIZE_GUARD_PASSED_NO_REPAIR').length, censored: selected.length - finished.length,
        counterRequests: selected.reduce((sum, row) => sum + row.counterRequests, 0), rangeReads: selected.reduce((sum, row) => sum + row.rangeReads, 0),
        medianCompletionWallMs: median(finished.map(row => row.completionWallMs)), medianObservationWallMs: median(selected.map(row => row.observationWallMs)) };
    }
  }
  for (const [arm, directory] of Object.entries(sources)) assert.deepEqual(hashes(directory), frozenSources[arm], 'source changed during measurement');
  assert.deepEqual(Object.fromEntries(inputs.map(path => [path.replace(root + '/', ''), hash(readFileSync(path))])), frozenInputs, 'experiment input changed');
  const report = { schema: 1, kind: 'REAL_LOCAL_REPAIR_AND_TOKEN_COUNTER_COMPONENT_NOT_LIVE_MODEL_BENCHMARK', samplesPerArm: samples,
    sourceRevisions, sourceHashes: frozenSources, inputHashes: frozenInputs, runtime: { node: process.version, sdk: JSON.parse(readFileSync(join(root, 'node_modules/@future/sdk/package.json'))).version },
    modelCalls: 0, modelTokens: null, dollars: null, summary, runs, limitations: [...contract.limitations,
      'The exact unchanged validator declarations are loaded without the unrelated full CLI dependency graph.',
      'The counter returns controlled counts, not tokenizer or model accuracy measurements. Observation cancellation is experiment cleanup, not a baseline deadline.'] };
  mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ trials: runs.length, summary }, null, 2) + '\n');
}
