// Real local operations + production advisory-diagnostic hook. The IDE is a
// deterministic fixture; these are host-path timings, not live agent scores.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
register('../diagnostics-latency-loader.mjs', import.meta.url);

const [root, scenario] = process.argv.slice(2);
const { DiagnosticTrackingService } = await import(pathToFileURL(resolve(root, 'src/services/diagnosticTracking.ts')).href);
const tracker = new DiagnosticTrackingService();
tracker.initialize({ type: 'connected', name: 'controlled-ide' });
const project = mkdtempSync(join(tmpdir(), 'future-short-task-'));
const file = join(project, 'settings.json');
writeFileSync(file, '{"port":3000}\n');
const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' });
git('init', '-q'); git('add', 'settings.json');
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
const result = files => [{ type: 'text', text: JSON.stringify(files) }];
const error = { message: 'fixture diagnostic remains visible', severity: 'Error',
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
let rpcCalls = 0, release, lastSignal, observationTimer;
globalThis.__diagnosticRpc = async (_tool, args, _client, signal) => {
  rpcCalls++; lastSignal = signal;
  if (scenario === 'stalled-edit') return new Promise(resolve => { release = resolve; });
  await new Promise(resolve => setTimeout(resolve, 50));
  return result(args.uri ? [{ uri: args.uri, diagnostics: [] }] : [{ uri: `file://${file}`, diagnostics: [error] }]);
};
let operationMs = 0;
const operation = fn => { const at = performance.now(); const value = fn(); operationMs += performance.now() - at; return value; };
const started = performance.now();
try {
  let outcome = 'COMPLETE', diagnostics = [], observedAt;
  if (scenario === 'read-status-diff') {
    assert.equal(operation(() => git('status', '--porcelain')), '');
    diagnostics.push(...await tracker.getNewDiagnostics());
    assert.equal(operation(() => readFileSync(file, 'utf8')), '{"port":3000}\n');
    diagnostics.push(...await tracker.getNewDiagnostics());
    assert.equal(operation(() => git('diff', '--check')), '');
    diagnostics.push(...await tracker.getNewDiagnostics());
    assert.deepEqual(diagnostics, []);
  } else if (scenario === 'edit-and-diagnose') {
    await tracker.beforeFileEdited(file);
    operation(() => writeFileSync(file, '{"port":3001}\n'));
    diagnostics = await tracker.getNewDiagnostics();
    assert.deepEqual(diagnostics, [{ uri: `file://${file}`, diagnostics: [error] }]);
    assert.equal(operation(() => git('diff', '--check')), '');
  } else if (scenario === 'stalled-edit') {
    const pending = tracker.beforeFileEdited(file);
    outcome = await Promise.race([pending.then(() => 'COMPLETE'), new Promise(resolve => {
      observationTimer = setTimeout(() => resolve('BLOCKED_AT_OBSERVATION_LIMIT'), 1500);
    })]);
    observedAt = performance.now() - started;
    clearTimeout(observationTimer);
    // Release the controlled dependency only for cleanup after observation.
    release(result([]));
    await pending;
    if (outcome === 'COMPLETE') assert.equal(lastSignal?.aborted, true);
  } else throw new Error(`Unknown scenario: ${scenario}`);
  const elapsedMs = observedAt ?? performance.now() - started;
  const outputSha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  console.log(JSON.stringify({ scenario, outcome, elapsedMs, operationMs, rpcCalls,
    outputSha256, diagnosticMessages: diagnostics.map(f => f.diagnostics.map(d => d.message)),
    fixtureIdeResponseMs: scenario === 'stalled-edit' ? null : 50,
    observationLimitMs: scenario === 'stalled-edit' ? 1500 : null }));
} finally {
  clearTimeout(observationTimer);
  await tracker.shutdown();
  rmSync(project, { recursive: true, force: true });
}
