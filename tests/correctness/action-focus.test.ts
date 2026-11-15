import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendGoalRequestAnchor } from '../../src/commands/goal/context.ts';
import { enableAutoGoal, pauseAutoGoal, readAutoGoal } from '../../src/commands/goal/auto.ts';

interface Message { type: string; isMeta?: boolean; origin?: unknown; message: { content: any } }
const meta = (content: string): Message => ({ type: 'user', isMeta: true, message: { content } });
function pair(i: number, name = 'Read', input: unknown = { file_path: `file-${i}` }, content: unknown = `evidence-${i}`, error = false): Message[] {
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: `call-${i}`, name, input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `call-${i}`, content, is_error: error }] } },
  ];
}
function fixture(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'action-focus-'));
  try { enableAutoGoal('Extend the existing artifact and verify the requested improvement', cwd, 9); run(cwd); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
}
const anchor = (messages: Message[], cwd: string) => appendGoalRequestAnchor(messages, {
  cwd, mainThread: true, makeMessage: meta,
}).at(-1)!.message.content as string;
const observations = (n: number) => Array.from({ length: n }, (_, i) => pair(i)).flat();

test('observational tool loops receive a direct-action review before end-turn', () => fixture(cwd => {
  const history = observations(12);
  const before = structuredClone(history);
  assert.match(anchor(history, cwd), /12 observation\/planning receipts/);
  assert.match(anchor(history, cwd), /smallest.*(?:change|check)/i);
  assert.match(anchor(history, cwd), /Read-only goals do not authorize mutations/);
  assert.deepEqual(history, before);
  assert.equal(readAutoGoal(cwd)?.continuations, 0, 'no end-turn or extra model call is needed');
}));

test('rewriting goal notes cannot conceal an observation-only loop', () => fixture(cwd => {
  const path = join(cwd, '.future-code/goal.md');
  const history = observations(12);
  history.push(...pair(20, 'Write', { file_path: path, content: 'new standup' }, 'written'));
  writeFileSync(path, readFileSync(path, 'utf8') + '\nStandup: still investigating\n');
  assert.match(anchor(history, cwd), /observation\/planning receipts/);
}));

test('three identical failed receipts trigger diagnosis without suppressing the original tool evidence', () => fixture(cwd => {
  const history = Array.from({ length: 3 }, (_, i) => pair(i, 'Bash', { command: 'run-check' }, 'HTTP 503', true)).flat();
  const view = appendGoalRequestAnchor(history, { cwd, mainThread: true, makeMessage: meta });
  assert.match(view.at(-1)!.message.content, /same failed request and receipt repeated 3 times/);
  assert.match(view.at(-1)!.message.content, /reconcile.*external work/i);
  assert.deepEqual(view.slice(0, -1), history);
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
}));

test('interleaved observation does not hide repeated failures; new evidence clears their warning', () => fixture(cwd => {
  const history = Array.from({ length: 3 }, (_, i) => [
    ...pair(i * 2, 'Bash', { command: 'run-check' }, 'HTTP 503', true), ...pair(i * 2 + 1),
  ]).flat();
  assert.match(anchor(history, cwd), /same failed request and receipt repeated 3 times/);
  history.push(...pair(30, 'Bash', { command: 'run-check' }, 'HTTP 429', true));
  assert.doesNotMatch(anchor(history, cwd), /Host Action Review/);
}));

test('changed receipts and successful implementation reset repetition evidence', () => fixture(cwd => {
  const varied = Array.from({ length: 3 }, (_, i) => pair(i, 'Bash', { command: 'run-check' }, `failure ${i}`, true)).flat();
  assert.doesNotMatch(anchor(varied, cwd), /Host Action Review/);
  const history = observations(12);
  history.push(...pair(20, 'Edit', { file_path: 'src/worker.ts' }, 'updated'));
  assert.doesNotMatch(anchor(history, cwd), /Host Action Review/);
}));

test('a healthy remote job is never cancelled or treated as failed for unchanged poll output', () => fixture(cwd => {
  const history = Array.from({ length: 12 }, (_, i) => pair(i, 'TaskOutput', { task_id: 'job-1', block: false }, 'running')).flat();
  const text = anchor(history, cwd);
  assert.match(text, /same observation request and receipt repeated 12 times/);
  assert.match(text, /healthy running jobs/);
  assert.match(text, /independent acceptance/);
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  assert.equal(readAutoGoal(cwd)?.maxContinuations, 9);
}));

test('ordinary exploration, changing job progress and unknown successful tools receive no loop warning', () => fixture(cwd => {
  assert.doesNotMatch(anchor(observations(5), cwd), /Host Action Review/);
  const progress = Array.from({ length: 12 }, (_, i) => pair(i, 'TaskOutput', { task_id: 'job-1' }, `step ${i}`)).flat();
  assert.doesNotMatch(anchor(progress, cwd), /Host Action Review/);
  const external = observations(11).concat(pair(30, 'project_experiment', {}, 'receipt'), observations(5));
  assert.doesNotMatch(anchor(external, cwd), /Host Action Review/);
}));

test('a fresh human instruction bounds the observation window; prose and unpaired receipts are not tool work', () => fixture(cwd => {
  const human: Message = { type: 'user', message: { content: [{ type: 'text', text: 'Now inspect the other approach' }] } };
  assert.doesNotMatch(anchor([...observations(12), human, ...observations(2)], cwd), /Host Action Review/);
  const fake: Message[] = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'I made verified progress' }] } },
    { type: 'user', isMeta: true, message: { content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'success' }] } }];
  assert.match(anchor([...observations(12), ...fake], cwd), /Host Action Review/);
}));

test('paused goals and child requests cannot acquire action-review instructions', () => fixture(cwd => {
  const history = observations(12);
  assert.equal(appendGoalRequestAnchor(history, { cwd, mainThread: false, makeMessage: meta }), history);
  pauseAutoGoal(cwd);
  assert.doesNotMatch(anchor(history, cwd), /Host Action Review/);
}));

test('large or ambiguous receipts cannot be equated using a truncated output prefix', () => fixture(cwd => {
  const history = Array.from({ length: 3 }, (_, i) => pair(i, 'Read', { file_path: 'large' }, 'x'.repeat(100_000) + i)).flat();
  assert.doesNotMatch(anchor(history, cwd), /Host Action Review/);
}));

test('oversized new evidence clears a repeated receipt, and canonical input order preserves identity', () => fixture(cwd => {
  const history = Array.from({ length: 3 }, (_, i) => pair(i, 'Read', i % 2 ?
    { limit: 10, file_path: 'config' } : { file_path: 'config', limit: 10 }, 'same')).flat();
  assert.match(anchor(history, cwd), /same observation request and receipt repeated 3 times/);
  history.push(...pair(10, 'Read', { file_path: 'config', limit: 10 }, 'x'.repeat(100_000)));
  assert.doesNotMatch(anchor(history, cwd), /Host Action Review/);
}));

test('duplicate ids, duplicate receipts, out-of-order results and child evidence cannot fabricate repeated work', () => fixture(cwd => {
  const duplicate = [...pair(0), ...pair(0), ...pair(0)];
  assert.doesNotMatch(anchor(duplicate, cwd), /Host Action Review/);
  const receipts = pair(0); receipts.push(receipts[1]!, receipts[1]!);
  assert.doesNotMatch(anchor(receipts, cwd), /Host Action Review/);
  const reversed = Array.from({ length: 3 }, (_, i) => pair(i, 'Bash', {}, 'failure', true).reverse()).flat();
  assert.doesNotMatch(anchor(reversed, cwd), /Host Action Review/);
  const child = observations(12).map(message => ({ ...message, origin: { type: 'agent' } }));
  assert.doesNotMatch(anchor(child, cwd), /Host Action Review/);
}));

test('image-only human instructions and oversized message structures bound the diagnostic', () => fixture(cwd => {
  const image: Message = { type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', data: 'image' } }] } };
  assert.doesNotMatch(anchor([...observations(12), image], cwd), /Host Action Review/);
  const many: Message = { type: 'user', isMeta: true, message: { content: Array.from({ length: 257 }, () => ({ type: 'text', text: 'x' })) } };
  assert.doesNotMatch(anchor([...observations(12), many], cwd), /Host Action Review/);
}));

test('the diagnostic exposes counts only, stays in the ephemeral tail and cannot mutate goal authority', () => fixture(cwd => {
  const input = { command: 'probe SECRET_NOT_FOR_PROMPT' };
  const history = Array.from({ length: 3 }, (_, i) => pair(i, 'Bash', input, 'SECRET_RECEIPT', true)).flat();
  const before = readAutoGoal(cwd);
  for (let i = 0; i < 10; i++) {
    const view = appendGoalRequestAnchor(history, { cwd, mainThread: true, makeMessage: meta, executionPolicy: 'stable policy' });
    assert.equal(view.length, history.length + 2);
    assert.equal(view[0]!.message.content, 'stable policy');
    assert.deepEqual(view.slice(1, -1), history);
    const review = (view.at(-1)!.message.content as string).split('[Host Action Review')[1]!;
    assert.ok(review.length < 1200);
    assert.doesNotMatch(review, /SECRET/);
  }
  assert.deepEqual(readAutoGoal(cwd), before);
}));

test('tool-only sessions are examined even with many host reminders; analysis is bounded', () => fixture(cwd => {
  const history = observations(12);
  history.push(...Array.from({ length: 12 }, () => meta('Host continuation: keep working')));
  assert.match(anchor(history, cwd), /Host Action Review/);
  history.push(...Array.from({ length: 160 }, () => meta('old context retired')));
  assert.doesNotMatch(anchor(history, cwd), /Host Action Review/);
}));
