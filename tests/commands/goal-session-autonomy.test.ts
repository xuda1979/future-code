import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoGoalReportPath, decideAutoGoalContinuation, enableAutoGoal, formatGoalRequestAnchor,
  parkActiveAutoGoal, pauseAutoGoal, readAutoGoal, resumeAutoGoalFromInput, isAutoGoalMainThread,
  formatActiveGoalCompactionAnchor } from '../../src/commands/goal/auto.ts';
import { configureAutoGoalSession, getAutoGoalSessionId, runWithAutoGoalSession } from '../../src/utils/autoGoalSession.ts';
import { trustedGoalInputs } from '../../src/commands/goal/input.ts';
import { runWithWorkload, WORKLOAD_CRON } from '../../src/utils/workloadContext.ts';
import { appendGoalRequestAnchor, goalExecutionPolicy } from '../../src/commands/goal/context.ts';

const task = 'continue: monitor the future-code session of quantum-gpt and all other future-code sessions; ' +
  'diagnose design bugs, improve and test, build binary, git add, commit, push and resume sessions using the new binary';
const loop = '/loop ' + task;
async function fixture(run: (cwd: string, select: (id: string) => void) => void | Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-sessions-'));
  let session = 'monitor-session';
  configureAutoGoalSession(() => session);
  try { await run(cwd, id => { session = id; }); }
  finally { configureAutoGoalSession(undefined); rmSync(cwd, { recursive: true, force: true }); }
}
const next = (cwd: string, withinTurnBudget = true) => decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget });
const humanLoop = (cwd: string, input = loop) => resumeAutoGoalFromInput(input, { cwd, mainThread: true, loopMode: 'builtin' });
const report = (cwd: string, body: string) => writeFileSync(autoGoalReportPath(cwd), '# ' + readAutoGoal(cwd)!.goal + '\n' + body);

test('the reported monitoring loop replaces REVIEW in its session and starts without another go', () => fixture((cwd) => {
  enableAutoGoal('test arg', cwd);
  report(cwd, 'Status: completed\n');
  assert.equal(next(cwd).kind, 'BLOCKED');
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW');
  const state = humanLoop(cwd);
  assert.equal(state?.state, 'ACTIVE');
  assert.equal(state?.goal, loop);
  assert.equal(state?.previousGoal, 'test arg');
  assert.deepEqual(state?.loop, { kind: 'continuous' });
  assert.equal(next(cwd).kind, 'CONTINUE');
  assert.match(formatGoalRequestAnchor(state!, cwd), /monitor.*quantum-gpt/);
  assert.match(formatGoalRequestAnchor(state!, cwd), /goals.*monitor-session.*goal\.md/);
}));

test('sessions in one checkout cannot replace goals, pause, review, question preferences or counters', () => fixture((cwd, select) => {
  humanLoop(cwd);
  next(cwd);
  const first = readAutoGoal(cwd), path = autoGoalReportPath(cwd);
  select('test-session');
  assert.equal(readAutoGoal(cwd), null);
  enableAutoGoal('test arg', cwd, 1);
  resumeAutoGoalFromInput('Ask me before implementation', { cwd, mainThread: true });
  report(cwd, 'Status: completed\n');
  assert.equal(next(cwd).kind, 'BLOCKED');
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW');
  assert.notEqual(autoGoalReportPath(cwd), path);
  select('monitor-session');
  assert.deepEqual(readAutoGoal(cwd), first);
  assert.equal(next(cwd).kind, 'CONTINUE');
  assert.equal(readAutoGoal(cwd)?.userQuestions, undefined);
}));

test('unowned legacy project state is preserved and cannot hijack a newly bound session', () => fixture((cwd) => {
  configureAutoGoalSession(undefined);
  enableAutoGoal('test arg', cwd);
  report(cwd, 'Status: completed\n');
  next(cwd);
  const legacy = readFileSync(join(cwd, '.future-code/goal-autonomy.json'), 'utf8');
  const oldReport = readFileSync(join(cwd, '.future-code/goal.md'), 'utf8');
  configureAutoGoalSession(() => 'monitor-session');
  assert.equal(readAutoGoal(cwd), null);
  humanLoop(cwd);
  assert.equal(next(cwd).kind, 'CONTINUE');
  assert.equal(readFileSync(join(cwd, '.future-code/goal-autonomy.json'), 'utf8'), legacy);
  assert.equal(readFileSync(join(cwd, '.future-code/goal.md'), 'utf8'), oldReport);
}));

test('a late outgoing query failure can only park its captured session', () => fixture(async (cwd, select) => {
  humanLoop(cwd);
  let finish!: () => void;
  const delayed = runWithAutoGoalSession(async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    assert.equal(getAutoGoalSessionId(), 'monitor-session');
    parkActiveAutoGoal('Network recovery exhausted in outgoing query', cwd);
  });
  select('other-session');
  enableAutoGoal('Run an independent experiment', cwd, 4);
  finish();
  await delayed;
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  assert.equal(readAutoGoal(cwd)?.goal, 'Run an independent experiment');
  select('monitor-session');
  assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
  assert.match(readAutoGoal(cwd)!.reason!, /outgoing query/);
}));

test('continuous loops survive completed cycles and their own report path survives compaction', () => fixture((cwd) => {
  humanLoop(cwd);
  for (let cycle = 0; cycle < 7; cycle++) {
    report(cwd, 'Status: completed\n- [x] Inspect all running sessions and verify this cycle\n');
    assert.equal(next(cwd).kind, 'CONTINUE');
    assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  }
  assert.equal(readAutoGoal(cwd)?.continuations, 7);
  const anchor = formatGoalRequestAnchor(readAutoGoal(cwd)!, cwd);
  assert.ok(anchor.includes(autoGoalReportPath(cwd)));
  assert.match(anchor, /Standing loop/);
}));

test('continuous loops honor actual external failures, operator stops and explicit caller budgets', () => fixture((cwd) => {
  humanLoop(cwd);
  pauseAutoGoal(cwd);
  assert.equal(next(cwd).kind, 'SKIP');
  humanLoop(cwd);
  assert.equal(next(cwd, false).kind, 'BLOCKED');
  assert.match(readAutoGoal(cwd)!.reason!, /max-turns/);
  humanLoop(cwd);
  report(cwd, 'Status: blocked\nBlocker: HTTP 403 from executor\nBlocker type: credentials\n' +
    'Recovery attempted: Renewed configured credentials; still denied\nExternal action required: Restore executor credentials\n');
  assert.equal(next(cwd).kind, 'BLOCKED');
  assert.match(readAutoGoal(cwd)!.reason!, /403/);
}));

test('an explicit finite loop preserves the stop contract and completion still requires review', () => fixture((cwd) => {
  const input = '/loop fix failing tests stop: all tests pass';
  const state = humanLoop(cwd, input);
  assert.equal(state?.goal, input);
  assert.deepEqual(state?.loop, { kind: 'until', stopCondition: 'all tests pass' });
  report(cwd, 'Status: completed\n- [x] All requested tests pass — evidence: test receipt\n');
  assert.equal(next(cwd).kind, 'BLOCKED');
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW', 'model text is not independent acceptance');
}));

test('repeating a human loop command cannot reset its continuation budget', () => fixture((cwd) => {
  enableAutoGoal(loop, cwd, 1, { loop: { kind: 'continuous' } });
  assert.equal(next(cwd).kind, 'CONTINUE');
  humanLoop(cwd);
  assert.equal(readAutoGoal(cwd)?.continuations, 1);
  assert.equal(next(cwd).kind, 'BLOCKED');
  humanLoop(cwd);
  assert.equal(next(cwd).kind, 'BLOCKED', 'reopening a paused loop retains used budget');
}));

test('scheduled slash metadata, SDK/worker input and a plugin command cannot bind human loop authority', () => fixture((cwd) => {
  enableAutoGoal('Explicitly stopped experiment', cwd);
  pauseAutoGoal(cwd);
  const before = readAutoGoal(cwd);
  const commands = [
    { value: loop, mode: 'prompt', isMeta: true },
    { value: loop, mode: 'prompt', origin: { kind: 'task-notification' } },
    { value: loop, mode: 'bash' },
  ];
  assert.deepEqual(trustedGoalInputs(commands), []);
  assert.equal(resumeAutoGoalFromInput(loop, { cwd, mainThread: false, loopMode: 'builtin' }), null);
  assert.equal(resumeAutoGoalFromInput(loop, { cwd, mainThread: true }), null, 'unknown plugin semantics are not builtin');
  assert.deepEqual(readAutoGoal(cwd), before);
  assert.deepEqual(trustedGoalInputs([...commands, { value: loop, mode: 'prompt' }]), [loop]);
}));

test('bundled scheduled loop setup finishes normally instead of occupying the cron foreground forever', () => fixture((cwd) => {
  const input = '/loop 10m check all running sessions';
  const state = resumeAutoGoalFromInput(input, { cwd, mainThread: true, loopMode: 'bundled' });
  assert.equal(state?.loop, undefined);
  assert.equal(state?.goal, input);
  report(cwd, 'Status: completed\n- [x] Schedule persisted and first inspection verified\n');
  assert.equal(next(cwd).kind, 'BLOCKED');
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW');
}));

test('namespace parent symlinks and traversal identities fail before writing another session', () => fixture((cwd, select) => {
  const outside = join(cwd, 'outside');
  mkdirSync(outside);
  mkdirSync(join(cwd, '.future-code'));
  symlinkSync(outside, join(cwd, '.future-code/goals'), 'dir');
  assert.throws(() => humanLoop(cwd), /Unsafe/);
  assert.equal(existsSync(join(outside, 'monitor-session/goal-autonomy.json')), false);
  select('../../foreign');
  assert.throws(() => readAutoGoal(cwd), /Invalid.*session/);
}));

test('later native cron ticks neither inherit foreground REVIEW anchors nor alter foreground state or reports', () => fixture((cwd) => {
  resumeAutoGoalFromInput('/loop 10m monitor all future-code sessions', { cwd, mainThread: true, loopMode: 'bundled' });
  report(cwd, 'Status: completed\n- [x] Scheduled the job and verified the immediate pass\n');
  next(cwd);
  const state = readAutoGoal(cwd), path = autoGoalReportPath(cwd), before = readFileSync(path, 'utf8');
  assert.equal(state?.state, 'REVIEW');
  runWithWorkload(WORKLOAD_CRON, () => {
    const mainThread = isAutoGoalMainThread('repl_main_thread');
    assert.equal(mainThread, false);
    assert.equal(readAutoGoal(cwd), null);
    const messages = [{ type: 'user', isMeta: true, message: { content: 'perform the saved monitoring task' } }];
    assert.strictEqual(appendGoalRequestAnchor(messages, { cwd, mainThread,
      makeMessage: content => ({ type: 'user', isMeta: true, message: { content } }) }), messages);
    assert.equal(formatActiveGoalCompactionAnchor(readAutoGoal(cwd), cwd), null);
    assert.equal(goalExecutionPolicy(mainThread, cwd), null);
    assert.equal(parkActiveAutoGoal('Scheduled task failed', cwd), null);
    assert.throws(() => enableAutoGoal('test arg', cwd), /scheduled task cannot replace/);
  });
  assert.deepEqual(readAutoGoal(cwd), state);
  assert.equal(readFileSync(path, 'utf8'), before);
}));

test('fresh input captures the selected session even when the caller inherited an outgoing async scope', () => fixture((cwd, select) => {
  humanLoop(cwd);
  runWithAutoGoalSession(() => {
    select('new-session');
    assert.equal(getAutoGoalSessionId(), 'monitor-session', 'old cleanup retains its owner');
    runWithAutoGoalSession(() => {
      assert.equal(getAutoGoalSessionId(), 'new-session');
      enableAutoGoal('Run the new session experiment', cwd);
    }, true);
    assert.equal(getAutoGoalSessionId(), 'monitor-session');
    assert.equal(readAutoGoal(cwd)?.goal, loop);
  });
  assert.equal(readAutoGoal(cwd)?.goal, 'Run the new session experiment');
}));

test('bootstrap session identity registration imports no Node-only async machinery', () => {
  const source = readFileSync(new URL('../../src/bootstrap/state.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ configureAutoGoalSession \} from 'src\/utils\/autoGoalSessionId\.js'/);
  assert.doesNotMatch(source, /from ['"](?:src\/utils\/autoGoalSession|node:async_hooks)['"]/);
  const leaf = readFileSync(new URL('../../src/utils/autoGoalSessionId.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(leaf, /^\s*import\b/m);
});
