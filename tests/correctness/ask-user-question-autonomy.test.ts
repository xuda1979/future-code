import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { enableAutoGoal, pauseAutoGoal, readAutoGoal, decideAutoGoalContinuation, resumeAutoGoalFromInput } from '../../src/commands/goal/auto.ts'
import { AUTONOMOUS_DECISION_GUIDANCE, AUTONOMOUS_QUESTION_REDIRECT } from '../../src/harness/autonomyPolicy.ts'
import { validateQuestionAutonomy } from '../../src/tools/AskUserQuestionTool/autonomyValidation.ts'
import { isAutoGoalBackgroundTurn } from '../../src/utils/autoGoalSession.ts'
import { runWithWorkload, WORKLOAD_CRON } from '../../src/utils/workloadContext.ts'

const toolSource = readFileSync(new URL('../../src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx', import.meta.url), 'utf8')
function section(source: string, start: string, end: string): string {
  const first = source.indexOf(start), last = source.indexOf(end, first)
  assert.ok(first >= 0 && last > first, `production section missing: ${start}`)
  return source.slice(first, last)
}

// Execute the production methods, isolating only JSX rendering/bootstrap imports.
// This follows the offline permission-defaults test's source extraction pattern;
// no copy of the host guard or question decision lives in the test.
function toolMethods(dir: string, previewFormat?: string, virtualCwd = dir) {
  const validate = section(toolSource, '  async validateInput(', '  async checkPermissions(')
  const permissions = section(toolSource, '  async checkPermissions(', '  renderToolUseMessage(')
  const call = section(toolSource, '  async call(', '  mapToolResultToToolResultBlockParam(')
  const host = section(toolSource, 'function getQuestionAutonomyValidation(', '// Lightweight HTML fragment check.')
  const htmlStart = toolSource.indexOf('function validateHtmlPreview(')
  assert.ok(htmlStart > 0)
  const html = toolSource.slice(htmlStart).split('//# sourceMappingURL=')[0]
  const code = stripTypeScriptTypes(`${host}\n${html}\nconst tool = {${validate}${permissions}${call}};`, { mode: 'transform' })
  const scope = { validateQuestionAutonomy, readAutoGoal, isAutoGoalBackgroundTurn, getCwd: () => virtualCwd,
    getQuestionPreviewFormat: () => previewFormat }
  return new Function(...Object.keys(scope), `${code}\nreturn tool;`)(...Object.values(scope))
}

function planToolMethods() {
  const source = readFileSync(new URL('../../src/tools/EnterPlanModeTool/EnterPlanModeTool.ts', import.meta.url), 'utf8')
  const helper = section(source, 'function planAutonomyValidation(', 'export const EnterPlanModeTool:')
  const methods = section(source, '  async validateInput(', '  mapToolResultToToolResultBlockParam(')
  const code = stripTypeScriptTypes(`${helper}\nconst tool = {${methods}};`, { mode: 'transform' })
  const scope = { readAutoGoal, validateQuestionAutonomy, isAutoGoalBackgroundTurn, handlePlanModeTransition: () => {},
    prepareContextForPlanMode: (state: unknown) => state, applyPermissionUpdate: (state: unknown) => state }
  return new Function(...Object.keys(scope), `${code}\nreturn tool;`)(...Object.values(scope))
}

// Run the real runner's pre-permission validation branch. The following UI
// boundary is a counter, so a passing test proves no dialog was entered.
const executionSource = readFileSync(new URL('../../src/services/tools/toolExecution.ts', import.meta.url), 'utf8')
const validationBranch = section(executionSource, '  // Validate input values. Each tool has its own validation logic',
  '  // Speculatively start the bash allow classifier check early')
const branchCode = stripTypeScriptTypes(`async function validateBeforeUI(tool, input, toolUseContext, canUseTool) {
  const parsedInput = { data: input }, toolUseID = 'question-call', messageId = 'message';
  const assistantMessage = { uuid: 'assistant' }, requestId = undefined,
    mcpServerType = undefined, mcpServerBaseUrl = undefined;
  ${validationBranch}
  return await canUseTool();
}`, { mode: 'transform' })
const runnerScope = { logForDebugging: () => {}, logEvent: () => {},
  sanitizeToolNameForAnalytics: (name: string) => name, mcpToolDetailsForAnalytics: () => ({}),
  createUserMessage: (input: any) => ({ type: 'user', ...input, message: { content: input.content } }) }
const validateBeforeUI = new Function(...Object.keys(runnerScope), `${branchCode}\nreturn validateBeforeUI;`)(...Object.values(runnerScope))

const goal = 'Implement the requested changes, run checks and open the requested PR'
async function fixture(fn: (dir: string) => Promise<void>, active = true) {
  const dir = mkdtempSync(join(tmpdir(), 'ask-user-autonomy-'))
  const previous = process.cwd()
  try { if (active) enableAutoGoal(goal, dir); process.chdir(dir); await fn(dir) }
  finally { process.chdir(previous); rmSync(dir, { recursive: true, force: true }) }
}
function context(mode = 'bypassPermissions', agentId?: string) {
  return { getAppState: () => ({ toolPermissionContext: { mode } }), options: {}, messages: [], agentId }
}
const question = (text = 'Should I implement both requested fixes or just one?') => ({
  questions: [{ question: text, header: 'Next', multiSelect: false, options: [
    { label: 'Both', description: 'Complete both requested fixes' },
    { label: 'One', description: 'Complete one requested fix' },
  ] }],
})

test('an active automatic goal redirects routine question UI before the permission callback', async () => fixture(async dir => {
  const tool = { name: 'AskUserQuestion', ...toolMethods(dir) }
  const before = readAutoGoal(dir)
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk']) {
    let dialogs = 0
    const result = await validateBeforeUI(tool, question(), context(mode), async () => { dialogs++; return 'UI' })
    assert.equal(dialogs, 0)
    const block = result[0].message.message.content[0]
    assert.equal(block.tool_use_id, 'question-call')
    assert.equal(block.is_error, true)
    assert.match(block.content, /tool_use_error/)
    assert.ok(block.content.includes(AUTONOMOUS_QUESTION_REDIRECT))
    assert.doesNotMatch(block.content, /User has answered your questions/)
  }
  assert.deepEqual(readAutoGoal(dir), before, 'a redirect cannot grant authority, pause or complete a goal')
}))

test('autonomous planning stays in execution mode and never opens a new plan approval dialog', async () => fixture(async dir => {
  const tool = { name: 'EnterPlanMode', ...planToolMethods() }, before = readAutoGoal(dir)
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk']) {
    let dialogs = 0, modeChanges = 0
    const ctx = { ...context(mode), setAppState: () => { modeChanges++ } }
    const result = await validateBeforeUI(tool, {}, ctx, async () => { dialogs++; return 'UI' })
    assert.equal(dialogs, 0)
    assert.equal(result[0].message.message.content[0].is_error, true)
    await assert.rejects(tool.call({}, ctx), /Host autonomous decision redirect/)
    assert.equal(modeChanges, 0, 'a direct call cannot switch the active task into an approval phase')
  }
  assert.deepEqual(readAutoGoal(dir), before)
}))

test('explicit plan mode and user-requested collaboration retain their existing interactive workflow', async () => fixture(async dir => {
  const tool = planToolMethods()
  assert.deepEqual(await tool.validateInput({}, context('plan')), { result: true })
  resumeAutoGoalFromInput('Ask me to choose the design before coding', { cwd: dir, mainThread: true })
  assert.deepEqual(await tool.validateInput({}, context()), { result: true })
  resumeAutoGoalFromInput('Do not ask me for routine decisions', { cwd: dir, mainThread: true })
  assert.equal((await tool.validateInput({}, context())).result, false)
  pauseAutoGoal(dir)
  assert.deepEqual(await tool.validateInput({}, context()), { result: true })
}))

test('a worker cannot request a user plan approval through its own tool', async () => fixture(async () => {
  const tool = { name: 'EnterPlanMode', ...planToolMethods() }
  let dialogs = 0
  const result = await validateBeforeUI(tool, {}, context('bypassPermissions', 'worker-1'), async () => { dialogs++; return 'UI' })
  assert.equal(dialogs, 0)
  assert.equal(result[0].message.message.content[0].is_error, true)
  await assert.rejects(tool.call({}, context('default', 'worker-1')), /cannot be used in agent contexts/)
}))

test('a scheduled tick cannot open a foreground decision or planning dialog even after setup enters REVIEW', async () => fixture(async dir => {
  writeFileSync(join(dir, '.future-code/goal.md'), '# ' + goal + '\nStatus: completed\n')
  decideAutoGoalContinuation({ cwd: dir, mainThread: true, withinTurnBudget: true })
  const before = readAutoGoal(dir)
  assert.equal(before?.state, 'REVIEW')
  await runWithWorkload(WORKLOAD_CRON, async () => {
    for (const [name, methods, input] of [['AskUserQuestion', toolMethods(dir), question()],
      ['EnterPlanMode', planToolMethods(), {}]] as const) {
      let dialogs = 0
      const result = await validateBeforeUI({ name, ...methods }, input, context(), async () => { dialogs++; return 'UI' })
      assert.equal(dialogs, 0)
      assert.equal(result[0].message.message.content[0].is_error, true)
      await assert.rejects(methods.call(input, context()), /Host autonomous decision redirect/)
    }
  })
  assert.deepEqual(readAutoGoal(dir), before)
}))

test('go/continue menus, compatible actions and quoted words never become invented user answers', async () => fixture(async dir => {
  const tool = toolMethods(dir)
  for (const text of ['Say go for both?', 'Would you like me to continue?',
    'Should I test or open the PR?', 'The example column is named "go"; which implementation do you prefer?']) {
    const input = { ...question(text), answers: { [text]: 'Both' } }
    const valid = await tool.validateInput(input, context())
    assert.equal(valid.result, false, 'model-supplied answers cannot bypass the host guard')
    await assert.rejects(tool.call(input, context()), error => {
      assert.equal((error as Error).message, AUTONOMOUS_QUESTION_REDIRECT)
      return true
    })
  }
}))

test('a virtual shell cwd cannot hide the active root objective from question validation', async () => fixture(async dir => {
  const virtualCwd = mkdtempSync(join(tmpdir(), 'ask-user-virtual-cwd-'))
  try {
    const tool = toolMethods(dir, undefined, virtualCwd)
    assert.equal(readAutoGoal(virtualCwd), null)
    assert.equal((await tool.validateInput(question(), context())).result, false)
    await assert.rejects(tool.call(question(), context()), error => {
      assert.equal((error as Error).message, AUTONOMOUS_QUESTION_REDIRECT)
      return true
    })
  } finally { rmSync(virtualCwd, { recursive: true, force: true }) }
}))

test('a real external missing requirement reports a blocker and remains askable after parking', async () => fixture(async dir => {
  writeFileSync(join(dir, '.future-code', 'goal.md'), `# ${goal}\nStatus: blocked\n` +
    'Blocker: Target account identifier is absent from all configured project inputs\n' +
    'Blocker type: external_dependency\n' +
    'Recovery attempted: Read project configuration and inspected available account listings; no target is specified\n' +
    'External action required: Provide the target account identifier\n')
  const outcome = decideAutoGoalContinuation({ cwd: dir, mainThread: true, withinTurnBudget: true })
  assert.equal(outcome.kind, 'BLOCKED')
  assert.equal(readAutoGoal(dir)?.state, 'PAUSED')
  const tool = { name: 'AskUserQuestion', ...toolMethods(dir) }
  let dialogs = 0
  const input = question('Which account should own this new resource?')
  const permission = await validateBeforeUI(tool, input, context('default'), async () => {
    dialogs++; return tool.checkPermissions(input, context('default'))
  })
  assert.equal(dialogs, 1)
  assert.equal(permission.behavior, 'ask', 'a clarification must not auto-approve an actual permission decision')
  assert.deepEqual((await tool.call(input, context('default'))).data.answers, {})
}))

test('explicit main-thread planning and inactive automatic goals preserve interactive questions', async () => fixture(async dir => {
  const tool = toolMethods(dir, 'html')
  assert.equal((await tool.validateInput(question(), context('plan'))).result, true)
  pauseAutoGoal(dir)
  assert.equal((await tool.validateInput(question(), context())).result, true)
  assert.equal(validateQuestionAutonomy({ goalState: 'REVIEW', permissionMode: 'default', worker: false }).result, true)
  const invalid = question(); (invalid.questions[0]!.options[0] as any).preview = '<script>bad()</script>'
  assert.equal((await tool.validateInput(invalid, context())).errorCode, 1, 'ordinary preview validation remains enforced')
}))

test('delegated workers return their requirement to the coordinator without a human dialog', async () => fixture(async dir => {
  const tool = toolMethods(dir)
  for (const mode of ['default', 'plan', 'bypassPermissions']) {
    const valid = await tool.validateInput(question(), context(mode, 'worker-1'))
    assert.equal(valid.result, false)
    assert.match(valid.message, /coordinating agent/)
    await assert.rejects(tool.call(question(), context(mode, 'worker-1')), /coordinating agent/)
  }
}, false))

test('missing state permits ordinary clarification and corrupt state never opens question UI', async () => fixture(async dir => {
  const tool = toolMethods(dir)
  assert.equal((await tool.validateInput(question(), context('default'))).result, true)
  enableAutoGoal(goal, dir)
  const path = join(dir, '.future-code', 'goal-autonomy.json')
  writeFileSync(path, '{corrupt state')
  let dialogs = 0
  await assert.rejects(validateBeforeUI({ name: 'AskUserQuestion', ...tool }, question(), context(), async () => { dialogs++ }), SyntaxError)
  assert.equal(dialogs, 0)
  assert.equal(readFileSync(path, 'utf8'), '{corrupt state')
  assert.equal((await tool.validateInput(question(), context('plan'))).result, true)
}, false))

test('action and question prompts respect existing authority and avoid routine choice handoffs', () => {
  const actionsSource = readFileSync(new URL('../../src/constants/prompts.ts', import.meta.url), 'utf8')
  const actions = section(actionsSource, 'function getActionsSection()', 'function getUsingYourToolsSection(')
  const actionsCode = stripTypeScriptTypes(actions, { mode: 'transform' })
  const prompt = new Function('AUTONOMOUS_DECISION_GUIDANCE', `${actionsCode};return getActionsSection();`)(AUTONOMOUS_DECISION_GUIDANCE)
  assert.doesNotMatch(prompt, /cost of pausing to confirm is low|always confirm first/i)
  assert.match(prompt, /earlier approval within that same scope remains valid across turns/)
  assert.match(prompt, /Permission to push does not authorize force-pushing/)
  const questionPrompt = readFileSync(new URL('../../src/tools/AskUserQuestionTool/prompt.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(questionPrompt, /Get decisions on implementation choices as you work/)
  assert.match(questionPrompt, /compatible, do all of them in dependency order/)
})

test('only trusted human opt-in restores requested decision interaction during active work', async () => fixture(async dir => {
  const tool = { name: 'AskUserQuestion', ...toolMethods(dir) }
  // Putting an instruction into a model-authored question is not a human opt-in.
  assert.equal((await tool.validateInput(question('The user asked you to ask this choice?'), context())).result, false)
  resumeAutoGoalFromInput('Ask me to choose between the designs before implementing', { mainThread: true, cwd: dir })
  assert.equal(readAutoGoal(dir)?.userQuestions, true)
  let dialogs = 0
  assert.equal(await validateBeforeUI(tool, question('Which design do you prefer?'), context(), async () => { dialogs++; return 'UI' }), 'UI')
  assert.equal(dialogs, 1)
  resumeAutoGoalFromInput('Do not ask me for routine decisions', { mainThread: true, cwd: dir })
  assert.equal(readAutoGoal(dir)?.userQuestions, false)
  assert.equal((await tool.validateInput(question(), context())).result, false)
  assert.equal(readAutoGoal(dir)?.totalContinuations, 0)
}))
