#!/usr/bin/env node
// Compare real production collection paths using deterministic tool/label
// services. Zero live API calls; not an end-to-end productivity benchmark.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const baseline = resolve(args.get('--baseline') ?? resolve(root, '../future-code-baseline'));
const samples = Number(args.get('--samples') ?? 5);
assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 20);
const files = ['src/services/tools/StreamingToolExecutor.ts', 'src/query.ts', 'src/utils/opportunisticTask.ts'];
const hash = value => createHash('sha256').update(value).digest('hex');
const revision = path => execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const hashes = path => Object.fromEntries(files.flatMap(file => {
  try { return [[file, hash(readFileSync(resolve(path, file)))]]; } catch (error) {
    if (error.code === 'ENOENT') return []; throw error;
  }
}));
const runs = [];
const cases = ['short', 'blocked', 'cancel', 'progress', 'summary-short', 'summary-long'];
for (let sample = 0; sample < samples; sample++) {
  // Alternate arm order to avoid always giving the candidate the warmer host.
  const arms = sample % 2 ? [['candidate', root], ['baseline', baseline]] : [['baseline', baseline], ['candidate', root]];
  for (const [arm, source] of arms) for (const scenario of cases) {
    const summary = scenario.startsWith('summary-');
    const fixture = resolve(root, 'tests/correctness/fixtures', summary ? 'summary-collection-probe.mjs' : 'tool-collection-probe.mjs');
    const parameters = summary ? [scenario === 'summary-long' ? '12' : '1', scenario === 'summary-long' ? '75' : '250'] : [scenario, '500'];
    const child = spawnSync(process.execPath, ['--experimental-strip-types', fixture, source, ...parameters],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 1_000_000 });
    const timeout = child.error?.code === 'ETIMEDOUT';
    if (timeout) {
      assert.ok(arm === 'baseline' && ['blocked', 'cancel'].includes(scenario), `Unexpected timeout: ${arm}/${scenario}`);
      runs.push({ sample, arm, scenario, status: 'TIMEOUT', deadlineMs: 3000 });
      continue;
    }
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    if (!summary) {
      assert.deepEqual(result.inProgress, []);
      assert.equal(result.effects, scenario === 'progress' ? 0 : 1);
      assert.equal(result.receipts.length, ['blocked', 'cancel'].includes(scenario) ? 3 : 2);
      if (scenario === 'cancel') assert.ok(result.receipts.every(r => r.is_error));
      if (scenario === 'blocked') assert.equal(result.receipts.filter(r => r.is_error).length, 1);
      if (scenario === 'progress') assert.equal(result.progressCount, 500);
    } else assert.equal(result.parentAborted, false);
    runs.push({ sample, arm, scenario, status: 'COMPLETE', ...result });
  }
}
const median = values => { const v = [...values].sort((a, b) => a - b), i = Math.floor(v.length / 2); return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
const results = {};
for (const scenario of cases) {
  results[scenario] = {};
  for (const arm of ['baseline', 'candidate']) {
    const all = runs.filter(r => r.arm === arm && r.scenario === scenario), complete = all.filter(r => r.status === 'COMPLETE');
    results[scenario][arm] = { complete: complete.length, timeouts: all.length - complete.length,
      medianMs: complete.length ? median(complete.map(r => r.elapsedMs)) : null,
      medianCompletionObservers: scenario === 'progress' && complete.length ? median(complete.map(r => r.subscriptions)) : null };
  }
  if (['short', 'progress'].includes(scenario)) {
    const comparable = runs.filter(r => r.scenario === scenario && r.status === 'COMPLETE');
    assert.equal(new Set(comparable.map(r => hash(JSON.stringify(r.receipts)))).size, 1, 'actual receipts changed');
    assert.equal(new Set(comparable.map(r => r.progressHash)).size, 1, 'progress changed');
  }
}
process.stdout.write(JSON.stringify({ schema: 1, kind: 'OFFLINE_COLLECTION_PATHS_NOT_LIVE_RND_PRODUCTIVITY',
  runtime: { node: process.version, platform: process.platform, arch: process.arch }, samplesPerArm: samples,
  source: { baseline: { revision: revision(baseline), hashes: hashes(baseline) }, candidate: { baseRevision: revision(root), hashes: hashes(root) } },
  results, runs }, null, 2) + '\n');
