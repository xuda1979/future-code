import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { simpleShellWords, gitActivity, isShellObservation } from '../../src/utils/shellActivity.ts'
import { nextGitDeliveryPhase, gitDeliveryPolicy, gitDeliveryIntent } from '../../src/utils/gitDeliveryPolicy.ts'
import { actionFocusReview } from '../../src/commands/goal/actionFocus.ts'
import { automaticPermissionDecision, interactivePromptsEnabled, unattendedGitEnvironment } from '../../src/utils/permissions/interactivePrompts.ts'
import { validateQuestionAutonomy } from '../../src/tools/AskUserQuestionTool/autonomyValidation.ts'
import { enableAutoGoal, readAutoGoal, takeAutoGoalContinuation } from '../../src/commands/goal/auto.ts'

const result = (id: string, failed = false) => ({ type: 'user', message: {
  content: [{ type: 'tool_result', tool_use_id: id, content: failed ? 'failed' : 'actual receipt', is_error: failed }],
} })
const call = (id: string, command: string) => ({ id, name: 'Bash', input: { command } })
function unattended<T>(run: () => T): T {
  const old = process.env.FUTURE_CODE_INTERACTIVE_PROMPTS
  delete process.env.FUTURE_CODE_INTERACTIVE_PROMPTS
  try { return run() }
  finally { if (old === undefined) delete process.env.FUTURE_CODE_INTERACTIVE_PROMPTS; else process.env.FUTURE_CODE_INTERACTIVE_PROMPTS = old }
}

test('shell observations cover common direct diagnostics, including quoted paths', () => {
  for (const command of ['git status --short', 'git -C "/repo with space" --no-pager diff',
    'rg --files src', 'rg "important symbol" src', "cat 'docs/file name.md'", 'pwd', 'ls -la', 'head -n 20 file'])
    assert.equal(isShellObservation(command), true, command)
  for (const command of ['git diff --output=receipt', 'git log --output receipt', 'git show --textconv HEAD:file',
    'git config key value', 'git status && touch file', 'cat file > copy', 'rg --pre=runner pattern',
    'find . -delete', 'python script.py', 'git status\nrm file', 'git status # note', 'git "sta"tus',
    'git status $(runner)', 'git status | cat', 'git -c alias.status=runner status'])
    assert.equal(isShellObservation(command), false, command)
  assert.equal(simpleShellWords('cat "unterminated'), null)
  assert.equal(simpleShellWords('cat ' + 'x'.repeat(8192)), null)
  assert.equal(gitActivity('git -C repo commit -m "tested change"'), 'deliver')
  assert.equal(gitActivity('git -C'), null)
})

test('shell searches/status checks no longer reset observation-only review', () => {
  const messages = Array.from({ length: 12 }, (_, n) => {
    const command = n % 2 ? `rg symbol${n} src` : 'git status --short'
    return [{ type: 'assistant', message: { content: [{ type: 'tool_use', ...call(`c${n}`, command) }] } }, result(`c${n}`)]
  }).flat()
  const before = structuredClone(messages)
  assert.match(actionFocusReview(messages, '/repo/.future-code/goal.md')!, /12 observation\/planning receipts/)
  assert.deepEqual(messages, before)
  messages.push({ type: 'assistant', message: { content: [{ type: 'tool_use', ...call('experiment', 'node run-experiment.mjs') }] } }, result('experiment'))
  assert.equal(actionFocusReview(messages, '/repo/.future-code/goal.md'), null, 'a completed experiment resets earlier observation warnings')
  messages.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'change', name: 'Edit',
    input: { file_path: '/repo/result.txt', old_string: 'old', new_string: 'new' } }] } }, result('change'))
  assert.equal(actionFocusReview(messages, '/repo/.future-code/goal.md'), null, 'a completed edit resets the diagnostic')
})

test('mixed tasks enter delivery only after paired effects; checks/errors release deep reasoning', () => {
  assert.equal(gitDeliveryPolicy([{ type: 'user', message: { content: 'Fix the issue, test it, then commit and push' } }], true), false)
  let phase = nextGitDeliveryPhase(false, [call('stage', 'git add src/worker.ts')], [result('stage')])
  assert.equal(phase, true)
  phase = nextGitDeliveryPhase(phase, [call('status', 'git status --short')], [result('status')])
  assert.equal(phase, true)
  assert.equal(nextGitDeliveryPhase(phase, [call('check', 'node scripts/test-correctness.mjs')], [result('check')]), false)
  assert.equal(nextGitDeliveryPhase(phase, [call('push', 'git push origin feature')], [result('push', true)]), false)
  assert.equal(nextGitDeliveryPhase(false, [call('missing', 'git push')], [result('other')]), false)
  assert.equal(nextGitDeliveryPhase(false, [call('dup', 'git push')], [result('dup'), result('dup')]), false)
  assert.equal(nextGitDeliveryPhase(false, [call('dup', 'git push'), call('dup', 'git push')], [result('dup')]), false)
  assert.equal(nextGitDeliveryPhase(false, [call('child', 'git push')], [{ ...result('child'), origin: { type: 'agent' } }]), false)
  assert.equal(nextGitDeliveryPhase(false, [{ ...call('bg', 'git push'), input: { command: 'git push', run_in_background: true } }], [result('bg')]), false)
  assert.equal(nextGitDeliveryPhase(false, [call('auto-bg', 'git push')],
    [{ ...result('auto-bg'), toolUseResult: { backgroundTaskId: 'running-job' } }]), false)
  assert.equal(nextGitDeliveryPhase(false, [call('stage', 'git add file'), call('edit', 'touch file')], [result('stage'), result('edit')]), false)
})

test('Git used inside research cannot impose a delivery deadline on the next research decision', () => {
  const human = (text: string) => [{ type: 'user', message: { content: text } }]
  for (const text of ['Fix the issue, verify it, then commit and push', 'Investigate and send a PR', 'git push the code'])
    assert.equal(gitDeliveryIntent(human(text), true), true, text)
  for (const text of ['Research commit algorithms', 'Test the staging mechanism in a temporary repository',
    'Do not push the changes', 'Do not create a PR', 'Why does git push take hours?', 'Use this example: ```git commit```'])
    assert.equal(gitDeliveryIntent(human(text), true), false, text)
  assert.equal(gitDeliveryIntent([{ ...human('then commit and push')[0]!, origin: { type: 'agent' } }], true), false)
  assert.equal(gitDeliveryIntent(human('then commit and push'), false), false)
  const query = readFileSync(new URL('../../src/query.ts', import.meta.url), 'utf8')
  const statement = query.split('\n').find(line => line.includes('gitDelivery = nextGitDeliveryPhase('))!
  assert.ok(statement)
  const transition = new Function('mainGoalThread', 'deliveryRequested', 'nextGitDeliveryPhase', `
    let gitDelivery = false;
    const toolUseBlocks = [{id:'stage',name:'Bash',input:{command:'git add file'}}];
    const toolResults = [{type:'user',message:{content:[{type:'tool_result',tool_use_id:'stage'}]}}];
    ${statement}
    return gitDelivery;`)
  assert.equal(transition(true, false, nextGitDeliveryPhase), false)
  assert.equal(transition(false, true, nextGitDeliveryPhase), false)
  assert.equal(transition(true, true, nextGitDeliveryPhase), true)
})

test('real local Git delivery retains commit hooks and reconciles the remote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'direct-git-'))
  try {
    const repo = join(dir, 'work'), remote = join(dir, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    execFileSync('git', ['init', '-q', repo])
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8',
      env: { ...process.env, ...unattendedGitEnvironment({}) }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim()
    git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
    git(['remote', 'add', 'origin', remote])
    writeFileSync(join(repo, 'file.txt'), 'verified candidate\n')
    const hook = join(repo, '.git/hooks/pre-commit')
    writeFileSync(hook, '#!/bin/sh\nprintf "checked\\n" >> hook-receipt\n'); chmodSync(hook, 0o700)
    let phase = false, n = 0
    for (const args of [['add', 'file.txt'], ['commit', '-m', 'verified'], ['push', 'origin', 'HEAD:refs/heads/candidate']]) {
      git(args)
      const id = `real-${n++}`
      phase = nextGitDeliveryPhase(phase, [call(id, 'git ' + args.join(' '))], [result(id)])
      assert.equal(phase, true)
    }
    assert.equal(readFileSync(join(repo, 'hook-receipt'), 'utf8'), 'checked\n')
    assert.equal(git(['rev-parse', 'HEAD']), git(['ls-remote', 'origin', 'refs/heads/candidate']).split(/\s+/)[0])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real Git authentication failure cannot invoke an askpass dialog in unattended mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unattended-git-auth-'))
  const marker = join(dir, 'askpass-invoked'), askpass = join(dir, 'askpass')
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }); response.end('fixture authentication required')
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address() as { port: number }
    writeFileSync(askpass, '#!/bin/sh\nprintf "invoked\\n" >> "' + marker + '"\nexit 1\n'); chmodSync(askpass, 0o700)
    const run = (overrides: Record<string, string>) => new Promise<number | null>((resolve, reject) => {
      const child = spawn('git', ['-c', 'credential.helper=', 'ls-remote', `http://127.0.0.1:${address.port}/repo`], {
        cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass, ...overrides },
      })
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Git authentication fixture timed out')) }, 5000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); resolve(code) })
    })
    assert.notEqual(await run({}), 0)
    assert.equal(existsSync(marker), true, 'the unchanged Git environment can invoke an interactive credential helper')
    rmSync(marker)
    assert.notEqual(await run(unattendedGitEnvironment({})), 0)
    assert.equal(existsSync(marker), false)
    assert.deepEqual(unattendedGitEnvironment({ FUTURE_CODE_INTERACTIVE_PROMPTS: '1' }), {})
    const shell = readFileSync(new URL('../../src/utils/Shell.ts', import.meta.url), 'utf8')
    assert.match(shell, /\.\.\.envOverrides,\s+\.\.\.unattendedGitEnvironment\(\)/)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }) }
})

test('default execution suppresses question/plan dialogs in every goal state and mode', () => unattended(() => {
  for (const goalState of [null, 'ACTIVE', 'PAUSED', 'REVIEW'] as const)
    for (const permissionMode of ['default', 'plan', 'bypassPermissions', 'dontAsk', 'auto'])
      for (const userQuestions of [undefined, false, true])
        assert.equal(validateQuestionAutonomy({ goalState, permissionMode, worker: false, userQuestions }).result, false)
  assert.equal(interactivePromptsEnabled({}), false)
  assert.equal(interactivePromptsEnabled({ FUTURE_CODE_INTERACTIVE_PROMPTS: '1' }), true)
}))

test('production permission boundary returns errors instead of dialog requests, never grants', async () => {
  const source = readFileSync(new URL('../../src/utils/permissions/permissions.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export const hasPermissionsToUseTool:')
  const end = source.indexOf('\nconst resolveToolPermissions:', start)
  assert.ok(start > 0 && end > start)
  const code = stripTypeScriptTypes(source.slice(start, end).replace('export const', 'const'), { mode: 'transform' })
  const boundary = (decision: any) => new Function('resolveToolPermissions', 'automaticPermissionDecision',
    code + '\nreturn hasPermissionsToUseTool;')(async () => decision, automaticPermissionDecision)
  const old = process.env.FUTURE_CODE_INTERACTIVE_PROMPTS
  delete process.env.FUTURE_CODE_INTERACTIVE_PROMPTS
  try {
    for (const reason of [{ type: 'rule', rule: { ruleBehavior: 'ask' } },
      { type: 'safetyCheck', classifierApprovable: false }, { type: 'mode', mode: 'default' }]) {
      const decision: any = { behavior: 'ask', message: 'original prerequisite', decisionReason: reason }
      const final = await boundary(decision)({ name: 'Bash' })
      assert.equal(final.behavior, 'deny')
      assert.equal(final.decisionReason, reason)
      assert.match(final.message, /original prerequisite/)
      assert.equal(decision.behavior, 'ask', 'the original policy receipt remains intact')
    }
    for (const behavior of ['deny', 'allow']) {
      const decision = { behavior }
      assert.equal(await boundary(decision)({ name: 'Write' }), decision)
    }
    process.env.FUTURE_CODE_INTERACTIVE_PROMPTS = '1'
    const ask = { behavior: 'ask' }
    assert.equal(await boundary(ask)({ name: 'AskUserQuestion' }), ask)
  } finally { if (old === undefined) delete process.env.FUTURE_CODE_INTERACTIVE_PROMPTS; else process.env.FUTURE_CODE_INTERACTIVE_PROMPTS = old }
})

test('forced hook decisions cannot open terminal, prompt-tool or SDK dialogs', async () => {
  const files = ['src/hooks/useCanUseTool.tsx', 'src/cli/print.ts', 'src/cli/structuredIO.ts']
  const old = process.env.FUTURE_CODE_INTERACTIVE_PROMPTS
  delete process.env.FUTURE_CODE_INTERACTIVE_PROMPTS
  try {
    for (const file of files) {
      const source = readFileSync(new URL('../../' + file, import.meta.url), 'utf8')
      const terminal = file.endsWith('.tsx')
      const start = source.indexOf(terminal ? '      const decisionPromise =' : 'const mainPermissionResult =')
      const end = source.indexOf(terminal ? '      return decisionPromise.then(' : '// If the tool is allowed or denied', start)
      assert.ok(start > 0 && end > start, file)
      const body = stripTypeScriptTypes(source.slice(start, end), { mode: 'transform' })
      const run = new Function('scope', `return (async () => {
        const {forceDecision, hasPermissionsToUseTool, automaticPermissionDecision} = scope;
        const tool = {name: 'Bash'}, input = {}, toolUseContext = {}, assistantMessage = {}, toolUseID = 'id', toolUseId = 'id';
        ${body}
        return ${terminal ? 'await decisionPromise' : 'mainPermissionResult'};
      })();`)
      for (const forced of [true, false]) {
        let checks = 0
        const final = await run({ forceDecision: forced ? { behavior: 'ask', message: 'hook prerequisite' } : undefined,
          hasPermissionsToUseTool: async () => { checks++; return { behavior: 'ask', message: 'policy prerequisite' } },
          automaticPermissionDecision })
        assert.equal(final.behavior, 'deny', file)
        assert.equal(checks, forced ? 0 : 1, 'permission checks are not duplicated')
      }
    }
  } finally { if (old === undefined) delete process.env.FUTURE_CODE_INTERACTIVE_PROMPTS; else process.env.FUTURE_CODE_INTERACTIVE_PROMPTS = old }
})

test('a default goal has no lifetime ceiling and resumes beyond arbitrary historical turn counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unbounded-goal-'))
  try {
    const state = enableAutoGoal('Continue until the independent objective is verified', dir)
    assert.equal(state.maxContinuations, null)
    const file = join(dir, '.future-code/goal-autonomy.json')
    writeFileSync(file, JSON.stringify({ ...state, continuations: 1_000_000, totalContinuations: 1_000_000 }))
    assert.ok(takeAutoGoalContinuation({ cwd: dir, mainThread: true, withinTurnBudget: true }))
    assert.equal(readAutoGoal(dir)?.state, 'ACTIVE')
    assert.equal(readAutoGoal(dir)?.totalContinuations, 1_000_001)
    assert.equal(readAutoGoal(dir)?.maxContinuations, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
