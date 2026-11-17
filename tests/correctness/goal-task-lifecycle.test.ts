import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { autoGoalReportPath, decideAutoGoalContinuation, enableAutoGoal, pauseAutoGoal,
  readAutoGoal, recordGoalSteering, resumeAutoGoalFromInput } from '../../src/commands/goal/auto.ts'

const moduleUrl = new URL('../../src/commands/goal/auto.ts', import.meta.url).href
function fixture(run: (cwd: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-task-lifecycle-'))
  try { run(cwd) } finally { rmSync(cwd, { recursive: true, force: true }) }
}
const next = (cwd: string) => decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true })
function restoredDecision(cwd: string): { kind: string; state: string } {
  const script = `const m=await import(process.argv[2]); const cwd=process.argv[1];
    const result=m.decideAutoGoalContinuation({cwd,mainThread:true,withinTurnBudget:true});
    console.log(JSON.stringify({kind:result.kind,state:m.readAutoGoal(cwd)?.state}));`
  return JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, cwd, moduleUrl],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }))
}
function atomicRestore(path: string, content: string) {
  writeFileSync(path + '.restore', content)
  renameSync(path + '.restore', path)
}
function renamedFixture(cwd: string) {
  const objective = 'Rename old.txt to new.txt'
  enableAutoGoal(objective, cwd)
  writeFileSync(join(cwd, 'old.txt'), 'preserved contents\n')
  renameSync(join(cwd, 'old.txt'), join(cwd, 'new.txt'))
  assert.equal(existsSync(join(cwd, 'old.txt')), false)
  assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'preserved contents\n')
  const report = `# ${objective}\nStatus: completed\n## Milestones\n- [x] Rename and independently check new.txt\n`
  writeFileSync(autoGoalReportPath(cwd), report)
  return { objective, report, path: autoGoalReportPath(cwd) }
}

test('new steering survives identical old completion restored across a real process restart', () => fixture(cwd => {
  const f = renamedFixture(cwd)
  recordGoalSteering('Also create README.md documenting the rename', cwd, { resetContinuationBudget: false })
  assert.equal(next(cwd).kind, 'CONTINUE')
  assert.equal(existsSync(join(cwd, 'README.md')), false, 'the added requested artifact is not implemented yet')
  atomicRestore(f.path, f.report)
  assert.deepEqual(restoredDecision(cwd), { kind: 'CONTINUE', state: 'ACTIVE' })
  assert.equal(readAutoGoal(cwd)?.activeSteering?.at(-1), 'Also create README.md documenting the rename')
  writeFileSync(join(cwd, 'README.md'), 'new.txt contains the renamed original contents.\n')
  assert.match(readFileSync(join(cwd, 'README.md'), 'utf8'), /new\.txt/)
  writeFileSync(f.path, f.report + '- [x] Create and independently inspect README.md documenting new.txt\n')
  assert.equal(next(cwd).kind, 'BLOCKED')
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW')
}))

test('a completed task durably reopens for an explicit actionable Also follow-up', () => fixture(cwd => {
  const f = renamedFixture(cwd)
  assert.equal(next(cwd).kind, 'BLOCKED')
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW')
  const reopened = resumeAutoGoalFromInput('Also create README.md documenting the rename', { cwd, mainThread: true, autoArm: true })
  assert.equal(reopened?.state, 'ACTIVE')
  assert.equal(reopened?.goal, f.objective, 'the finished root and its checked evidence remain intact')
  assert.equal(existsSync(join(cwd, 'README.md')), false)
  atomicRestore(f.path, f.report)
  assert.deepEqual(restoredDecision(cwd), { kind: 'CONTINUE', state: 'ACTIVE' })
  writeFileSync(join(cwd, 'README.md'), 'Documented new.txt.\n')
  assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), 'Documented new.txt.\n')
  writeFileSync(f.path, f.report + '- [x] Document new.txt in README.md\n')
  next(cwd)
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW')
}))

test('current in-progress status cannot borrow completion from a historical run', () => fixture(cwd => {
  const objective = 'Set the configured port to 9090'
  enableAutoGoal(objective, cwd)
  writeFileSync(join(cwd, 'config.json'), '{"port":8080}\n')
  assert.notEqual(JSON.parse(readFileSync(join(cwd, 'config.json'), 'utf8')).port, 9090)
  writeFileSync(autoGoalReportPath(cwd), `# ${objective}\nStatus: in_progress\n` +
    '## Worklog\nPrevious run:\nStatus: completed\nThe old run configured port 8080.\n')
  assert.deepEqual(restoredDecision(cwd), { kind: 'CONTINUE', state: 'ACTIVE' })
  writeFileSync(join(cwd, 'config.json'), '{"port":9090}\n')
  assert.equal(JSON.parse(readFileSync(join(cwd, 'config.json'), 'utf8')).port, 9090)
  writeFileSync(autoGoalReportPath(cwd), `# ${objective}\nStatus: completed\n` +
    '## Milestones\n- [x] Independently read the configured port as 9090\n' +
    '## Worklog\nPrevious run:\nStatus: in_progress\n')
  next(cwd)
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW')
}))

test('missing current status cannot borrow a historical completed declaration', () => fixture(cwd => {
  const objective = 'Set the configured port to 9090'
  enableAutoGoal(objective, cwd)
  writeFileSync(join(cwd, 'config.json'), '{"port":8080}\n')
  assert.notEqual(JSON.parse(readFileSync(join(cwd, 'config.json'), 'utf8')).port, 9090)
  writeFileSync(autoGoalReportPath(cwd), `# ${objective}\n## Worklog\nPrevious run:\nStatus: completed\n`)
  const decision = next(cwd)
  assert.equal(decision.kind, 'CONTINUE')
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE')
  assert.match(decision.kind === 'CONTINUE' ? decision.prompt : '', /one unambiguous current Status/)
}))

test('conflicting current statuses cannot retire an unfinished requested artifact', () => fixture(cwd => {
  const objective = 'Set the configured port to 9090'
  enableAutoGoal(objective, cwd)
  writeFileSync(join(cwd, 'config.json'), '{"port":8080}\n')
  assert.notEqual(JSON.parse(readFileSync(join(cwd, 'config.json'), 'utf8')).port, 9090)
  writeFileSync(autoGoalReportPath(cwd), `# ${objective}\nStatus: completed\nStatus: in_progress\n`)
  assert.deepEqual(restoredDecision(cwd), { kind: 'CONTINUE', state: 'ACTIVE' })
}))

test('an explicit pause/resume still accepts a fresh identical report after renewed checking', () => fixture(cwd => {
  const f = renamedFixture(cwd)
  pauseAutoGoal(cwd, 'Paused by operator instruction')
  resumeAutoGoalFromInput('continue', { cwd, mainThread: true })
  assert.equal(next(cwd).kind, 'CONTINUE')
  assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'preserved contents\n')
  atomicRestore(f.path, f.report)
  assert.deepEqual(restoredDecision(cwd), { kind: 'BLOCKED', state: 'REVIEW' })
}))

test('steering received during an operator pause stays pending through resume and report restore', () => fixture(cwd => {
  const f = renamedFixture(cwd)
  pauseAutoGoal(cwd, 'Paused by operator instruction')
  const before = readAutoGoal(cwd)!
  recordGoalSteering('Also create README.md documenting the rename', cwd, { resumePaused: false, resetContinuationBudget: false })
  assert.equal(readAutoGoal(cwd)?.state, 'PAUSED')
  assert.equal(readAutoGoal(cwd)?.reason, before.reason)
  assert.equal(readAutoGoal(cwd)?.ignoredGoalReport, before.ignoredGoalReport)
  resumeAutoGoalFromInput('continue', { cwd, mainThread: true })
  atomicRestore(f.path, f.report)
  assert.equal(existsSync(join(cwd, 'README.md')), false)
  assert.deepEqual(restoredDecision(cwd), { kind: 'CONTINUE', state: 'ACTIVE' })
}))

test('read-only follow-ups do not reactivate a reviewed goal or alter its authority', () => fixture(cwd => {
  renamedFixture(cwd)
  next(cwd)
  const before = readAutoGoal(cwd)
  for (const text of ['Also explain the rename', 'Why was the file renamed?', 'Also show me the status']) {
    assert.equal(resumeAutoGoalFromInput(text, { cwd, mainThread: true, autoArm: true }), null)
    assert.deepEqual(readAutoGoal(cwd), before)
  }
}))

test('a normal separator after current control metadata cannot force completed work to repeat', () => fixture(cwd => {
  const f = renamedFixture(cwd)
  assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'preserved contents\n')
  writeFileSync(f.path, `# ${f.objective}\nStatus: completed\n---\n## Milestones\n- [x] Rename and independently check new.txt\n`)
  assert.equal(next(cwd).kind, 'BLOCKED')
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW')
}))

test('changed reports with unfinished required work cannot retire an amended objective', () => fixture(cwd => {
  const f = renamedFixture(cwd)
  recordGoalSteering('Also create README.md documenting the rename', cwd)
  writeFileSync(f.path, f.report + '- [ ] Create README.md documenting the rename\n')
  assert.equal(existsSync(join(cwd, 'README.md')), false)
  assert.equal(next(cwd).kind, 'CONTINUE')
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE')
}))

test('replayed identical steering cannot invalidate a fresh completion that already addresses it', () => fixture(cwd => {
  const f = renamedFixture(cwd)
  const instruction = 'Also create README.md documenting the rename'
  recordGoalSteering(instruction, cwd)
  writeFileSync(join(cwd, 'README.md'), 'Documented new.txt.\n')
  assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), 'Documented new.txt.\n')
  writeFileSync(f.path, f.report + '- [x] Independently inspect README.md documenting new.txt\n')
  recordGoalSteering(instruction, cwd)
  assert.equal(next(cwd).kind, 'BLOCKED')
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW')
  assert.equal(readAutoGoal(cwd)?.ignoredCompletionContent, null, 'an accepted fresh completion clears the amendment guard')
}))

test('a fresh real blocker after added work is never suppressed by the stale-completion guard', () => fixture(cwd => {
  const f = renamedFixture(cwd)
  recordGoalSteering('Also validate the externally supplied dataset', cwd)
  assert.throws(() => readFileSync(join(cwd, 'external-input.csv')), { code: 'ENOENT' })
  writeFileSync(f.path, `# ${f.objective}\nStatus: blocked\n` +
    'Blocker: external-input.csv is absent (ENOENT)\nBlocker type: external_dependency\n' +
    'Recovery attempted: inspected the input directory and attempted to read the supplied file\n' +
    'External action required: mount the externally supplied dataset\n')
  assert.deepEqual(restoredDecision(cwd), { kind: 'BLOCKED', state: 'PAUSED' })
}))

test('the current real blocker stays authoritative over a historical completed status', () => fixture(cwd => {
  const objective = 'Validate the externally provided dataset'
  enableAutoGoal(objective, cwd)
  assert.throws(() => readFileSync(join(cwd, 'external-input.csv')), { code: 'ENOENT' })
  writeFileSync(autoGoalReportPath(cwd), `# ${objective}\nStatus: blocked\n` +
    'Blocker: external-input.csv is absent (ENOENT)\nBlocker type: external_dependency\n' +
    'Recovery attempted: checked the input directory and attempted to read the supplied external file\n' +
    'External action required: mount the externally supplied dataset\n' +
    '## Worklog\nPrevious run:\nStatus: completed\n')
  assert.equal(next(cwd).kind, 'BLOCKED')
  assert.equal(readAutoGoal(cwd)?.state, 'PAUSED')
}))

test('a standing loop survives a completed cycle and still respects an explicit pause', () => fixture(cwd => {
  const command = '/loop monitor fixture status'
  resumeAutoGoalFromInput(command, { cwd, mainThread: true, loopMode: 'builtin' })
  writeFileSync(join(cwd, 'cycle.json'), '{"observed":true}\n')
  assert.equal(JSON.parse(readFileSync(join(cwd, 'cycle.json'), 'utf8')).observed, true)
  writeFileSync(autoGoalReportPath(cwd), `# ${command}\nStatus: completed\n- [x] Observe fixture status for this cycle\n`)
  assert.equal(next(cwd).kind, 'CONTINUE')
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE')
  pauseAutoGoal(cwd, 'Paused by operator instruction')
  assert.equal(next(cwd).kind, 'SKIP')
}))

test('host-formatted multiline objectives keep their headings before the canonical status', () => fixture(cwd => {
  const objective = 'Set port to 9090 in config.json\n\n## Requirements\nPreserve enabled=true'
  enableAutoGoal(objective, cwd)
  const path = autoGoalReportPath(cwd)
  assert.equal(readFileSync(path, 'utf8'), `# ${objective}\nStatus: in_progress\n`)
  writeFileSync(join(cwd, 'config.json'), '{"port":8080,"enabled":true}\n')
  assert.notEqual(JSON.parse(readFileSync(join(cwd, 'config.json'), 'utf8')).port, 9090)
  writeFileSync(path, `# ${objective}\nStatus: in_progress\n## Worklog\nStatus: completed\n`)
  assert.equal(next(cwd).kind, 'CONTINUE', 'history cannot retire the unfinished multiline objective')
  writeFileSync(path, `# ${objective}\n## Worklog\nStatus: completed\n`)
  assert.equal(next(cwd).kind, 'CONTINUE', 'missing current status cannot borrow history after the full objective')
  writeFileSync(join(cwd, 'config.json'), '{"port":9090,"enabled":true}\n')
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'config.json'), 'utf8')), { port: 9090, enabled: true })
  writeFileSync(path, `# ${objective}\nStatus: completed\n## Milestones\n- [x] Independently verify port and enabled\n`)
  assert.equal(next(cwd).kind, 'BLOCKED')
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW', 'verified multiline work must not enter a status-repair loop')
}))
