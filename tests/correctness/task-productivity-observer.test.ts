import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTaskCompletion, median } from '../../experiments/task-productivity-20261117/completion-observer.mjs';

test('a blocked event loop cannot turn a late artifact check into timely success', async () => {
  let timerFired = false;
  const started = performance.now();
  const timer = setTimeout(() => { timerFired = true; }, 20);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  assert.equal(timerFired, false, 'timer has not had an event-loop turn');
  const actual = observeTaskCompletion(started, 20, { verdict: 'PASS' });
  clearTimeout(timer);
  assert.equal(actual.verdict, 'CENSORED');
  assert.equal(actual.completionWallMs, null);
  assert.equal(actual.independentCheck, null);
  assert.ok(actual.lateCompletionWallMs! >= 50);
  assert.deepEqual(actual.lateIndependentCheck, { verdict: 'PASS' });
});

test('an observed timely check keeps its real completion timestamp', () => {
  const actual = observeTaskCompletion(performance.now(), 2500, { verdict: 'PASS' });
  assert.equal(actual.verdict, 'PASS');
  assert.ok(actual.completionWallMs! >= 0 && actual.completionWallMs! <= 2500);
  assert.deepEqual(actual.independentCheck, { verdict: 'PASS' });
});

test('reported medians use both middle observations in even cohorts', () => {
  const original = [6, 1, 5, 2];
  assert.equal(median(original), 3.5);
  assert.deepEqual(original, [6, 1, 5, 2]);
  assert.equal(median([6, 1, 5, 2, 3]), 3);
  assert.equal(median([9]), 9);
  assert.equal(median([]), null);
});
