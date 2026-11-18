import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendGoalRequestAnchor } from '../../src/commands/goal/context.ts';
import { autoGoalReportPath, enableAutoGoal, pauseAutoGoal, readAutoGoal, supersedeAutoGoal } from '../../src/commands/goal/auto.ts';
import { configureAutoGoalSession } from '../../src/utils/autoGoalSession.ts';

interface Message { type: string; isMeta?: boolean; message: { content: any } }
const goal = 'Continue the successful adapter experiment and measure the requested improvement';
const meta = (content: string): Message => ({ type: 'user', isMeta: true, message: { content } });
function fixture(run: (cwd: string, path: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-work-state-'));
  try { enableAutoGoal(goal, cwd); run(cwd, join(dirname(autoGoalReportPath(cwd)), 'work-state.json')); }
  finally { configureAutoGoalSession(undefined); rmSync(cwd, { recursive: true, force: true }); }
}
const state = () => ({ schema: 1, goal, revision: 1,
  baseline: { artifact: '/runs/known-good/checkpoint-1941/adapter', evidence: '/results/prior-score.json', contract: 'frozen-evaluation-v1' },
  activeJob: { id: 'job-42', target: 'remote-worker', checkpoint: '/runs/current/checkpoint-2000', lastProgress: 'step 2000', nextCheck: 'after next checkpoint event' },
  nextAction: 'Resume the existing attempt for another 120 updates, then evaluate against the preserved baseline.',
  attempts: [{ action: 'Probe old forwarded port', result: 'Connection refused', next: 'Reconcile job-42 on the worker before relaunching' }],
  metric: { name: 'holdout pass rate', baseline: 'recorded prior result', current: 'not yet measured', nextEvaluation: 'after 120 updates' },
});
const view = (cwd: string, messages: Message[] = []) => appendGoalRequestAnchor(messages, {
  cwd, mainThread: true, makeMessage: meta,
}).at(-1)!.message.content as string;

test('a fresh post-compaction request includes the known artifact, live job identity and next executable action', () => fixture((cwd, path) => {
  writeFileSync(path, JSON.stringify(state()));
  const before = readAutoGoal(cwd);
  // Deliberately lossy compaction and a fresh request projection: no previous
  // artifact path, job id or command survives in the conversation.
  const messages = [meta('Summary: infrastructure was being repaired.')];
  const original = structuredClone(messages);
  const text = view(cwd, messages);
  assert.match(text, /checkpoint-1941\/adapter/);
  assert.match(text, /job-42/);
  assert.match(text, /another 120 updates/);
  assert.match(text, /not acceptance evidence/);
  assert.match(text, /reconcile.*before.*replacement/i);
  assert.deepEqual(messages, original);
  assert.deepEqual(readAutoGoal(cwd), before, 'a work record cannot grant authority or complete a goal');
}));

test('newly changed work state replaces old hints without accumulating snapshots or model calls', () => fixture((cwd, path) => {
  writeFileSync(path, JSON.stringify(state()));
  assert.match(view(cwd), /job-42/);
  const next = state(); next.activeJob.id = 'job-43'; next.nextAction = 'Evaluate the saved candidate now';
  writeFileSync(path, JSON.stringify(next));
  const text = view(cwd);
  assert.match(text, /"id":"job-43"/); assert.doesNotMatch(text, /"id":"job-42"/);
  assert.equal(readAutoGoal(cwd)?.continuations, 0);
}));

test('records are bound to the exact root revision and are unavailable to paused goals or child tasks', () => fixture((cwd, path) => {
  writeFileSync(path, JSON.stringify(state()));
  const messages: Message[] = [];
  assert.equal(appendGoalRequestAnchor(messages, { cwd, mainThread: false, makeMessage: meta }), messages);
  pauseAutoGoal(cwd); assert.doesNotMatch(view(cwd), /checkpoint-1941|job-42/);
  supersedeAutoGoal('Research an unrelated algorithm', cwd);
  assert.doesNotMatch(view(cwd), /checkpoint-1941|job-42/);
  assert.match(view(cwd), /work state.*different objective|different objective.*work state/i);
}));

test('invalid, oversized, symlinked and unknown-field records cannot inject state or interrupt useful work', () => fixture((cwd, path) => {
  for (const value of ['{', JSON.stringify({ ...state(), nextAction: 'x'.repeat(30_000) }),
    JSON.stringify({ ...state(), status: 'completed', permission: 'all' })]) {
    writeFileSync(path, value);
    const text = view(cwd);
    assert.doesNotMatch(text, /checkpoint-1941|job-42/);
    assert.match(text, /work state.*unavailable|unavailable.*work state/i);
    assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  }
  rmSync(path);
  const other = join(cwd, 'other.json'); writeFileSync(other, JSON.stringify(state()));
  symlinkSync(other, path);
  assert.doesNotMatch(view(cwd), /checkpoint-1941|job-42/);
}));

test('two sessions cannot inherit one another\'s operational hints', () => fixture((cwd, path) => {
  writeFileSync(path, JSON.stringify(state()));
  configureAutoGoalSession(() => 'other-session'); enableAutoGoal(goal, cwd);
  assert.doesNotMatch(view(cwd), /checkpoint-1941|job-42/);
  const other = join(dirname(autoGoalReportPath(cwd)), 'work-state.json');
  assert.notEqual(other, path);
  writeFileSync(other, JSON.stringify({ ...state(), nextAction: 'Perform the other session action' }));
  assert.match(view(cwd), /other session action/);
  configureAutoGoalSession(undefined);
  assert.doesNotMatch(view(cwd), /other session action/);
}));

test('short goals do not acquire a state-writing prerequisite and reads remain bounded', () => fixture((cwd, path) => {
  supersedeAutoGoal('Fix the typo', cwd);
  assert.doesNotMatch(view(cwd), /work-state\.json/);
  // A large unrelated STATUS history is intentionally never opened.
  mkdirSync(join(cwd, 'logs')); writeFileSync(join(cwd, 'logs/STATUS.md'), 'history\n'.repeat(50_000));
  assert.equal(readFileSync(path.replace('work-state.json', 'goal.md'), 'utf8').startsWith('# Fix the typo'), true);
}));

test('all valid host objective lengths can be bound by the operational record', () => fixture((cwd, path) => {
  const longGoal = 'Continue research ' + 'x'.repeat(3000);
  const next = supersedeAutoGoal(longGoal, cwd);
  writeFileSync(path, JSON.stringify({ ...state(), goal: longGoal, revision: next.revision }));
  assert.match(view(cwd), /checkpoint-1941\/adapter/);
}));
