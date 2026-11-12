/** Deterministic host-control reproduction, with no model call or remote write.
 * Pass another checkout path to evaluate the same cases against that source. */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const goal = await import(pathToFileURL(join(root, 'src/commands/goal/auto.ts')).href)
let sessions
try { sessions = await import(pathToFileURL(join(root, 'src/utils/autoGoalSession.ts')).href) }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error }
const results = []
function check(id, run) {
  const cwd = mkdtempSync(join(tmpdir(), 'reproduce-handoff-'))
  try {
    const actual = run(cwd)
    results.push({ id, expected: 'CONTINUE', actual, verdict: actual === 'CONTINUE' ? 'PASS' : 'FAIL' })
  } finally { rmSync(cwd, { recursive: true, force: true }) }
}
const decide = cwd => goal.decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true }).kind
check('authorized-push-arms-execution', cwd => {
  goal.resumeAutoGoalFromInput('Push the authorized commit to origin/main', { cwd, mainThread: true })
  return decide(cwd)
})
check('open-standing-work-survives-subtask-completion', cwd => {
  const text = 'Push verified changes and maintain standing sync cycles'
  goal.enableAutoGoal(text, cwd)
  writeFileSync(join(cwd, '.future-code/goal.md'), '# ' + text + '\nStatus: completed\n' +
    '- [x] Rebase and verify\n- [ ] Push the authorized commit\n- [ ] Continue standing sync cycles\n')
  return decide(cwd)
})
check('say-go-is-not-an-external-blocker', cwd => {
  const text = 'Complete both requested steps'
  goal.enableAutoGoal(text, cwd)
  writeFileSync(join(cwd, '.future-code/goal.md'), '# ' + text + '\nStatus: blocked\n' +
    'Blocker: Waiting for a routine user decision\nBlocker type: permissions\n' +
    'Recovery attempted: Checked the standing instruction\nExternal action required: Say "go" for both, or pick either one.\n')
  return decide(cwd)
})
check('typed-monitoring-loop-supersedes-stale-review', cwd => {
  goal.enableAutoGoal('test arg', cwd)
  writeFileSync(join(cwd, '.future-code/goal.md'), '# test arg\nStatus: completed\n')
  decide(cwd)
  goal.resumeAutoGoalFromInput('/loop continue: monitor quantum-gpt and all future-code sessions; improve, test, build, commit, push and resume',
    { cwd, mainThread: true, loopMode: 'builtin' })
  return decide(cwd)
})
check('one-completed-cycle-cannot-retire-standing-loop', cwd => {
  const text = '/loop monitor experiments and improve the runtime'
  goal.enableAutoGoal(text, cwd, null, { loop: { kind: 'continuous' } })
  writeFileSync(join(cwd, '.future-code/goal.md'), '# ' + text + '\nStatus: completed\n- [x] Verified this cycle\n')
  return decide(cwd)
})
check('another-session-test-review-cannot-hijack-monitoring', cwd => {
  let active = 'monitor-session'
  sessions?.configureAutoGoalSession(() => active)
  try {
    const text = 'Monitor quantum-gpt and all running sessions'
    goal.enableAutoGoal(text, cwd)
    active = 'test-session'
    goal.enableAutoGoal('test arg', cwd)
    const path = goal.autoGoalReportPath?.(cwd) ?? join(cwd, '.future-code/goal.md')
    writeFileSync(path, '# test arg\nStatus: completed\n')
    decide(cwd)
    active = 'monitor-session'
    if (goal.readAutoGoal(cwd)?.goal !== text) return 'FOREIGN_ROOT'
    return decide(cwd)
  } finally { sessions?.configureAutoGoalSession(undefined) }
})
const source = {}
for (const path of ['src/commands/goal/auto.ts', 'src/harness/decisionGuidance.ts', 'src/harness/autonomyPolicy.ts',
  'src/utils/autoGoalSession.ts', 'src/commands/loop/task.ts']) {
  try { source[path] = createHash('sha256').update(readFileSync(join(root, path))).digest('hex') }
  catch (error) { if (error.code !== 'ENOENT') throw error; source[path] = null }
}
console.log(JSON.stringify({ schema: 1, kind: 'deterministic-host-control', liveModel: false,
  source, results, verdict: results.every(result => result.verdict === 'PASS') ? 'PASS' : 'FAIL' }, null, 2))
process.exitCode = results.every(result => result.verdict === 'PASS') ? 0 : 1
