#!/usr/bin/env node
// Production Bash generator under controlled shell lifecycle events. Measures
// foreground release, never remote command completion or live-model speed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bashBackgroundFixture } from '../tests/correctness/fixtures/bash-background-fixture.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = resolve(process.argv[2] ?? '../future-code-baseline');
const samples = Number(process.argv[3] ?? 5);
assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 20);
const sources = Object.fromEntries([['baseline', baseline], ['candidate', root]].map(([arm, path]) =>
  [arm, readFileSync(resolve(path, 'src/tools/BashTool/BashTool.tsx'), 'utf8')]));
const scenarios = ['timeout-background', 'manual-background', 'new-user-input'];
const runs = [];
for (let sample = 0; sample < samples; sample++) for (const arm of sample % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
  for (const scenario of scenarios) {
    const f = bashBackgroundFixture({ source: sources[arm] });
    await f.startProgress();
    const pending = f.generator.next();
    let timer;
    const started = performance.now();
    try {
      if (scenario === 'timeout-background') f.timeout();
      else if (scenario === 'manual-background') assert.equal(f.shell.background(), true);
      else f.controller.abort('interrupt');
      const result = await Promise.race([pending, new Promise(resolve => {
        timer = setTimeout(() => resolve(null), 250);
      })]);
      const elapsedMs = performance.now() - started;
      const released = result !== null;
      if (released) {
        assert.equal(result.done, true);
        assert.equal(result.value.backgroundTaskId, 'task-1');
        assert.equal(result.value.interrupted, false);
        assert.equal(f.counts.cleanup, 0, 'live task retains output ownership');
        assert.equal(f.shell.status, 'backgrounded');
      }
      assert.equal(f.counts.executions, 1);
      assert.equal(f.counts.foreground, 1);
      assert.equal(f.counts.spawned, 0, 'handoff cannot launch another task');
      runs.push({ sample, arm, scenario, outcome: released ? 'FOREGROUND_RELEASED' : 'BLOCKED_AT_OBSERVATION_LIMIT',
        elapsedMs, observationLimitMs: 250, counts: { ...f.counts } });
    } finally {
      clearTimeout(timer);
      f.complete();
      await pending;
    }
  }
}
const median = values => { const v = [...values].sort((a,b) => a-b), i = Math.floor(v.length/2); return v.length%2 ? v[i] : (v[i-1]+v[i])/2; };
const results = Object.fromEntries(scenarios.map(scenario => [scenario, Object.fromEntries(['baseline','candidate'].map(arm => {
  const rows = runs.filter(r => r.scenario === scenario && r.arm === arm);
  return [arm, { released: rows.filter(r => r.outcome === 'FOREGROUND_RELEASED').length,
    blockedAtObservationLimit: rows.filter(r => r.outcome !== 'FOREGROUND_RELEASED').length,
    medianObservedMs: median(rows.map(r => r.elapsedMs)) }];
}))]));
const hash = text => createHash('sha256').update(text).digest('hex');
console.log(JSON.stringify({ schema: 1, kind: 'OFFLINE_SHELL_HANDOFF', samplesPerArm: samples,
  scope: 'Production generator with scripted process/UI dependencies and no output polling. Timers are driven as lifecycle events. Censored baseline waits are not completion times. No live command, LLM, or human speed claim.',
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  source: Object.fromEntries([['baseline',baseline],['candidate',root]].map(([arm,path]) => [arm, {
    revision: execFileSync('git', ['-C',path,'rev-parse','HEAD'], {encoding:'utf8'}).trim(),
    bashSha256: hash(sources[arm]), shellCommandSha256: hash(readFileSync(resolve(path,'src/utils/ShellCommand.ts'))) }])),
  fixtureSha256: hash(readFileSync(resolve(root,'tests/correctness/fixtures/bash-background-fixture.mjs'))),
  results, runs }, null, 2));
