import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareFixture } from '../../scripts/prepare-agent-comparison-fixture.mjs';

const suite = fileURLToPath(new URL('../../examples/agent-comparison/', import.meta.url));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'general-rnd-fixture-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prepared = prepareFixture(join(root, 'prepared'));
  const config = JSON.parse(readFileSync(prepared.configPath, 'utf8'));
  const check = id => spawnSync('python3', [join(suite, 'research_check.py'), id], {
    cwd: prepared.project, encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  return { ...prepared, config, check };
}
test('fixture is a standalone pinned and clean R&D Git project', t => {
  const f = setup(t);
  assert.equal(git(f.project, ['rev-parse', 'HEAD']), f.baseCommit);
  assert.equal(git(f.project, ['status', '--porcelain']), '');
  assert.equal(f.config.repository, resolve(f.project));
  assert.equal(f.config.cases.length, 4);
  assert.deepEqual(new Set(f.config.cases.map(c => c.tier)), new Set(['simple', 'medium', 'research']));
  assert(!JSON.stringify(f.config).includes('quantum-gpt'));
  assert(!JSON.stringify(f.config).includes('xuda1979'));
});
test('all four independent negative controls reproduce and preserve clean input', t => {
  const f = setup(t);
  for (const task of f.config.cases) {
    const check = f.check(task.id);
    assert.equal(check.status, 1, task.id + ': ' + check.stderr);
    assert((check.stdout + check.stderr).includes(task.redMarker), task.id);
    assert.equal(git(f.project, ['status', '--porcelain']), '', 'checker must not edit target');
  }
});
test('independent checks accept correct source changes in all four disciplines', t => {
  const f = setup(t);
  const replacements = [
    ['metrics.py', 'bool(row.get("verified"))', 'row.get("verified") is True'],
    ['manifests.py', 'checks = {"unique_ids": len(ids) == len(set(ids))}',
      'checks = {"unique_ids": len(ids) == len(set(ids)), "count": actual["count"] == manifest["count"], "ids": actual["ids"] == manifest["ids"], "domains": actual["domains"] == manifest["domains"]}'],
    ['candidates.py', 'selected = proposals or references',
      'selected = references if proposals is None else proposals'],
    ['jobs.py', '    job_id = submit(request)',
      '    if job_key in ledger:\n        prior = ledger[job_key]\n        if prior["request"] != request:\n            raise ValueError("remote identity collision")\n        return prior["job_id"]\n    job_id = submit(request)'],
  ];
  for (const [name, oldText, newText] of replacements) {
    const file = join(f.project, name);
    const original = readFileSync(file, 'utf8');
    assert(original.includes(oldText));
    writeFileSync(file, original.replace(oldText, newText));
  }
  for (const task of f.config.cases) {
    const check = f.check(task.id);
    assert.equal(check.status, 0, task.id + ': ' + check.stderr);
    assert(check.stdout.includes('PASS_' + task.id));
  }
});
test('cannot silently overwrite an existing fixture directory', t => {
  const f = setup(t);
  assert.throws(() => prepareFixture(resolve(f.project)), /already exists/);
});
