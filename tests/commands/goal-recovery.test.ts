import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoGoalTerminalDiagnostic, enableAutoGoal, parkActiveAutoGoal, readAutoGoal,
  shouldPauseGoalAfterTerminal } from '../../src/commands/goal/auto.ts';

test('terminal blockers identify the cause and recovery action instead of generic turn-end text', () => {
  for (const [reason, pattern] of [
    ['prompt_too_long', /context.*limit/i],
    ['blocking_limit', /compaction/i],
    ['image_error', /media/i],
    ['hook_stopped', /hook/i],
    ['max_turns', /caller.*turn/i],
    ['aborted_tools', /interrupted/i],
  ]) {
    const diagnostic = autoGoalTerminalDiagnostic(reason!);
    assert.match(diagnostic, pattern!);
    assert.doesNotMatch(diagnostic, /Turn ended before objective acceptance/);
  }
});

test('the original error survives durable parking without altering goal authority or counters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-terminal-recovery-'));
  try {
    enableAutoGoal('Run a reproducible experiment', dir, 7);
    const diagnostic = autoGoalTerminalDiagnostic('model_error', new Error('HTTP 401: configured credential expired'));
    parkActiveAutoGoal(diagnostic, dir);
    const state = readAutoGoal(dir)!;
    assert.match(state.reason!, /HTTP 401: configured credential expired/);
    assert.equal(state.state, 'PAUSED');
    assert.equal(state.goal, 'Run a reproducible experiment');
    assert.equal(state.maxContinuations, 7);
    assert.equal(state.totalContinuations, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('operator cancellation, configured hooks and caller limits remain stopping boundaries', () => {
  assert.equal(shouldPauseGoalAfterTerminal('max_turns'), true);
  assert.equal(shouldPauseGoalAfterTerminal('hook_stopped'), true);
  assert.equal(shouldPauseGoalAfterTerminal('aborted_tools', 'user-cancel'), true);
  assert.equal(shouldPauseGoalAfterTerminal('aborted_tools', 'interrupt'), false);
});
