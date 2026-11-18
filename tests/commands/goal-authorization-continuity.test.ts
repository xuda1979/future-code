import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideAutoGoalContinuation, enableAutoGoal, pauseAutoGoal, readAutoGoal,
  shouldPauseGoalAfterTerminal } from '../../src/commands/goal/auto.ts';
import { isRoutineDecisionHandoff } from '../../src/harness/autonomyPolicy.ts';

function fixture(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-authorization-'));
  try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}
const next = (cwd: string, extra: Record<string, unknown> = {}) => decideAutoGoalContinuation({
  cwd, mainThread: true, withinTurnBudget: true, promptFormat: 'delta', ...extra,
});
const handoff = 'I need your authorization to keep working.';

for (const text of [handoff, 'I cannot continue without your approval.',
  'If you want me to continue, please confirm.', 'Once you authorize me, I will resume the existing work.',
  '1. Please confirm whether to proceed.', '需要您再次授权后，我才能继续执行。']) {
  test('continuation authority is not handed back through prose: ' + text, () => fixture(cwd => {
    assert.equal(isRoutineDecisionHandoff(text), true);
    const goal = 'Continue from the last verified artifact and finish the requested experiment';
    enableAutoGoal(goal, cwd);
    writeFileSync(join(cwd, '.future-code/goal.md'), '# ' + goal + '\nStatus: completed\n');
    const decision = next(cwd, { assistantText: text });
    assert.equal(decision.kind, 'CONTINUE');
    if (decision.kind === 'CONTINUE') assert.match(decision.prompt, /not a user answer or new authorization/);
    assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  }));
}

test('a routine renewed-authorization report is not an external dependency', () => fixture(cwd => {
  const goal = 'Complete the already requested work';
  enableAutoGoal(goal, cwd);
  writeFileSync(join(cwd, '.future-code/goal.md'), '# ' + goal + '\nStatus: blocked\n' +
    'Blocker: Waiting for renewed authorization to continue\nBlocker type: permissions\n' +
    'Recovery attempted: Read the standing user instruction\n' +
    'External action required: I need your authorization to keep working.\n');
  assert.equal(next(cwd).kind, 'CONTINUE');
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
}));

for (const text of ['You already authorized me to continue.', 'I will continue using the existing authority.',
  '> I need your authorization to keep working.', '"I cannot continue without your approval."',
  'The old response said "I need your authorization to keep working".',
  '```text\nI need your authorization to keep working.\n```']) {
  test('current authority and quoted source are not handoffs: ' + text, () => {
    assert.equal(isRoutineDecisionHandoff(text), false);
  });
}

test('repeated handoffs change recovery strategy without pretending authority expired', () => fixture(cwd => {
  enableAutoGoal('Finish both already authorized workflow steps', cwd, 8);
  const options = { assistantText: 'Should I continue?' };
  assert.equal(next(cwd, options).kind, 'CONTINUE');
  assert.equal(next(cwd, options).kind, 'CONTINUE');
  const recovery = next(cwd, options);
  assert.equal(recovery.kind, 'RECOVER');
  if (recovery.kind === 'RECOVER') assert.match(recovery.prompt, /existing authority|already authorized/);
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  assert.equal(readAutoGoal(cwd)?.maxContinuations, 8);
  assert.equal(readAutoGoal(cwd)?.totalContinuations, 3);
  const final = next(cwd, options);
  assert.equal(final.kind, 'MODEL_ERROR');
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  assert.equal(readAutoGoal(cwd)?.totalContinuations, 3, 'failure cannot invent another model call or reset accounting');
}));

test('a trusted configured-model change gets bounded recovery under the same authority', () => fixture(cwd => {
  enableAutoGoal('Finish the already authorized workflow', cwd, 10);
  const options = { assistantText: 'Should I continue?' };
  next(cwd, options); next(cwd, options);
  assert.equal(next(cwd, options).kind, 'RECOVER');
  assert.equal(next(cwd, { ...options, recoveryModelChanged: true }).kind, 'CONTINUE');
  assert.equal(next(cwd, { ...options, recoveryModelChanged: true }).kind, 'CONTINUE');
  assert.equal(next(cwd, { ...options, recoveryModelChanged: true }).kind, 'MODEL_ERROR');
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  assert.equal(readAutoGoal(cwd)?.totalContinuations, 5);
}));

test('rejected question tools use changed recovery without pausing the authorized root', () => fixture(cwd => {
  enableAutoGoal('Complete the authorized workflow', cwd);
  for (const expected of ['CONTINUE', 'CONTINUE', 'RECOVER', 'MODEL_ERROR']) {
    assert.equal(next(cwd, { routineQuestionRejected: true }).kind, expected);
    assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  }
  assert.equal(shouldPauseGoalAfterTerminal('model_contract_failure'), false);
  assert.equal(shouldPauseGoalAfterTerminal('model_error'), true, 'actual provider failure still parks the objective');
}));

test('full-format recovery preserves its bound objective and report location', () => fixture(cwd => {
  enableAutoGoal('Complete the authorized workflow', cwd);
  const options = { routineQuestionRejected: true, promptFormat: 'full' };
  next(cwd, options); next(cwd, options);
  const decision = next(cwd, options);
  assert.equal(decision.kind, 'RECOVER');
  if (decision.kind === 'RECOVER') {
    assert.match(decision.prompt, /Goal: Complete the authorized workflow/);
    assert.ok(decision.prompt.includes(JSON.stringify(join(cwd, '.future-code/goal.md'))));
  }
}));

test('caller limits and actual denied capabilities outrank model recovery', () => fixture(cwd => {
  enableAutoGoal('Finish the already authorized workflow', cwd, 3);
  const options = { assistantText: 'Should I continue?' };
  next(cwd, options); next(cwd, options);
  assert.equal(next(cwd, { ...options, withinTurnBudget: false }).kind, 'BLOCKED');
  assert.match(readAutoGoal(cwd)!.reason!, /max-turns/);
  enableAutoGoal('Finish the already authorized workflow', cwd, 2);
  next(cwd, options); next(cwd, options);
  assert.equal(next(cwd, options).kind, 'BLOCKED');
  assert.match(readAutoGoal(cwd)!.reason!, /budget exhausted/);
  enableAutoGoal('Finish the already authorized workflow', cwd);
  writeFileSync(join(cwd, '.future-code/goal.md'), '# Finish the already authorized workflow\nStatus: blocked\n' +
    'Blocker: Executor returned HTTP 403 forbidden\nBlocker type: permissions\n' +
    'Recovery attempted: Probed configured service; access remains denied\n' +
    'External action required: I need your authorization to keep working.\n');
  assert.equal(next(cwd, options).kind, 'BLOCKED');
  assert.match(readAutoGoal(cwd)!.reason!, /HTTP 403/);
}));

test('successful tools reset recovery, while restarts and operator pauses preserve it', () => fixture(cwd => {
  enableAutoGoal('Finish the already authorized workflow', cwd);
  const options = { assistantText: 'Should I continue?' };
  next(cwd, options); next(cwd, options);
  assert.equal(next(cwd, options).kind, 'RECOVER');
  const saved = JSON.parse(readFileSync(join(cwd, '.future-code/goal-autonomy.json'), 'utf8'));
  assert.equal(saved.routineDecisionRecoveryUsed, true);
  assert.equal(next(cwd, options).kind, 'MODEL_ERROR');
  assert.equal(next(cwd, { ...options, toolActivity: true }).kind, 'CONTINUE');
  assert.equal(readAutoGoal(cwd)?.routineDecisionRecoveryUsed, false);
  pauseAutoGoal(cwd);
  assert.equal(next(cwd, { ...options, recoveryModelChanged: true }).kind, 'SKIP');
  assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
}));
