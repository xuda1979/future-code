import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideAutoGoalContinuation, enableAutoGoal, pauseAutoGoal, readAutoGoal,
  resumeAutoGoalFromInput } from '../../src/commands/goal/auto.ts';
import { isRoutineDecisionHandoff } from '../../src/harness/autonomyPolicy.ts';

const observed = '1. **Push** **bd410db** (the rebased memory-awareness commit) to origin/main\n\n' +
  '2. **Continue** **periodic** **sync** **cycles** per your standing pull-and-rebuild instruction\n\n' +
  'Say "go" for both, or pick either one.';
function fixture(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-decisions-'));
  try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}
const next = (cwd: string, extra: Record<string, unknown> = {}) => decideAutoGoalContinuation({
  cwd, mainThread: true, withinTurnBudget: true, promptFormat: 'delta', ...extra,
});
const report = (cwd: string, text: string) => writeFileSync(join(cwd, '.future-code/goal.md'), text);

for (const request of ['Push the authorized commit to origin/main', 'Continue periodic sync cycles per the standing pull-and-rebuild instruction',
  'Run the existing verification suite', 'Commit the verified changes', 'Sync the remote repository and rebuild', 'Run tests',
  'Can you please push the verified branch?', 'Please pull and rebuild the application']) {
  test('execution directives arm durable work: ' + request, () => fixture(cwd => {
    const state = resumeAutoGoalFromInput(request, { mainThread: true, cwd });
    assert.equal(state?.state, 'ACTIVE');
    assert.equal(state?.goal, request);
    assert.equal(next(cwd).kind, 'CONTINUE');
  }));
}

for (const input of ['go', 'go for both', 'do both', 'proceed', '继续执行', '两个都做']) {
  test('short explicit resume retains existing root and budget: ' + input, () => fixture(cwd => {
    enableAutoGoal('Maintain the verified standing synchronization workflow', cwd, 3);
    next(cwd);
    pauseAutoGoal(cwd);
    const state = resumeAutoGoalFromInput(input, { mainThread: true, cwd });
    assert.equal(state?.state, 'ACTIVE');
    assert.equal(state?.goal, 'Maintain the verified standing synchronization workflow');
    assert.equal(state?.maxContinuations, 3);
    assert.equal(state?.totalContinuations, 1);
    next(cwd);
    assert.equal(resumeAutoGoalFromInput(input, { mainThread: true, cwd }), null);
    assert.equal(readAutoGoal(cwd)?.continuations, 1, 'active assent cannot reset a budget');
  }));
  test('ambiguous assent never creates work or reopens genuine review: ' + input, () => fixture(cwd => {
    assert.equal(resumeAutoGoalFromInput(input, { mainThread: true, cwd }), null);
    assert.equal(readAutoGoal(cwd), null);
    enableAutoGoal('Complete the requested edit', cwd);
    report(cwd, '# Complete the requested edit\nStatus: completed\n');
    assert.equal(next(cwd).kind, 'BLOCKED');
    assert.equal(resumeAutoGoalFromInput(input, { mainThread: true, cwd }), null);
    assert.equal(readAutoGoal(cwd)?.state, 'REVIEW');
  }));
}

test('known unfinished milestones prevent premature review and preserve their order', () => fixture(cwd => {
  const goal = 'Push verified changes and maintain standing sync cycles';
  enableAutoGoal(goal, cwd);
  report(cwd, '# ' + goal + '\nStatus: completed\n## Milestones\n' +
    '- [x] Rebase and verify the memory-awareness change\n- [ ] Push the authorized commit\n- [ ] Continue standing sync cycles\n');
  const decision = next(cwd, { assistantText: observed });
  assert.equal(decision.kind, 'CONTINUE');
  if (decision.kind === 'CONTINUE') assert.match(decision.prompt, /Push the authorized commit/);
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  assert.match(readFileSync(join(cwd, '.future-code/goal.md'), 'utf8'), /- \[ \] Push the authorized commit/);
}));

test('the exact go-or-pick handoff is corrected even when the model prematurely declares completion without a ledger', () => fixture(cwd => {
  enableAutoGoal('Push verified changes and continue standing sync cycles', cwd);
  report(cwd, '# Push verified changes and continue standing sync cycles\nStatus: completed\n');
  const decision = next(cwd, { assistantText: observed });
  assert.equal(decision.kind, 'CONTINUE');
  if (decision.kind === 'CONTINUE') {
    assert.match(decision.prompt, /compatible|both/i);
    assert.match(decision.prompt, /authoriz|scope/i);
  }
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
}));

for (const action of ['Say "go" for both, or pick either one.', 'Please confirm whether to proceed',
  'Choose which of the two requested tasks I should do', '请回复“继续”后我再执行']) {
  test('routine decision requests are not external blockers: ' + action, () => fixture(cwd => {
    enableAutoGoal('Complete both already authorized workflow steps', cwd);
    report(cwd, '# Complete both already authorized workflow steps\nStatus: blocked\n' +
      'Blocker: Waiting for a routine user decision\nBlocker type: permissions\n' +
      'Recovery attempted: Inspected the existing standing instruction\nExternal action required: ' + action + '\n');
    assert.equal(next(cwd).kind, 'CONTINUE');
    assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  }));
}

for (const kind of ['hardware', 'network', 'provider', 'credentials', 'permissions']) {
  test('actual external dependencies and denied capability remain visible: ' + kind, () => fixture(cwd => {
    enableAutoGoal('Verify the experiment', cwd);
    report(cwd, '# Verify the experiment\nStatus: blocked\nBlocker: HTTP 403 / executor unavailable\n' +
      'Blocker type: ' + kind + '\nRecovery attempted: Probed the configured service; access is still denied\n' +
      'External action required: Restore the configured capability or replace the unavailable executor\n');
    assert.equal(next(cwd).kind, 'BLOCKED');
    assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
    assert.match(readAutoGoal(cwd)!.reason!, /403/);
  }));
}

test('routine handoff correction never overrides operator pause, child authority or explicit budgets', () => fixture(cwd => {
  enableAutoGoal('Complete both requested steps', cwd, 1);
  pauseAutoGoal(cwd);
  assert.equal(next(cwd, { assistantText: observed }).kind, 'SKIP');
  assert.equal(next(cwd, { mainThread: false, assistantText: observed }).kind, 'SKIP');
  resumeAutoGoalFromInput('continue', { mainThread: true, cwd });
  assert.equal(next(cwd, { withinTurnBudget: false, assistantText: observed }).kind, 'BLOCKED');
  assert.match(readAutoGoal(cwd)!.reason!, /max-turns/);
}));

test('ordinary observations preserve an explicit pause and cannot reset continuation accounting', () => fixture(cwd => {
  enableAutoGoal('Maintain the standing synchronization workflow', cwd, 3);
  next(cwd);
  pauseAutoGoal(cwd, 'Paused by operator instruction');
  resumeAutoGoalFromInput('A useful observation about the previous run', { mainThread: true, cwd });
  assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
  assert.equal(readAutoGoal(cwd)?.continuations, 1);
  assert.equal(readAutoGoal(cwd)?.totalContinuations, 1);
}));

for (const constraint of ['Do not resume until I explicitly say continue', 'Do not modify production', 'Also keep all existing acceptance checks']) {
  test('a constraint cannot implicitly cancel an operator pause: ' + constraint, () => fixture(cwd => {
    enableAutoGoal('Maintain the standing synchronization workflow', cwd, 3);
    next(cwd);
    pauseAutoGoal(cwd, 'Paused by operator instruction');
    resumeAutoGoalFromInput(constraint, { mainThread: true, cwd });
    assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
    assert.equal(readAutoGoal(cwd)?.continuations, 1);
    assert.ok(readAutoGoal(cwd)?.activeSteering?.includes(constraint));
  }));
}

test('repeated unchanged decision-only responses receive bounded recovery, never fabricated consent or infinite retries', () => fixture(cwd => {
  enableAutoGoal('Complete both requested steps', cwd);
  assert.equal(next(cwd, { assistantText: observed }).kind, 'CONTINUE');
  assert.equal(next(cwd, { assistantText: observed }).kind, 'CONTINUE');
  const decision = next(cwd, { assistantText: observed });
  assert.equal(decision.kind, 'BLOCKED');
  if (decision.kind === 'BLOCKED') assert.match(decision.reason, /model.*execution|execution.*contract/i);
  assert.equal(readAutoGoal(cwd)?.totalContinuations, 2);
}));

test('real tool activity resets the no-action handoff recovery counter', () => fixture(cwd => {
  enableAutoGoal('Complete both requested steps', cwd);
  assert.equal(next(cwd, { assistantText: observed }).kind, 'CONTINUE');
  assert.equal(next(cwd, { assistantText: observed }).kind, 'CONTINUE');
  assert.equal(next(cwd, { assistantText: observed, toolActivity: true }).kind, 'CONTINUE');
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
}));

test('a supplied external prerequisite resumes work without demanding another continue or replenishing budget', () => fixture(cwd => {
  const goal = 'Verify the experiment using the configured account';
  enableAutoGoal(goal, cwd, 3);
  next(cwd);
  report(cwd, '# ' + goal + '\nStatus: blocked\nBlocker: Configured credential unavailable\n' +
    'Blocker type: credentials\nRecovery attempted: Checked all configured credentials; none are available\n' +
    'External action required: Restore the configured account credential\n');
  assert.equal(next(cwd).kind, 'BLOCKED');
  const state = resumeAutoGoalFromInput('The configured credential is restored', { mainThread: true, cwd })!;
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.goal, goal);
  assert.equal(state.continuations, 1);
  assert.equal(state.totalContinuations, 1);
  assert.equal(state.maxContinuations, 3);
  assert.equal(next(cwd).kind, 'CONTINUE');
}));

test('new prerequisite evidence cannot reset an exhausted continuation budget', () => fixture(cwd => {
  enableAutoGoal('Verify the experiment', cwd, 1);
  next(cwd);
  report(cwd, '# Verify the experiment\nStatus: blocked\nBlocker: Missing credential\n' +
    'Blocker type: credentials\nRecovery attempted: Probed the service; HTTP 401 persists\n' +
    'External action required: Restore the configured credential\n');
  next(cwd);
  resumeAutoGoalFromInput('The configured credential is restored', { mainThread: true, cwd });
  assert.equal(readAutoGoal(cwd)?.continuations, 1);
  assert.equal(next(cwd).kind, 'BLOCKED');
  assert.match(readAutoGoal(cwd)!.reason!, /budget exhausted/);
}));

test('a human-requested decision may yield without retiring the unfinished root or granting new authority', () => fixture(cwd => {
  enableAutoGoal('Implement the requested design', cwd, 3);
  next(cwd);
  resumeAutoGoalFromInput('Ask me to choose between the designs before implementing', { mainThread: true, cwd });
  const state = readAutoGoal(cwd)!;
  assert.equal(state.userQuestions, true);
  assert.equal(state.continuations, 1);
  assert.equal(state.maxContinuations, 3);
  assert.equal(next(cwd, { assistantText: 'Would you like me to continue with the first design?' }).kind, 'SKIP');
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  assert.equal(readAutoGoal(cwd)?.goal, 'Implement the requested design');
}));

for (const limit of ['caller', 'durable']) {
  test('requested interaction cannot bypass an exhausted ' + limit + ' budget', () => fixture(cwd => {
    enableAutoGoal('Implement the requested design', cwd, limit === 'durable' ? 1 : 3);
    next(cwd);
    resumeAutoGoalFromInput('Ask me to choose between designs', { mainThread: true, cwd });
    const decision = next(cwd, { assistantText: 'Should I continue with both?', withinTurnBudget: limit !== 'caller' });
    assert.equal(decision.kind, 'BLOCKED');
    assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
    assert.equal(readAutoGoal(cwd)?.continuations, 1);
    assert.match(readAutoGoal(cwd)!.reason!, limit === 'caller' ? /max-turns/ : /budget exhausted/);
  }));
}

for (const blocker of ['Force-push is not authorized', 'Production deployment requires ungranted approval']) {
  test('a new or denied consequential permission remains blocked despite go-like wording: ' + blocker, () => fixture(cwd => {
    enableAutoGoal('Complete the authorized edit', cwd);
    report(cwd, '# Complete the authorized edit\nStatus: blocked\nBlocker: ' + blocker + '\n' +
      'Blocker type: permissions\nRecovery attempted: Checked the explicit capability boundary; access remains denied\n' +
      'External action required: Please approve before proceeding; say go only if authorized\n');
    assert.equal(next(cwd, { assistantText: observed }).kind, 'BLOCKED');
    assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
    assert.match(readAutoGoal(cwd)!.reason!, /permissions/);
  }));
}

test('source quotations and nested fences cannot become executable handoffs or unfinished milestones', () => fixture(cwd => {
  const tick = String.fromCharCode(96);
  const source = tick.repeat(4) + 'markdown\n' + tick.repeat(3) + 'text\nSay go for both\n' +
    tick.repeat(3) + '\n- [ ] Example only\nStatus: blocked\n' + tick.repeat(5);
  for (const text of [source, '> Say go for both', '"Say go for both"', 'The docs say "Say go for both".',
    'The old assistant asked whether it should push; that behavior is fixed.']) {
    assert.equal(isRoutineDecisionHandoff(text), false, text);
  }
  assert.equal(isRoutineDecisionHandoff('Everything is ready; say go for both.'), true);
  enableAutoGoal('Complete the authorized edit', cwd);
  report(cwd, '# Complete the authorized edit\nStatus: completed\n' + source + '\n');
  assert.equal(next(cwd, { assistantText: source }).kind, 'BLOCKED');
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW');
}));
