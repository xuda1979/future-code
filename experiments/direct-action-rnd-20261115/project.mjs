import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const request = JSON.parse(readFileSync(0, 'utf8'));
const goal = await import(pathToFileURL(request.source + '/src/commands/goal/auto.ts'));
const context = await import(pathToFileURL(request.source + '/src/commands/goal/context.ts'));
if (request.operation === 'init') {
  goal.enableAutoGoal(request.goal, request.workspace, 6);
  console.log(JSON.stringify({ state: goal.readAutoGoal(request.workspace) }));
} else if (request.operation === 'continue') {
  console.log(JSON.stringify(goal.decideAutoGoalContinuation({ cwd: request.workspace,
    mainThread: true, withinTurnBudget: true, promptFormat: 'delta',
    assistantText: request.text ?? '', toolActivity: request.toolActivity })));
} else {
  const view = context.appendGoalRequestAnchor(request.history, { cwd: request.workspace,
    mainThread: true, makeMessage: content => ({ type: 'user', isMeta: true, message: { content } }),
    executionPolicy: context.goalExecutionPolicy(true, request.workspace) });
  console.log(JSON.stringify(view));
}
