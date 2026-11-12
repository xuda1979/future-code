import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import loop from '../../src/commands/loop/index.ts'
import { parseLoopTask } from '../../src/commands/loop/task.ts'
import { enableAutoGoal, readAutoGoal, takeAutoGoalContinuation } from '../../src/commands/goal/auto.ts'
import { AUTONOMOUS_DECISION_GUIDANCE } from '../../src/harness/autonomyPolicy.ts'

// Load the actual bundled registration/prompt builder while isolating native
// scheduler/bootstrap imports. No scheduling or permission implementation is
// replaced: this suite verifies parsing, prompts and absence of host mutations.
function bundledLoop() {
  const source = readFileSync(new URL('../../src/skills/bundled/loop.ts', import.meta.url), 'utf8')
  const start = source.indexOf("const DEFAULT_INTERVAL = '10m'")
  assert.ok(start >= 0)
  const code = stripTypeScriptTypes(source.slice(start).replace('export function registerLoopSkill', 'function registerLoopSkill'), { mode: 'transform' })
  let registered: any
  const scope = { parseLoopTask, AUTONOMOUS_DECISION_GUIDANCE,
    CRON_CREATE_TOOL_NAME: 'CronCreate', CRON_DELETE_TOOL_NAME: 'CronDelete', DEFAULT_MAX_AGE_DAYS: 3,
    isKairosCronEnabled: () => true, registerBundledSkill: (definition: any) => { registered = definition } }
  new Function(...Object.keys(scope), `${code}\nregisterLoopSkill();`)(...Object.values(scope))
  assert.equal(registered.name, 'loop')
  return registered
}

async function fixture(fn: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-autonomy-')), previous = process.cwd()
  try { process.chdir(dir); await fn() }
  finally { process.chdir(previous); rmSync(dir, { recursive: true, force: true }) }
}
function text(blocks: any[]): string { return blocks.map(block => block.text ?? '').join('\n') }

test('loop parsing retains the entire authorized request and its exact stop condition', () => {
  const raw = '  monitor experiments, test, build, commit, push and restart stop: operator pauses; no force-push  '
  const parsed = parseLoopTask(raw)!
  assert.equal(parsed.goalText, raw.trim())
  assert.equal(parsed.task, 'monitor experiments, test, build, commit, push and restart')
  assert.equal(parsed.stopCondition, 'operator pauses; no force-push')
  assert.equal(parsed.interval, null)
  const quoted = parseLoopTask('edit "stop: literal" and fix `stop: example` stop: all checks pass')!
  assert.equal(quoted.task, 'edit "stop: literal" and fix `stop: example`')
  assert.equal(quoted.stopCondition, 'all checks pass')
  assert.equal(parseLoopTask("don't change scope stop: all checks pass")!.stopCondition, 'all checks pass')
})

test('leading and trailing cadences parse deterministically without losing stop or budget constraints', () => {
  for (const [raw, interval, task] of [
    ['5m /babysit-prs', '5m', '/babysit-prs'],
    ['check deploy every 20m', '20m', 'check deploy'],
    ['run tests every 5 minutes', '5m', 'run tests'],
    ['check experiments every 2 hours', '2h', 'check experiments'],
    ['30s check jobs', '30s', 'check jobs'],
    ['1d check results', '1d', 'check results'],
  ]) {
    const parsed = parseLoopTask(raw!)!
    assert.equal(parsed.interval, interval)
    assert.equal(parsed.task, task)
    assert.equal(parsed.goalText, raw)
  }
  const constrained = parseLoopTask('check experiment every 5 minutes stop: budget reaches 10 API calls')!
  assert.equal(constrained.interval, '5m')
  assert.equal(constrained.stopCondition, 'budget reaches 10 API calls')
  assert.equal(constrained.goalText, 'check experiment every 5 minutes stop: budget reaches 10 API calls')
  assert.equal(parseLoopTask('check every PR')!.interval, null)
  assert.equal(parseLoopTask('check every PR')!.task, 'check every PR')
})

test('empty or taskless loops cannot manufacture a durable task', () => {
  for (const raw of ['', ' ', 'stop: all pass', '5m', '5m stop: all pass', '0m check jobs',
    'check jobs every 0 minutes', 'check jobs stop:', '999999999999999999m check jobs']) {
    assert.equal(parseLoopTask(raw), null, raw)
  }
})

test('builtin continuous loop has no fifth-iteration confirmation and preserves actual boundaries', async () => {
  const prompt = text(await (loop as any).getPromptForCommand('monitor experiments, test, build, commit and push', {}))
  assert.doesNotMatch(prompt, /up to 5 iterations|ask the user whether to continue|max iterations reached/i)
  assert.match(prompt, /CONTINUOUS LOOP/)
  assert.match(prompt, /does not complete the loop/)
  assert.match(prompt, /permission denials/)
  assert.match(prompt, /caller budgets/)
  assert.match(prompt, /native scheduling expiry/)
  assert.match(prompt, /Recovery attempted:/)
  assert.ok(prompt.includes(AUTONOMOUS_DECISION_GUIDANCE))
})

test('builtin stop-conditioned prompt retains the user condition instead of one-cycle completion', async () => {
  const prompt = text(await (loop as any).getPromptForCommand('fix tests stop: all requested checks pass', {}))
  assert.match(prompt, /STOP CONDITION: all requested checks pass/)
  assert.match(prompt, /Do not replace the user's condition with completion of one subtask/)
  assert.doesNotMatch(prompt, /CONTINUOUS LOOP/)
})

test('prompt expansion by Skill or worker cannot arm, resume or replace a host goal', async () => fixture(async () => {
  const bundled = bundledLoop()
  const contexts = [{ agentId: 'worker-1', options: { querySource: 'agent:worker' } },
    { options: { querySource: 'repl_main_thread' } }]
  for (const context of contexts) {
    await (loop as any).getPromptForCommand('monitor experiments', context)
    await bundled.getPromptForCommand('5m monitor experiments', context)
    assert.equal(readAutoGoal(), null)
  }
  enableAutoGoal('Preserve the existing user objective', process.cwd(), 8)
  takeAutoGoalContinuation({ mainThread: true, withinTurnBudget: true })
  const before = readAutoGoal()
  for (const context of contexts) {
    await (loop as any).getPromptForCommand('replace the objective stop: done', context)
    await bundled.getPromptForCommand('5m replace the objective', context)
  }
  assert.deepEqual(readAutoGoal(), before)
}))

test('scheduled loop preserves cadence, expiry and native control after an immediate execution', async () => {
  const bundled = bundledLoop()
  const prompt = text(await bundled.getPromptForCommand('5m /babysit-prs', {}))
  assert.match(prompt, /INTERVAL: "5m"/)
  assert.match(prompt, /PROMPT TO SCHEDULE: "\/babysit-prs"/)
  assert.match(prompt, /immediately execute/)
  assert.match(prompt, /not a continuous foreground iteration loop/)
  assert.match(prompt, /Recurring tasks expire after 3 days/)
  assert.match(prompt, /do not reset or silently renew that boundary/i)
  assert.match(prompt, /permission denials/)
  assert.match(prompt, /return control so native cron can drive later executions/)
  assert.match(prompt, /CronDelete/)
  assert.doesNotMatch(prompt, /up to 5 iterations|ask the user whether to continue/i)
  const until = text(await bundled.getPromptForCommand('check jobs every 5 minutes stop: requested experiment finishes', {}))
  assert.match(until, /USER STOP CONDITION: "requested experiment finishes"/)
  assert.match(until, /Loop stop condition: requested experiment finishes/)
  assert.match(until, /cancel only its actual recorded job ID/)
  assert.match(until, /without creating a redundant job/)
})

test('usage is side-effect free for both loop implementations', async () => fixture(async () => {
  for (const args of ['', '5m', 'stop: done']) {
    const help = text(await (loop as any).getPromptForCommand(args, {}))
    assert.match(help, /\/loop <prompt>/)
    const scheduled = text(await bundledLoop().getPromptForCommand(args, {}))
    assert.match(scheduled, /Usage: \/loop/)
    assert.equal(readAutoGoal(), null)
  }
}))
