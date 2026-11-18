import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideAutoGoalContinuation, enableAutoGoal, pauseAutoGoal, readAutoGoal } from '../../src/commands/goal/auto.ts';

const goal = 'Continue the existing verified experiment and deliver the requested outcome';
function fixture(run: (cwd: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-blocker-evidence-'));
  try { enableAutoGoal(goal, cwd); run(cwd); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
}
const report = (cwd: string, fields = '') => writeFileSync(join(cwd, '.future-code/goal.md'), '# ' + goal + '\n' +
  'Status: blocked\nBlocker: Executor returned HTTP 403 forbidden\nBlocker type: permissions\n' +
  'Recovery attempted: Probed the configured executor and reconciled alternative routes; access is still denied\n' +
  'External action required: Restore the configured capability\n' + fields);
const next = (cwd: string, extra: Record<string, unknown> = {}) => decideAutoGoalContinuation({
  cwd, mainThread: true, withinTurnBudget: true, promptFormat: 'delta', failureReceipts: [], ...extra,
});

for (const fields of ['', 'Failure receipt: invented-tool-call\n', 'Failure receipt: failed-probe\n']) {
  test('a complete model-authored blocker cannot pause without matching host evidence: ' + (fields || '(missing receipt)'), () => fixture(cwd => {
    report(cwd, fields);
    const decision = next(cwd, { failureReceipts: ['different-tool-call'] });
    assert.equal(decision.kind, 'CONTINUE');
    if (decision.kind === 'CONTINUE') assert.match(decision.prompt, /host-observed.*failed tool|failed tool.*host-observed/i);
    assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
    assert.equal(readAutoGoal(cwd)?.continuations, 1);
    assert.match(readFileSync(join(cwd, '.future-code/goal.md'), 'utf8'), /Status: blocked/, 'do not fabricate a successful report');
  }));
}

for (const blocker of ['The local work slot is exhausted', 'The observer window ended before the objective finished',
  'Renewed authorization is required to keep working']) {
  test('a resource or continuation excuse without a failed tool is diagnosis work: ' + blocker, () => fixture(cwd => {
    writeFileSync(join(cwd, '.future-code/goal.md'), '# ' + goal + '\nStatus: blocked\n' +
      'Blocker: ' + blocker + '\nBlocker type: resources\n' +
      'Recovery attempted: Reviewed the local work window and current status\n' +
      'External action required: Allocate a new work slot\n');
    assert.equal(next(cwd).kind, 'CONTINUE');
    assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  }));
}

test('a matched failed-tool receipt preserves actual denied-access parking', () => fixture(cwd => {
  report(cwd, 'Failure receipt: failed-probe\n');
  const decision = next(cwd, { failureReceipts: ['failed-probe'] });
  assert.equal(decision.kind, 'BLOCKED');
  assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
  assert.match(readAutoGoal(cwd)!.reason!, /HTTP 403/);
  assert.equal(readAutoGoal(cwd)?.continuations, 0);
}));

for (const fields of ['Failure receipt: failed-probe and an invented explanation\n',
  'Failure receipt: failed-probe\nFailure receipt: invented-tool-call\n',
  '## Historical failures\nFailure receipt: failed-probe\n',
  '> Failure receipt: failed-probe\n', '```text\nFailure receipt: failed-probe\n```\n']) {
  test('ambiguous, historical and quoted receipt claims cannot authenticate a blocker: ' + fields, () => fixture(cwd => {
    report(cwd, fields);
    assert.equal(next(cwd, { failureReceipts: ['failed-probe'] }).kind, 'CONTINUE');
    assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  }));
}

test('receipt evidence cannot bypass real caller budgets, explicit stops or recoverable implementation work', () => fixture(cwd => {
  report(cwd);
  assert.equal(next(cwd, { withinTurnBudget: false }).kind, 'BLOCKED');
  assert.match(readAutoGoal(cwd)!.reason!, /max-turns/);
  enableAutoGoal(goal, cwd);
  pauseAutoGoal(cwd);
  assert.equal(next(cwd, { failureReceipts: ['failed-probe'] }).kind, 'SKIP');
  enableAutoGoal(goal, cwd);
  writeFileSync(join(cwd, '.future-code/goal.md'), '# ' + goal + '\nStatus: blocked\n' +
    'Blocker: A local unit test failed\nBlocker type: external_dependency\n' +
    'Recovery attempted: Ran the focused test suite\nExternal action required: Fix the test code\n' +
    'Failure receipt: failed-probe\n');
  assert.equal(next(cwd, { failureReceipts: ['failed-probe'] }).kind, 'CONTINUE');
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
}));

test('standalone callers without a host receipt contract keep their existing blocker behavior', () => fixture(cwd => {
  report(cwd);
  assert.equal(decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true }).kind, 'BLOCKED');
  assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
}));
