#!/usr/bin/env node
// Paired task reproductions through the real streaming executor. No live LLM.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const self = fileURLToPath(import.meta.url), root = resolve(dirname(self), '..');
const fixture = join(root, 'experiments/task-productivity-20261117');
const contract = JSON.parse(readFileSync(join(fixture, 'contract.json'), 'utf8'));
const cases = [...contract.design.read_failure_cases, ...contract.design.controls];
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['src/services/tools/StreamingToolExecutor.ts', 'src/utils/abortController.ts'];
const hashes = directory => Object.fromEntries(sourceFiles.map(path => [path, hash(readFileSync(join(directory, path)))]));

async function probe(source, scenario) {
  register('../tests/correctness/streaming-tool-executor-loader.mjs', import.meta.url);
  const { StreamingToolExecutor } = await import(pathToFileURL(join(source, sourceFiles[0])));
  const directory = mkdtempSync(join(tmpdir(), 'future-task-read-'));
  const modules = scenario === 'multi-module-repair' ? 8 : scenario === 'git-delivery' ? 3 : 1;
  const sourcePaths = scenario === 'config-repair' ? ['config.json'] : Array.from({ length: modules }, (_, i) => `module-${i}.mjs`);
  const before = {}, toolExecutions = [], rounds = [], observed = {};
  let active = new Set(), cancelledUsefulReads = 0, mutationExecutions = 0;
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const block = (id, input) => ({ id, name: 'Bash', input });
  const result = (id, content, is_error = false) => ({ message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error: true } : {}) }] } } });
  try {
    for (const path of sourcePaths) {
      const content = path.endsWith('.json') ? JSON.stringify({ port: 8080, enabled: true, name: 'task-fixture' }) + '\n' :
        `export const sum=(a,b)=>a-b;\nexport const marker='preserved-${sourcePaths.indexOf(path)}';\n`;
      writeFileSync(join(directory, path), content); before[path] = hash(content);
    }
    writeFileSync(join(directory, 'existing-hint.txt'), 'the current source paths are authoritative\n');
    if (scenario === 'git-delivery') {
      git('init', '--quiet', '--initial-branch=main'); git('config', 'user.name', 'Task Experiment');
      git('config', 'user.email', 'experiment@example.invalid'); git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(directory, '.gitignore'), 'remote.git/\n');
      git('add', '.'); git('commit', '--quiet', '-m', 'Initial fixture');
      git('init', '--quiet', '--bare', 'remote.git'); git('remote', 'add', 'origin', './remote.git');
      writeFileSync(join(directory, '.git/hooks/pre-commit'), '#!/bin/sh\nprintf "checked\\n" >> .git/hook-receipt\n', { mode: 0o755 });
    }
    const definitions = [{ name: 'Bash', inputSchema: { safeParse: data => ({ success: true, data }) },
      isConcurrencySafe: input => input.kind === 'read', interruptBehavior: () => 'cancel' }];
    const controller = new AbortController();
    const context = { abortController: controller, options: { tools: definitions },
      setInProgressToolUseIDs: update => { active = update(active); }, setHasInterruptibleToolInProgress() {} };
    globalThis.__futureStreamingToolTest = async function* (call, _message, _permission, toolContext) {
      toolExecutions.push({ id: call.id, kind: call.input.kind, path: call.input.path ?? null });
      if (call.input.kind === 'framework') throw new Error('controlled shell collection failure');
      if (call.input.kind === 'read') {
        // An actual missing-file diagnostic precedes successful peer receipts.
        // Peer cat processes still execute; the host decides whether to retain them.
        if (call.input.path === 'obsolete-hint.txt') {
          const read = spawnSync('cat', [join(directory, call.input.path)], { encoding: 'utf8' });
          assert.equal(read.status, 1); yield result(call.id, read.stderr, true); return;
        }
        const child = spawn('cat', [join(directory, call.input.path)], { signal: toolContext.abortController.signal, stdio: ['ignore', 'pipe', 'pipe'] });
        const read = await new Promise(resolve => {
          let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
          child.once('error', error => { stderr += String(error); });
          child.once('close', code => resolve({ stdout, stderr, code }));
        });
        yield result(call.id, read.code === 0 ? read.stdout : read.stderr, read.code !== 0); return;
      }
      if (call.input.kind === 'write') {
        mutationExecutions++;
        if (call.input.forbidden) writeFileSync(join(directory, 'MUTATION-MUST-NOT-RUN'), 'bad\n');
        else for (const path of sourcePaths) {
          assert.equal(typeof observed[path], 'string', 'worker cannot patch without a useful source receipt');
          const content = path.endsWith('.json') ? JSON.stringify({ ...JSON.parse(observed[path]), port: 9090 }) + '\n' : observed[path].replace('=>a-b;', '=>a+b;');
          assert.notEqual(hash(content), before[path]); writeFileSync(join(directory, path), content);
        }
        yield result(call.id, 'file mutation completed'); return;
      }
      if (call.input.kind === 'verify') {
        const check = spawnSync(process.execPath, [join(fixture, 'check-task.mjs'), directory, scenario, String(modules)], { encoding: 'utf8', timeout: 5000 });
        yield result(call.id, check.stdout || check.stderr, check.status !== 0); return;
      }
      if (call.input.kind === 'deliver') {
        git('add', '--', ...sourcePaths); git('commit', '--quiet', '-m', 'Repair fixture'); git('push', '--quiet', 'origin', 'HEAD:main');
        yield result(call.id, git('rev-parse', 'HEAD')); return;
      }
      throw new Error('unknown controlled tool operation');
    };
    async function issue(calls, label, cancel = false) {
      const executor = new StreamingToolExecutor(definitions, () => {}, context), receipts = [];
      for (const call of calls) executor.addTool(call, { uuid: `assistant-${call.id}`, message: { id: `response-${call.id}` } });
      if (cancel) controller.abort('operator cancellation');
      for await (const update of executor.getRemainingResults()) if (update.message?.type === 'user') receipts.push(...update.message.message.content);
      assert.equal(active.size, 0); assert.equal(receipts.length, calls.length, 'one paired receipt per admitted call');
      for (const call of calls) assert.equal(receipts.filter(receipt => receipt.tool_use_id === call.id).length, 1);
      for (const call of calls.filter(call => sourcePaths.includes(call.input.path))) {
        const receipt = receipts.find(receipt => receipt.tool_use_id === call.id);
        if (!receipt.is_error) observed[call.input.path] = receipt.content;
        if (receipt.is_error && String(receipt.content).includes('Cancelled:')) cancelledUsefulReads++;
      }
      rounds.push({ label, calls: calls.map(call => ({ id: call.id, input: call.input })), receipts });
      return receipts;
    }
    const start = performance.now();
    if (['failed-prerequisite', 'framework-failure', 'operator-cancel'].includes(scenario)) {
      const first = scenario === 'framework-failure' ? block('framework', { kind: 'framework' }) : block('missing', { kind: 'read', path: 'obsolete-hint.txt' });
      await issue([first, block('useful-peer', { kind: 'read', path: sourcePaths[0] }),
        block('forbidden', { kind: 'write', forbidden: true }), block('after-mutation', { kind: 'read', path: sourcePaths[0] })], 'guardrail', scenario === 'operator-cancel');
      assert.equal(mutationExecutions, 0);
      assert.equal(controller.signal.aborted, scenario === 'operator-cancel');
    } else {
      await issue([block('hint', { kind: 'read', path: scenario === 'healthy-code' ? 'existing-hint.txt' : 'obsolete-hint.txt' }),
        ...sourcePaths.map((path, index) => block(`source-${index}`, { kind: 'read', path }))], 'inspect');
      const missing = sourcePaths.filter(path => observed[path] === undefined);
      if (missing.length) await issue(missing.map((path, index) => block(`recover-${index}`, { kind: 'read', path })), 'recover-useful-reads');
      await issue([block('patch', { kind: 'write' })], 'patch');
      // Verify actual code behavior before delivery, and independently again below.
      if (scenario !== 'git-delivery') {
        const checked = await issue([block('check', { kind: 'verify' })], 'verify'); assert.equal(checked[0].is_error, undefined);
      } else {
        const check = spawnSync(process.execPath, ['--input-type=module', '-e',
          'import assert from "node:assert/strict"; for(let i=0;i<3;i++){const m=await import(process.cwd()+`/module-${i}.mjs`);assert.equal(m.sum(4,-2),2)}'],
          { cwd: directory, encoding: 'utf8', timeout: 5000 }); assert.equal(check.status, 0, check.stderr);
        await issue([block('delivery', { kind: 'deliver' })], 'verified-delivery');
      }
    }
    const independent = spawnSync(process.execPath, [join(fixture, 'check-task.mjs'), directory, scenario, String(modules)], { encoding: 'utf8', timeout: 5000 });
    assert.equal(independent.status, 0, independent.stderr);
    const wallMs = performance.now() - start;
    const taskSolved = !['failed-prerequisite', 'framework-failure', 'operator-cancel'].includes(scenario);
    return { scenario, modules, verdict: 'PASS', taskSolved, outcome: taskSolved ? 'REPAIR_PASSED' : 'GUARDRAIL_PASSED_NO_REPAIR',
      workerRounds: rounds.length, forcedRecoveryRounds: rounds.filter(round => round.label === 'recover-useful-reads').length,
      actualToolExecutions: toolExecutions.length, cancelledUsefulReads, mutationExecutions,
      wallMs, artifactBefore: before, artifactAfter: Object.fromEntries(sourcePaths.map(path => [path, hash(readFileSync(join(directory, path)))])),
      independentCheck: JSON.parse(independent.stdout), toolExecutions, rounds };
  } finally { delete globalThis.__futureStreamingToolTest; rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[2] === '--probe') {
  const [source, scenario] = process.argv.slice(3); assert(cases.includes(scenario));
  process.stdout.write(JSON.stringify(await probe(resolve(source), scenario)));
} else {
  const [baseline, output, sampleText = String(contract.design.samples_per_arm_per_case)] = process.argv.slice(2);
  assert(baseline && output, 'usage: node scripts/bench-task-read-recovery.mjs BASELINE OUTPUT [SAMPLES]');
  const samples = Number(sampleText); assert(Number.isSafeInteger(samples) && samples > 0 && samples <= 20);
  const sources = { baseline: resolve(baseline), candidate: root }, frozenSources = Object.fromEntries(Object.entries(sources).map(([arm, directory]) => [arm, hashes(directory)]));
  const sourceRevisions = Object.fromEntries(Object.entries(sources).map(([arm, directory]) => [arm, {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: directory, encoding: 'utf8' }).trim(),
    dirtyMeasuredPaths: execFileSync('git', ['status', '--porcelain', '--', ...sourceFiles], { cwd: directory, encoding: 'utf8' }).trim(),
  }]));
  assert.equal(sourceRevisions.baseline.head, contract.baseline, 'baseline is not the pinned revision');
  assert.equal(sourceRevisions.baseline.dirtyMeasuredPaths, '', 'baseline production source is modified');
  const inputs = [self, join(fixture, 'check-task.mjs'), join(fixture, 'contract.json'), join(root, 'tests/correctness/streaming-tool-executor-loader.mjs')];
  const frozenInputs = Object.fromEntries(inputs.map(path => [path.replace(root + '/', ''), hash(readFileSync(path))]));
  const runs = [];
  for (let sample = 0; sample < samples; sample++) for (const scenario of cases) for (const arm of sample % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', self, '--probe', sources[arm], scenario], { encoding: 'utf8', timeout: 15000, maxBuffer: 8_000_000 });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr); runs.push({ sample, arm, ...JSON.parse(child.stdout) });
  }
  const summary = {};
  for (const scenario of cases) {
    summary[scenario] = {};
    const rows = runs.filter(row => row.scenario === scenario);
    assert.equal(new Set(rows.map(row => JSON.stringify(row.artifactAfter))).size, 1, 'artifact mismatch across paired arms');
    for (const arm of Object.keys(sources)) {
      const selected = rows.filter(row => row.arm === arm), median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      summary[scenario][arm] = { protocolPasses: selected.filter(row => row.verdict === 'PASS').length,
        completedRepairs: selected.filter(row => row.taskSolved).length, guardrailPasses: selected.filter(row => !row.taskSolved).length,
        workerRounds: selected.map(row => row.workerRounds), forcedRecoveryRounds: selected.reduce((sum, row) => sum + row.forcedRecoveryRounds, 0),
        cancelledUsefulReads: selected.reduce((sum, row) => sum + row.cancelledUsefulReads, 0),
        actualToolExecutions: selected.reduce((sum, row) => sum + row.actualToolExecutions, 0), medianWallMs: median(selected.map(row => row.wallMs)) };
      if (contract.design.read_failure_cases.includes(scenario)) assert(selected.every(row => row.forcedRecoveryRounds === (arm === 'baseline' ? 1 : 0)));
      if (contract.design.controls.includes(scenario)) assert(selected.every(row => row.forcedRecoveryRounds === 0));
    }
  }
  for (const [arm, directory] of Object.entries(sources)) assert.deepEqual(hashes(directory), frozenSources[arm], 'production source changed during experiment');
  assert.deepEqual(Object.fromEntries(inputs.map(path => [path.replace(root + '/', ''), hash(readFileSync(path))])), frozenInputs, 'experiment input changed');
  const report = { schema: 1, kind: 'REAL_TASK_COMPONENT_REPRODUCTION_NOT_LIVE_MODEL_BENCHMARK', baseline: contract.baseline,
    samplesPerArm: samples, runtime: { node: process.version, platform: process.platform, arch: process.arch }, sourceRevisions, sourceHashes: frozenSources, inputHashes: frozenInputs,
    modelCalls: 0, modelTokens: null, dollars: null, summary, runs, limitations: contract.limitations };
  mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ trials: runs.length, summary }, null, 2) + '\n');
}
