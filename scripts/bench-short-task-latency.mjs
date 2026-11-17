#!/usr/bin/env node
// Matched production host paths with controlled external services. No model
// calls, human timing estimates, or cancellation mislabeled as a completed task.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = resolve(process.argv[2] ?? '../future-code-baseline');
const samples = Number(process.argv[3] ?? 5);
assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 20);
const scenarios = ['read-status-diff', 'edit-and-diagnose', 'stalled-edit'];
const runs = [];
for (let sample = 0; sample < samples; sample++) {
  const arms = sample % 2 ? [['candidate', root], ['baseline', baseline]] : [['baseline', baseline], ['candidate', root]];
  for (const [arm, source] of arms) for (const scenario of scenarios) {
    const child = spawnSync(process.execPath, ['--experimental-strip-types',
      resolve(root, 'tests/correctness/fixtures/short-task-latency-probe.mjs'), source, scenario],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1_000_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    runs.push({ sample, arm, ...JSON.parse(child.stdout) });
  }
}
const median = values => { const v = [...values].sort((a,b) => a-b), i = Math.floor(v.length / 2); return v.length % 2 ? v[i] : (v[i-1] + v[i])/2; };
const results = {};
for (const scenario of scenarios) {
  const rows = runs.filter(r => r.scenario === scenario);
  assert.equal(new Set(rows.map(r => r.outputSha256)).size, 1, 'local result changed between arms');
  assert.equal(new Set(rows.map(r => JSON.stringify(r.diagnosticMessages))).size, 1, 'diagnostic feedback changed');
  results[scenario] = Object.fromEntries(['baseline', 'candidate'].map(arm => {
    const selected = rows.filter(r => r.arm === arm);
    return [arm, { complete: selected.filter(r => r.outcome === 'COMPLETE').length,
      blockedAtObservationLimit: selected.filter(r => r.outcome !== 'COMPLETE').length,
      medianObservedMs: median(selected.map(r => r.elapsedMs)),
      medianLocalOperationMs: median(selected.map(r => r.operationMs)),
      rpcCalls: selected.map(r => r.rpcCalls) }];
  }));
}
const sourceFiles = ['src/services/diagnosticTracking.ts', 'src/services/mcp/client.ts',
  'src/tools/FileEditTool/FileEditTool.ts', 'src/tools/FileWriteTool/FileWriteTool.ts', 'src/utils/attachments.ts'];
const hash = data => createHash('sha256').update(data).digest('hex');
const provenance = path => ({ revision: execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceSha256: Object.fromEntries(sourceFiles.map(file => [file, hash(readFileSync(resolve(path, file)))])) });
console.log(JSON.stringify({ schema: 1, kind: 'OFFLINE_SHORT_TASK_HOST_PATHS', samplesPerArm: samples,
  scope: 'Real local Git/read/edit operations and production diagnostic tracking with 50ms or unresolved IDE fixture. No live LLM or measured human comparison. Stalled-edit timing measures release of advisory feedback, not task completion.',
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  source: { baseline: provenance(baseline), candidate: provenance(root) },
  fixtureSha256: hash(readFileSync(resolve(root, 'tests/correctness/fixtures/short-task-latency-probe.mjs'))),
  results, runs }, null, 2));
