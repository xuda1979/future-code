#!/usr/bin/env node
// Identical frozen behavioral contracts against two actual source trees.
// Does not install packages, call an LLM or alter either input checkout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [baselineArg, outputArg] = process.argv.slice(2);
assert(baselineArg && outputArg, 'usage: node scripts/bench-goal-regressions.mjs BASELINE OUTPUT');
const baseline = resolve(baselineArg), output = resolve(outputArg);
const files = ['tests/commands/goal-authorization-continuity.test.ts', 'tests/commands/goal-blocker-evidence.test.ts',
  'tests/correctness/goal-work-state.test.ts', 'tests/correctness/action-focus.test.ts',
  'tests/correctness/direct-execution.test.ts'];
const sources = ['src/commands/goal/auto.ts', 'src/commands/goal/context.ts', 'src/commands/goal/workState.ts',
  'src/commands/goal/actionFocus.ts', 'src/harness/autonomyPolicy.ts'];
const hash = value => createHash('sha256').update(value).digest('hex');
const testHashes = Object.fromEntries(files.map(path => [path, hash(readFileSync(join(root, path)))]));
const rows = [];
for (const [arm, source] of Object.entries({ baseline, candidate: root })) {
  const fixture = mkdtempSync(join(tmpdir(), 'goal-regression-arm-'));
  try {
    symlinkSync(join(source, 'src'), join(fixture, 'src'), 'dir');
    for (const path of files) { mkdirSync(dirname(join(fixture, path)), { recursive: true }); copyFileSync(join(root, path), join(fixture, path)); }
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', ...files], {
      cwd: fixture, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key,
      Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(result.stdout)?.[1] ?? NaN)]));
    assert(Number.isFinite(counts.tests) && counts.tests > 0, result.stderr + result.stdout.slice(-2000));
    rows.push({ arm, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
      exitCode: result.status, counts, contracts: [...result.stdout.matchAll(/^(ok|not ok) \d+ - (.+)$/gm)]
        .map(match => ({ pass: match[1] === 'ok', name: match[2] })),
      sourceHashes: Object.fromEntries(sources.map(path => [path, existsSync(join(source, path)) ? hash(readFileSync(join(source, path))) : null])),
    });
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}
assert.equal(rows[1].exitCode, 0); assert.equal(rows[1].counts.fail, 0);
assert(rows[0].counts.fail > 0 && rows[0].exitCode !== 0, 'baseline must reproduce the bug');
assert.equal(rows[0].counts.tests, rows[1].counts.tests);
assert.deepEqual(testHashes, Object.fromEntries(files.map(path => [path, hash(readFileSync(join(root, path)))])), 'frozen contracts changed during measurement');
const record = { schema: 1, measurement: 'offline behavioral regression contracts against immutable baseline code',
  limitations: ['No live-LLM task success, latency, token-efficiency or IBM score is measured.',
    'Production end-turn/question fallback effects are tested separately in goal-decision-flow.test.ts.'],
  command: 'node scripts/bench-goal-regressions.mjs BASELINE OUTPUT', node: process.versions.node, testHashes, rows };
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ output, rows: rows.map(({ arm, counts, exitCode }) => ({ arm, counts, exitCode })) }, null, 2));
