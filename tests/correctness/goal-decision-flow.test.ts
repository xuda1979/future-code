import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { decideAutoGoalContinuation, enableAutoGoal, pauseAutoGoal, readAutoGoal, recordGoalSteering } from '../../src/commands/goal/auto.ts';
import { hasAutonomyQuestionRejection } from '../../src/query/autonomyQuestions.ts';
import { GoalFailureEvidence } from '../../src/query/goalFailureEvidence.ts';
import { AUTONOMY_QUESTION_REDIRECT_MARKER } from '../../src/harness/autonomyPolicy.ts';
import { isConnectorTextBlock } from '../../src/types/connectorText.ts';

// Exercise the actual signature cleanup used by provider recovery without
// importing the UI/bootstrap dependency graph of the full messages module.
const messageSource = readFileSync(new URL('../../src/utils/messages.ts', import.meta.url), 'utf8');
const thinkingStart = messageSource.indexOf('function isThinkingBlock(');
const thinkingEnd = messageSource.indexOf('\n/**', thinkingStart);
const stripStart = messageSource.indexOf('export function stripSignatureBlocks(');
const stripEnd = messageSource.indexOf('\n/**', stripStart);
assert.ok(thinkingStart > 0 && thinkingEnd > thinkingStart && stripStart > 0 && stripEnd > stripStart);
const signatureCode = stripTypeScriptTypes(messageSource.slice(thinkingStart, thinkingEnd) + '\n' +
  messageSource.slice(stripStart, stripEnd).replace('export function', 'function'), { mode: 'strip' });
const stripSignatureBlocks = new Function('feature', 'isConnectorTextBlock', signatureCode + '\nreturn stripSignatureBlocks;')(
  () => true, isConnectorTextBlock);

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
  ' incrementBudgetContinuationCount, logForDebugging, logEvent, budgetTracker, queryChainIdForAnalytics,',
  ' fallbackModel,currentModel,stripSignatureBlocks,createAssistantAPIErrorMessage,goalFailureEvidence} = ctx;',
  'let {goalToolActivity,autonomyRecoveryModelChanged} = ctx;',
  'let state;',
  'for (let iteration=0; iteration<1; iteration++) {',
  body,
  '}',
  'return {reason:"test-observed-continuation",state,goalToolActivity,autonomyRecoveryModelChanged};',
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
    toolUseContext: { options: { mainLoopModel: 'primary-model' } }, tracking: undefined, maxOutputTokensRecoveryCount: 0, silentResponseRecoveryCount: 0,
    hasAttemptedReactiveCompact: false, turnCount: 1, feature: () => true, readAutoGoal,
    checkTokenBudget: () => { budgetCalls++; return { action: 'continue', nudgeMessage: 'spend optional budget', continuationCount: 1, pct: 1, turnTokens: 1, budget: 100 }; },
    getCurrentTurnTokenBudget: () => 100, getTurnOutputTokens: () => 1,
    incrementBudgetContinuationCount: () => {}, logForDebugging: () => {}, logEvent: () => {},
    budgetTracker: {}, queryChainIdForAnalytics: 'test-chain', goalToolActivity: false,
    autonomyRecoveryModelChanged: false, currentModel: 'primary-model', fallbackModel: undefined, stripSignatureBlocks,
    goalFailureEvidence: new GoalFailureEvidence(),
    createAssistantAPIErrorMessage: (value: any) => ({ type: 'assistant', isApiErrorMessage: true, ...value }), ...extra,
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

test('ongoing goals continue independently of total output tokens already spent', () => fixture(async cwd => {
  enableAutoGoal('Finish and independently verify the requested outcome', cwd);
  const run = await flow('The candidate still needs an independent check.', {
    getCurrentTurnTokenBudget: () => 1,
    getTurnOutputTokens: () => Number.MAX_SAFE_INTEGER,
  });
  assert.equal(run.result.reason, 'test-observed-continuation');
  assert.equal(run.budgetCalls, 0, 'goal continuation does not use a lifetime token ceiling or spending target');
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  assert.equal(readAutoGoal(cwd)?.maxContinuations, null);
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
  ' createUserMessage,createAssistantAPIErrorMessage,fallbackModel,currentModel,toolUseContext,stripSignatureBlocks,assistantMessages,goalFailureEvidence,readAutoGoal} = ctx;',
  'let {goalToolActivity,rejectedAutonomyQuestions,autonomyRecoveryModelChanged,messagesForQuery} = ctx;',
  source.slice(questionStart, questionEnd),
  'return {reason:"test-observed-tool-followup",rejectedAutonomyQuestions,goalToolActivity,toolResults,autonomyRecoveryModelChanged,messagesForQuery,assistantMessages,toolUseContext};',
  '}',
].join('\n'), { mode: 'strip' });
const executeQuestion = new Function(questionCompiled + '\nreturn execute;')();

async function questionFlow(extra: Record<string, unknown> = {}) {
  const context = {
    hasAutonomyQuestionRejection, toolUseBlocks: [{ id: 'question', name: 'AskUserQuestion' }],
    toolResults: [{ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'question', is_error: true, content: AUTONOMY_QUESTION_REDIRECT_MARKER },
    ] } }],
    mainGoalThread: true, hasMainThreadQueuedCommand: () => false, getCommandQueueSnapshot: () => [],
    decideAutoGoalContinuation, maxTurns: undefined, turnCount: 1, autoGoalPolicy: 'stable policy',
    createSystemMessage: (content: string) => ({ type: 'system', content }),
    createUserMessage: (value: any) => ({ type: 'user', ...value }),
    createAssistantAPIErrorMessage: (value: any) => ({ type: 'assistant', isApiErrorMessage: true, ...value }),
    goalToolActivity: false, rejectedAutonomyQuestions: 0, autonomyRecoveryModelChanged: false,
    fallbackModel: undefined, currentModel: 'primary-model', toolUseContext: { options: { mainLoopModel: 'primary-model' } },
    goalFailureEvidence: new GoalFailureEvidence(), readAutoGoal,
    stripSignatureBlocks, messagesForQuery: [], assistantMessages: [], ...extra,
  };
  const generator = executeQuestion(context), emitted: any[] = [];
  for (;;) {
    const item = await generator.next();
    if (item.done) return { result: item.value, emitted };
    emitted.push(item.value);
  }
}

test('child continuation and question recovery never read foreground failure authority', async () => {
  let reads = 0;
  const deniedRead = () => { reads++; throw new Error('foreground state is unavailable to the child'); };
  await flow('Here is the requested analysis.', { mainGoalThread: false, readAutoGoal: deniedRead });
  const run = await questionFlow({ mainGoalThread: false, readAutoGoal: deniedRead });
  assert.equal(run.result.reason, 'test-observed-tool-followup');
  assert.equal(reads, 0);
});

for (const mainThread of [true, false]) for (const toolName of ['AskUserQuestion', 'EnterPlanMode']) {
  test('repeated rejected decision calls are bounded: main=' + mainThread + ', tool=' + toolName, () => fixture(async cwd => {
    enableAutoGoal('Complete both requested steps', cwd);
    let localRejections = 0;
    const maximum = mainThread ? 4 : 3;
    for (let attempt = 0; attempt < maximum; attempt++) {
      const { result, emitted } = await questionFlow({ mainGoalThread: mainThread,
        toolUseBlocks: [{ id: 'question', name: toolName }], rejectedAutonomyQuestions: localRejections });
      if (attempt < maximum - 1) {
        assert.equal(result.reason, 'test-observed-tool-followup');
        localRejections = result.rejectedAutonomyQuestions;
        if (mainThread && attempt === 2) assert.ok(result.toolResults.some((message: any) => /Host execution recovery/.test(message.content ?? '')));
      } else {
        assert.equal(result.reason, mainThread ? 'model_contract_failure' : 'model_error');
        assert.ok(emitted.some(message => /Model execution contract failure/.test(message.content ?? '')));
        assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE', 'neither a worker nor model handoff revokes parent authority');
      }
    }
  }));
}

function signedMessages() {
  return [{ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'private reasoning', signature: 'old-producer' },
    { type: 'redacted_thinking', data: 'old-producer' },
    { type: 'connector_text', text: 'bound text', connector_type: 'old-producer' },
    { type: 'text', text: 'Existing artifact evidence is retained.' },
  ] } }];
}

test('end-turn recovery selects the configured fallback and strips old producer signatures without tool execution', () => fixture(async cwd => {
  enableAutoGoal('Finish the already authorized workflow', cwd, 8);
  await flow('Should I continue?'); await flow('Should I continue?');
  const history = signedMessages(), assistant = signedMessages(), saved = structuredClone([...history, ...assistant]);
  const toolUseContext = { options: { mainLoopModel: 'primary-model' } };
  const run = await flow('Should I continue?', { messagesForQuery: history, assistantMessages: assistant.concat([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Should I continue?' }] } },
  ]), fallbackModel: 'fallback-model', toolUseContext });
  assert.equal(run.result.reason, 'test-observed-continuation');
  assert.equal(toolUseContext.options.mainLoopModel, 'fallback-model');
  assert.equal(run.result.autonomyRecoveryModelChanged, true);
  const content = JSON.stringify(run.result.state.messages);
  assert.doesNotMatch(content, /old-producer|"type":"thinking"|redacted_thinking|connector_text/);
  assert.match(content, /Existing artifact evidence is retained/);
  assert.match(content, /Host execution recovery/);
  assert.deepEqual([...history, ...assistant], saved, 'fallback request cleanup preserves durable history');
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  assert.equal(readAutoGoal(cwd)?.continuations, 3);
  assert.equal(run.budgetCalls, 0);
  assert.ok(run.emitted.some(message => /configured fallback/.test(message.content ?? '')));
}));

test('end-turn recovery with no fallback remains bounded and surfaces model failure without user pause', () => fixture(async cwd => {
  enableAutoGoal('Finish the already authorized workflow', cwd);
  await flow('Should I continue?'); await flow('Should I continue?');
  const recovery = await flow('Should I continue?');
  assert.match(recovery.result.state.messages.at(-1).content, /Host execution recovery/);
  assert.equal(recovery.result.autonomyRecoveryModelChanged, false);
  const failure = await flow('Should I continue?');
  assert.equal(failure.result.reason, 'model_contract_failure');
  assert.ok(failure.emitted.some(message => message.isApiErrorMessage && /No new authorization/.test(message.content)));
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
}));

test('rejected-question recovery uses the configured fallback while preserving real call/result pairing', () => fixture(async cwd => {
  enableAutoGoal('Finish the already authorized workflow', cwd, 8);
  await questionFlow(); await questionFlow();
  const history = signedMessages(), original = structuredClone(history), assistantMessages = signedMessages();
  assistantMessages.push({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'question', name: 'AskUserQuestion', input: {} },
  ] } } as any);
  const run = await questionFlow({ fallbackModel: 'fallback-model', messagesForQuery: history, assistantMessages });
  assert.equal(run.result.reason, 'test-observed-tool-followup');
  assert.equal(run.result.toolUseContext.options.mainLoopModel, 'fallback-model');
  assert.equal(run.result.autonomyRecoveryModelChanged, true);
  const view = JSON.stringify([...run.result.messagesForQuery, ...run.result.assistantMessages]);
  assert.doesNotMatch(view, /old-producer|"type":"thinking"|redacted_thinking|connector_text/);
  assert.match(view, /"type":"tool_use","id":"question"/);
  assert.ok(run.result.toolResults.some((message: any) => message.message?.content?.[0]?.tool_use_id === 'question'));
  assert.match(run.result.toolResults.at(-1).content, /Host execution recovery/);
  assert.deepEqual(history, original, 'history request view is replaced rather than rewritten');
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
  assert.equal(readAutoGoal(cwd)?.continuations, 3);
}));

test('queued user input and caller ceilings outrank rejected-question fallback and do not consume recovery', () => fixture(async cwd => {
  enableAutoGoal('Finish the already authorized workflow', cwd, 8);
  await questionFlow(); await questionFlow();
  const context = { options: { mainLoopModel: 'primary-model' } };
  const queued = await questionFlow({ fallbackModel: 'fallback-model', toolUseContext: context, hasMainThreadQueuedCommand: () => true });
  assert.equal(queued.result.reason, 'completed');
  assert.equal(context.options.mainLoopModel, 'primary-model');
  assert.equal(readAutoGoal(cwd)?.continuations, 2);
  assert.equal(readAutoGoal(cwd)?.routineDecisionRecoveryUsed, false);
  const limited = await questionFlow({ fallbackModel: 'fallback-model', toolUseContext: context, maxTurns: 1 });
  assert.equal(limited.result.reason, 'completed');
  assert.equal(context.options.mainLoopModel, 'primary-model');
  assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
  assert.match(readAutoGoal(cwd)!.reason!, /max-turns/);
  assert.equal(readAutoGoal(cwd)?.continuations, 2);
}));

const recordFailureSource = source.split('\n').find(line => line.includes('if (mainGoalThread) goalFailureEvidence.record(goalAtRequest,'));
assert.ok(recordFailureSource, 'production must record real tool failures under the request-time objective');
const recordRequestFailures = new Function('mainGoalThread', 'goalFailureEvidence', 'goalAtRequest', 'toolUseBlocks', 'toolResults', recordFailureSource);
const failureCall = (id: string, name = 'Bash') => ({ id, name });
const failedReceipt = (id: string) => ({ type: 'user', message: { content: [
  { type: 'tool_result', tool_use_id: id, is_error: true, content: 'HTTP 403: configured executor access denied' },
] } });
function blockedReport(cwd: string, goal: string, receipt: string, blocker = 'HTTP 403: configured executor access denied') {
  writeFileSync(join(cwd, '.future-code/goal.md'), '# ' + goal + '\nStatus: blocked\n' +
    'Blocker: ' + blocker + '\nBlocker type: permissions\n' +
    'Recovery attempted: Probed the configured executor and reconciled available routes; access is still denied\n' +
    'External action required: Restore the configured executor capability\nFailure receipt: ' + receipt + '\n');
}

for (const branch of ['end-turn', 'question']) {
  test('the production ' + branch + ' blocker boundary requires the actual current failed-tool ID', () => fixture(async cwd => {
    const goal = 'Finish the already authorized workflow';
    enableAutoGoal(goal, cwd);
    const evidence = new GoalFailureEvidence();
    blockedReport(cwd, goal, 'invented-call', 'The local work slot is exhausted');
    const fabricated = branch === 'end-turn' ? await flow('The work cannot continue.', { goalFailureEvidence: evidence }) :
      await questionFlow({ goalFailureEvidence: evidence });
    assert.equal(fabricated.result.reason, branch === 'end-turn' ? 'test-observed-continuation' : 'test-observed-tool-followup');
    assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
    recordRequestFailures(true, evidence, readAutoGoal(cwd), [failureCall('actual-failure')], [failedReceipt('actual-failure')]);
    assert.deepEqual(evidence.forGoal(readAutoGoal(cwd)), ['actual-failure']);
    blockedReport(cwd, goal, 'actual-failure');
    const authentic = branch === 'end-turn' ? await flow('The configured executor remains unavailable.', { goalFailureEvidence: evidence }) :
      await questionFlow({ goalFailureEvidence: evidence });
    assert.equal(authentic.result.reason, 'completed');
    assert.equal(readAutoGoal(cwd)?.state, 'PAUSED');
    assert.match(readAutoGoal(cwd)!.reason!, /HTTP 403/);
  }));
}

test('an old in-flight failure cannot authenticate a later objective or steering generation', () => fixture(async cwd => {
  const goal = 'Finish the already authorized workflow';
  enableAutoGoal(goal, cwd);
  const requestGoal = readAutoGoal(cwd), evidence = new GoalFailureEvidence();
  recordGoalSteering('Also preserve the new independently verified baseline', cwd);
  // The tool returns after human steering. The production record statement
  // must retain the goal captured before that request, never the new root.
  recordRequestFailures(true, evidence, requestGoal, [failureCall('old-failure')], [failedReceipt('old-failure')]);
  blockedReport(cwd, goal, 'old-failure');
  const run = await flow('The old executor failed.', { goalFailureEvidence: evidence });
  assert.equal(run.result.reason, 'test-observed-continuation');
  assert.deepEqual(evidence.forGoal(readAutoGoal(cwd)), []);
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE');
}));
