#!/usr/bin/env node
/** Create a pinned, standalone generic R&D project for cross-agent trials. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = fileURLToPath(new URL('../examples/agent-comparison/', import.meta.url));
const fixtureDir = join(suiteDir, 'fixtures', 'general-research');
const sourceFiles = ['metrics.py', 'manifests.py', 'candidates.py', 'jobs.py', 'README.md'];
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export function prepareFixture(target) {
  const root = resolve(target);
  assert(!existsSync(root), 'fixture output already exists; choose a new directory');
  mkdirSync(root, { recursive: true });
  const project = join(root, 'research-project');
  mkdirSync(project);
  for (const file of sourceFiles) copyFileSync(join(fixtureDir, file), join(project, file));
  git(project, ['init', '--quiet']);
  git(project, ['add', '--', ...sourceFiles]);
  git(project, ['-c', 'user.name=Benchmark Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Frozen generic R&D regression fixture']);
  const baseCommit = git(project, ['rev-parse', 'HEAD']);
  assert(/^[a-f0-9]{40}$/.test(baseCommit), 'invalid frozen fixture SHA');
  assert.equal(git(project, ['status', '--porcelain']), '', 'fixture must have clean baseline');

  const testCase = (id, tier, file, instruction, timeoutMs) => ({
    id, tier, instruction,
    check: ['python3', '{suite_dir}/research_check.py', id],
    redMarker: 'RED_CONTROL_' + id,
    allowedPaths: [file], protectedPaths: ['README.md'], timeoutMs,
  });
  const config = {
    schema: 1, mode: 'live', repository: realpathSync(project), baseCommit,
    suiteDir, repetitions: 5,
    agents: [
      { name: 'future-code', model: 'PIN_ACTUAL_MODEL', version: 'PIN_RUNTIME_VERSION',
        argv: ['future-code-benchmark-adapter', '{prompt}', '{workspace}'] },
      { name: 'claude-code', model: 'PIN_ACTUAL_MODEL', version: 'PIN_RUNTIME_VERSION',
        argv: ['claude-code-benchmark-adapter', '{prompt}', '{workspace}'] },
      { name: 'codex', model: 'PIN_ACTUAL_MODEL', version: 'PIN_RUNTIME_VERSION',
        argv: ['codex-benchmark-adapter', '{prompt}', '{workspace}'] },
    ],
    cases: [
      testCase('metrics-fidelity', 'simple', 'metrics.py',
        'Fix the verified-outcome metric so string/number statuses never count as boolean success. Preserve real booleans and empty batches; edit only metrics.py.', 180000),
      testCase('manifest-integrity', 'medium', 'manifests.py',
        'Require experiment-manifest count, IDs and per-domain counts to match measured records. Preserve duplicate-ID detection and valid manifests; edit only manifests.py.', 360000),
      testCase('candidate-completeness', 'medium', 'candidates.py',
        'In generated-candidate mode, never silently substitute reference answers for absent model outputs. Retain explicit reference-only mode; edit only candidates.py.', 360000),
      testCase('job-idempotence', 'research', 'jobs.py',
        'Make remote experiment submission idempotent across retries. Reuse the existing job identity for matching requests; reject changed inputs sharing a key; allow independent jobs; edit only jobs.py.', 600000),
    ],
  };
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return { project, baseCommit, configPath, cases: config.cases.length,
    note: 'Prepared offline fixture and live benchmark manifest; adapter commands are unconfigured placeholders.' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out') {
    console.error('Usage: node scripts/prepare-agent-comparison-fixture.mjs --out NEW_DIR');
    process.exitCode = 2;
  } else try { console.log(JSON.stringify(prepareFixture(args[1]), null, 2)); }
    catch (error) { console.error(error); process.exitCode = 1; }
}
