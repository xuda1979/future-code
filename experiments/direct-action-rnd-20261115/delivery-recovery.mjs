#!/usr/bin/env node
// Actual Git delivery through the production continuation decision. This is
// a deterministic host-lifecycle reproduction, NOT a live-model speed score.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const here = fileURLToPath(new URL('.', import.meta.url));
const sources = '/tmp/future-code-live-canary-20261115/sources';
const modules = Object.fromEntries(await Promise.all(['base', 'candidate'].map(async arm =>
  [arm, await import(pathToFileURL(join(sources, arm, 'src/commands/goal/auto.ts')))])));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const call = (cwd, argv) => execFileSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: 10000, stdio: ['ignore','pipe','pipe'] }).trim();
const root = mkdtempSync(join(tmpdir(), 'fc-delivery-recovery-'));
const rows = [];
for (let repetition = 0; repetition < 3; repetition++) {
  for (const arm of repetition % 2 ? ['candidate', 'base'] : ['base', 'candidate']) {
    const cwd = join(root, `${repetition}-${arm}`); mkdirSync(cwd);
    const artifact = `def transform(x): return 3*x+${7 + repetition}\nif __name__ == '__main__':\n    assert transform(0)==${7 + repetition}\n    assert transform(5)==${22 + repetition}\n    print('PASS')\n`;
    writeFileSync(join(cwd, 'artifact.py'), artifact); writeFileSync(join(cwd, '.gitignore'), '.future-code/\n');
    call(cwd, ['git','init','-q']); call(cwd, ['python3','-I','-B','artifact.py']);
    call(cwd, ['git','add','.']); call(cwd, ['git','-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-qm','independently checked artifact']);
    const expected = call(cwd, ['git','rev-parse','HEAD']);
    const remote = join(root, `${repetition}-${arm}.git`); call(cwd, ['git','init','--bare','-q',remote]); call(cwd, ['git','remote','add','origin',remote]);
    const api = modules[arm], goal = 'Maintain a reliable research pipeline with independently verified artifacts';
    api.enableAutoGoal(goal, cwd, 6);
    const report = `# ${goal}\nStatus: completed\n`;
    writeFileSync(join(cwd,'.future-code/goal.md'), report);
    api.resumeAutoGoalFromInput('Push the already validated commit to origin result now', { cwd, mainThread: true });
    const start = performance.now();
    const decision = api.decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true,
      promptFormat: 'delta', toolActivity: false, assistantText: 'The requested remote push has not run yet.' });
    let delivered = false, independentAccepted = false, pushMs = null;
    if (decision.kind === 'CONTINUE') {
      const pushStart = performance.now(); call(cwd, ['git','push','origin','HEAD:refs/heads/result']); pushMs = performance.now() - pushStart;
      const actual = call(cwd, ['git','--git-dir',remote,'rev-parse','refs/heads/result']); delivered = actual === expected;
      const fresh = join(root, `check-${repetition}-${arm}`); call(cwd, ['git','clone','--quiet','--branch','result',remote,fresh]);
      independentAccepted = delivered && digest(readFileSync(join(fresh,'artifact.py'))) === digest(Buffer.from(artifact)) && call(fresh, ['python3','-I','-B','artifact.py']) === 'PASS';
    }
    assert.equal(readFileSync(join(cwd,'.future-code/goal.md'),'utf8'), report);
    const state = api.readAutoGoal(cwd);
    assert.equal(state.maxContinuations, 6);
    rows.push({ arm, repetition, continuation: decision.kind, reason: decision.reason ?? null,
      goalState: state.state, continuations: state.continuations, delivered, independentAccepted,
      pushMs, totalMs: performance.now()-start, expectedCommit: expected, artifactSha256: digest(Buffer.from(artifact)) });
  }
}
const report = { schema: 1, kind: 'DETERMINISTIC_HOST_DELIVERY_RECOVERY', liveModelCalls: 0,
  scenario: 'A matching completed report exists before a newly queued trusted push instruction; delivery has not run when end-turn continuation is assessed.',
  limitation: 'Proves recovery of this host-control defect with real Git effects and fresh acceptance, not natural stall incidence or live R&D speedup.',
  root, rows };
writeFileSync(join(here,'delivery-recovery-results.json'), JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ baseDelivered: rows.filter(x=>x.arm==='base'&&x.independentAccepted).length,
  candidateDelivered: rows.filter(x=>x.arm==='candidate'&&x.independentAccepted).length, repetitions: 3,
  report: join(here,'delivery-recovery-results.json') }));
