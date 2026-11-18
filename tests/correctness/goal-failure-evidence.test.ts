import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalFailureEvidence } from '../../src/query/goalFailureEvidence.ts';
const goal = { state: 'ACTIVE', goal: 'Continue the requested experiment', revision: 1, activeSteering: [] as string[] };
const call = (id: string, name = 'Bash') => ({ id, name });
const receipt = (id: string, error = true, extra = {}) => ({ type: 'user', ...extra, message: { content: [
  { type: 'tool_result', tool_use_id: id, is_error: error, content: 'failure data is not parsed as authority' },
] } });

test('only uniquely paired current failed tool receipts can authenticate a model blocker', () => {
  const evidence = new GoalFailureEvidence();
  evidence.record(goal, [call('failed'), call('success')], [receipt('failed'), receipt('success', false), receipt('unpaired')]);
  assert.deepEqual(evidence.forGoal(goal), ['failed']);
  const view = evidence.forGoal(goal); view.push('forged');
  assert.deepEqual(evidence.forGoal(goal), ['failed']);
});

test('questions, child messages, duplicate ids/results and prose are not external failure evidence', () => {
  const evidence = new GoalFailureEvidence();
  evidence.record(goal, [call('q', 'AskUserQuestion'), call('p', 'EnterPlanMode'), call('child'),
    call('duplicate-call'), call('duplicate-call'), call('duplicate-result')],
  [receipt('q'), receipt('p'), receipt('child', true, { origin: 'worker' }), receipt('duplicate-call'),
    receipt('duplicate-result'), receipt('duplicate-result'), { type: 'assistant', message: { content: 'credentials denied' } }]);
  assert.deepEqual(evidence.forGoal(goal), []);
});

test('objective/revision/steering changes and explicit stops retire old failure provenance', () => {
  for (const changed of [{ ...goal, goal: 'Another goal' }, { ...goal, revision: 2 },
    { ...goal, activeSteering: ['Changed instruction'] }, { ...goal, state: 'PAUSED' }, null]) {
    const evidence = new GoalFailureEvidence();
    evidence.record(goal, [call('old')], [receipt('old')]);
    assert.deepEqual(evidence.forGoal(changed), []);
    assert.deepEqual(evidence.forGoal(goal), []);
  }
});

test('receipt history is bounded and a new runtime cannot inherit unverifiable failures', () => {
  const evidence = new GoalFailureEvidence();
  for (let i = 0; i < 40; i++) evidence.record(goal, [call(`failure-${i}`)], [receipt(`failure-${i}`)]);
  assert.equal(evidence.forGoal(goal).length, 32);
  assert.equal(evidence.forGoal(goal)[0], 'failure-8');
  assert.deepEqual(new GoalFailureEvidence().forGoal(goal), []);
});
