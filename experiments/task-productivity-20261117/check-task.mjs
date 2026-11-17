import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [directory, scenario, modulesText = '1'] = process.argv.slice(2);
const root = resolve(directory), modules = Number(modulesText);
const scenarios = ['config-repair', 'code-repair', 'multi-module-repair', 'git-delivery',
  'healthy-code', 'failed-prerequisite', 'framework-failure', 'operator-cancel'];
assert(scenarios.includes(scenario), 'unknown task scenario');
assert.equal(modules, scenario === 'multi-module-repair' ? 8 : scenario === 'git-delivery' ? 3 : 1,
  'missing or invalid task module count');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (['failed-prerequisite', 'framework-failure', 'operator-cancel'].includes(scenario)) {
  assert.equal(existsSync(join(root, 'MUTATION-MUST-NOT-RUN')), false);
} else if (scenario === 'config-repair') {
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')), { port: 9090, enabled: true, name: 'task-fixture' });
} else {
  for (let i = 0; i < modules; i++) {
    const api = await import(pathToFileURL(join(root, `module-${i}.mjs`)));
    for (const [a, b] of [[0, 0], [1, 2], [-7, 3], [123, -45], [0.5, 0.25]]) assert.equal(api.sum(a, b), a + b);
    assert.equal(api.marker, `preserved-${i}`);
  }
  if (scenario === 'git-delivery') {
    assert.equal(git('status', '--porcelain'), '');
    const head = git('rev-parse', 'HEAD');
    assert.equal(git('--git-dir=remote.git', 'rev-parse', 'refs/heads/main'), head);
    assert.equal(git('rev-list', '--count', 'HEAD'), '2');
    assert.equal(readFileSync(join(root, '.git/hook-receipt'), 'utf8'), 'checked\n');
    for (let i = 0; i < modules; i++) assert.equal(git('--git-dir=remote.git', 'show', `main:module-${i}.mjs`), readFileSync(join(root, `module-${i}.mjs`), 'utf8').trim());
  }
}
process.stdout.write(JSON.stringify({ verdict: 'PASS', scenario, modules }));
