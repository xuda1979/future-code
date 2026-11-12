import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { decideAutoGoalContinuation, enableAutoGoal, pauseAutoGoal, readAutoGoal } from '../../src/commands/goal/auto.ts';
import { hasAutonomyQuestionRejection } from '../../src/query/autonomyQuestions.ts';
import { AUTONOMY_QUESTION_REDIRECT_MARKER } from '../../src/harness/autonomyPolicy.ts';

// Run the production end-turn branches verbatim. Model, UI and optional budget
// services are injected; durable objective decisions and state remain real.
const source = readFileSync(new URL('../../src/query.ts', import.meta.url), 'utf8');
const start = source.indexOf('      // A completed model turn is not a completed explicitly opted-in R&D goal.');
const end = source.indexOf('\n    }\n\n    let shouldPreventContinuation', start);
assert.ok(start > 0 && end > start);
const body = source.slice(start, end);
const compiled = stripTypeScriptTypes([
  'async function* execute(ctx: any) {',
  'const {mainGoalThread, maxTurns, autoGoalPolicy, assistantMessages, decideAutoGoalContinuation,',
  ' createSystemMessage, createUserMessage, activity, messagesForQuery, toolUseContext, tracking,',
  ' maxOutputTokensRecoveryCount, silentResponseRecoveryCount, hasAttemptedReactiveCompact, turnCount,',
  ' feature, readAutoGoal, checkTokenBudget, getCurrentTurnTokenBudget, getTurnOutputTokens,',
  ' incrementBudgetContinuationCount, logForDebugging, logEvent, budgetTracker, queryChainIdForAnalytics} = ctx;',
  'let {goalToolActivity} = ctx;',
  'let state;',
  'for (let iteration=0; iteration<1; iteration++) {',
  body,
  '}',
  'return {reason:"test-observed-continuation",state,goalToolActivity};',
  '}',
].join('\n'), { mode: 'strip' });
const execute = new Function(compiled + '\nreturn execute;')();

async function fixture(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-decision-flow-'));
  const previous = process.cwd();
  process.chdir(cwd);
  try { await run(cwd); } finally { process.chdir(previous); rmSync(cwd, { recursive: true, force: true }); }
}
async function flow(assistantText: string, extra: Record<string, unknown> = {}) {
  let budgetCalls = 0;
  const ctx = {
    mainGoalThread: true, maxTurns: undefined, autoGoalPolicy: 'stable host policy',
    assistantMessages: [{ type: 'assistant', message: { content: [{ type: 'text', text: assistantText }] } }],
    decideAutoGoalContinuation, createSystemMessage: (content: string) => ({ type: 'system', content }),
    createUserMessage: (value: any) => ({ type: 'user', ...value }),
    activity: () => {}, messagesForQuery: [{ type: 'user', message: { content: 'human source: Say go for both' } }],
    toolUseContext: {}, tracking: undefined, maxOutputTokensRecoveryCount: 0, silentResponseRecoveryCount: 0,
    hasAttemptedReactiveCompact: false, turnCount: 1, feature: () => true, readAutoGoal,
    checkTokenBudget: () => { budgetCalls++; return { action: 'continue', nudgeMessage: 'spend optional budget', continuationCount: 1, pct: 1, turnTokens: 1, budget: 100 }; },
    getCurrentTurnTokenBudget: () => 100, getTurnOutputTokens: () => 1,
    incrementBudgetContinuationCount: () => {}, logForDebugging: () => {}, logEvent: () => {},
    budgetTracker: {}, queryChainIdForAnalytics: 'test-chain', goalToolActivity: false, ...extra,
  };
  const generator = execute(ctx), emitted: any[] = [];
  for (;;) {
    const item = await generator.next();
    if (item.done) return { result: item.value, emitted, budgetCalls };
    emitted.push(item.value);
  }
}

test('the exact routine decision reply produces execution guidance before optional budget nudges', () => fixture(async cwd => {
  const goal = 'Push the authorized commit then continue standing sync cycles';
  enableAutoGoal(goal, cwd, 5);
  writeFileSync(join(cwd, '.future-code/goal.md'), '# ' + goal + '\nStatus: completed\n');
  const run = await flow('Push bd410db to origin/main. Continue periodic sync cycles.\nSay "go" for both, or pick either one.');
  assert.equal(run.result.reason, 'test-observed-continuation');
  const instruction = run.result.state.messages.at(-1).content;
  assert.match(instruction, /dependency order/);
  assert.match(instruction, /not a user answer or new authorization/);
  assert.equal(run.result.state.turnCount, 2);
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  assert.equal(readAutoGoal(cwd)?.totalContinuations, 1);
  assert.equal(run.budgetCalls, 0);
}));

test('genuine closed completion reaches review without spending an optional token target', () => fixture(async cwd => {
  enableAutoGoal('Verify the requested edit', cwd);
  writeFileSync(join(cwd, '.future-code/goal.md'), '# Verify the requested edit\nStatus: completed\n- [x] Verify the requested edit\n');
  const run = await flow('The requested edit and checks are complete.');
  assert.equal(run.result.reason, 'completed');
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW');
  assert.equal(run.budgetCalls, 0);
}));

test('a paused objective is never revived by optional token continuation', () => fixture(async cwd => {
  enableAutoGoal('Verify the requested edit', cwd);
  pauseAutoGoal(cwd);
  const run = await flow('Here is the status you requested.');
  assert.equal(run.result.reason, 'completed');
  assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
  assert.equal(run.budgetCalls, 0);
}));

test('human quoted handoff text is never attributed to the assistant', () => fixture(async cwd => {
  enableAutoGoal('Verify the requested edit', cwd);
  writeFileSync(join(cwd, '.future-code/goal.md'), '# Verify the requested edit\nStatus: completed\n');
  const run = await flow('The quoted unwanted prompt was removed and all requested work is complete.');
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW');
  assert.equal(run.result.reason, 'completed');
}));

test('caller turn ceilings still win over a requested routine handoff correction', () => fixture(async cwd => {
  enableAutoGoal('Verify the requested edit', cwd, 5);
  const run = await flow('Say go for both.', { maxTurns: 1 });
  assert.equal(run.result.reason, 'completed');
  assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
  assert.match(readAutoGoal(cwd)!.reason!, /max-turns/);
  assert.equal(readAutoGoal(cwd)?.totalContinuations, 0);
  assert.equal(run.budgetCalls, 0);
}));

test('rejected question results cannot masquerade as executed work to reset the recovery guard', () => {
  const begin = source.indexOf('    goalToolActivity ||= toolResults.some');
  assert.ok(begin > 0);
  const expression = source.slice(begin).split('\n\n')[0];
  const observe = new Function('toolResults', 'let goalToolActivity=false;\n' + expression + ';\nreturn goalToolActivity;');
  const receipt = (is_error: boolean) => ({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'one', is_error, content: is_error ? 'Question redirected' : 'actual tool evidence' },
  ] } });
  assert.equal(observe([receipt(true)]), false);
  assert.equal(observe([receipt(false)]), true);
  assert.equal(observe([{ type: 'user', message: { content: 'claim of progress' } }]), false);
  assert.ok(source.indexOf('return { reason: \'hook_stopped\' }') < begin);
});

test('only a matched host question redirect is eligible for rejection recovery', () => {
  const call = { id: 'question-1', name: 'AskUserQuestion' };
  const result = { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: call.id, is_error: true, content: AUTONOMY_QUESTION_REDIRECT_MARKER },
  ] } };
  assert.equal(hasAutonomyQuestionRejection([call], [result]), true);
  assert.equal(hasAutonomyQuestionRejection([{ ...call, name: 'EnterPlanMode' }], [result]), true);
  assert.equal(hasAutonomyQuestionRejection([{ ...call, name: 'Bash' }], [result]), false);
  assert.equal(hasAutonomyQuestionRejection([{ ...call, id: 'other' }], [result]), false);
  assert.equal(hasAutonomyQuestionRejection([call], [{ ...result, type: 'assistant' }]), false);
  assert.equal(hasAutonomyQuestionRejection([call], [{ type: 'user', message: { content: [
    { ...result.message.content[0], is_error: false },
  ] } }]), false);
});

const questionStart = source.indexOf('    // A rejected question is model feedback, never productive tool work.');
const questionEnd = source.indexOf('    if (tracking?.compacted)', questionStart);
assert.ok(questionStart > 0 && questionEnd > questionStart);
const questionCompiled = stripTypeScriptTypes([
  'async function* execute(ctx: any) {',
  'const {hasAutonomyQuestionRejection,toolUseBlocks,toolResults,mainGoalThread,hasMainThreadQueuedCommand,',
  ' getCommandQueueSnapshot,decideAutoGoalContinuation,maxTurns,turnCount,autoGoalPolicy,createSystemMessage,',
  ' createUserMessage,createAssistantAPIErrorMessage} = ctx;',
  'let {goalToolActivity,rejectedAutonomyQuestions} = ctx;',
  source.slice(questionStart, questionEnd),
  'return {reason:"test-observed-tool-followup",rejectedAutonomyQuestions,goalToolActivity,toolResults};',
  '}',
].join('\n'), { mode: 'strip' });
const executeQuestion = new Function(questionCompiled + '\nreturn execute;')();

for (const mainThread of [true, false]) for (const toolName of ['AskUserQuestion', 'EnterPlanMode']) {
  test('repeated rejected decision calls are bounded: main=' + mainThread + ', tool=' + toolName, () => fixture(async cwd => {
    enableAutoGoal('Complete both requested steps', cwd);
    let localRejections = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const context = {
        hasAutonomyQuestionRejection, toolUseBlocks: [{ id: 'question', name: toolName }],
        toolResults: [{ type: 'user', message: { content: [
          { type: 'tool_result', tool_use_id: 'question', is_error: true, content: AUTONOMY_QUESTION_REDIRECT_MARKER },
        ] } }],
        mainGoalThread: mainThread, hasMainThreadQueuedCommand: () => false, getCommandQueueSnapshot: () => [],
        decideAutoGoalContinuation, maxTurns: undefined, turnCount: 1, autoGoalPolicy: 'stable policy',
        createSystemMessage: (content: string) => ({ type: 'system', content }),
        createUserMessage: (value: any) => ({ type: 'user', ...value }),
        createAssistantAPIErrorMessage: (value: any) => ({ type: 'assistant', isApiErrorMessage: true, ...value }),
        goalToolActivity: false, rejectedAutonomyQuestions: localRejections,
      };
      const generator = executeQuestion(context), emitted: any[] = [];
      let outcome: any;
      for (;;) {
        const item = await generator.next();
        if (item.done) { outcome = item.value; break; }
        emitted.push(item.value);
      }
      if (attempt < 2) {
        assert.equal(outcome.reason, 'test-observed-tool-followup');
        localRejections = outcome.rejectedAutonomyQuestions;
      } else {
        assert.equal(outcome.reason, mainThread ? 'completed' : 'model_error');
        assert.ok(emitted.some(message => /Model execution contract failure/.test(message.content ?? '')));
        assert.equal(readAutoGoal(cwd)?.state, mainThread ? 'PAUSED' : 'ACTIVE',
          'a worker cannot park the parent objective');
      }
    }
  }));
}
