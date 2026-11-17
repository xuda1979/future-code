import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { autoGoalReportPath, decideAutoGoalContinuation, enableAutoGoal, parseMilestoneLedger,
  readAutoGoal } from '../../src/commands/goal/auto.ts'

function fixture(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-milestone-scope-'))
  try { run(cwd) } finally { rmSync(cwd, { recursive: true, force: true }) }
}

test('a verified small edit cannot expand into optional future work after requested milestones finish', () => fixture(cwd => {
  const objective = 'Rename old.txt to new.txt'
  enableAutoGoal(objective, cwd)
  writeFileSync(join(cwd, 'old.txt'), 'preserve this exact content\n')
  renameSync(join(cwd, 'old.txt'), join(cwd, 'new.txt'))
  // Independent artifact check, not the report's completion claim.
  assert.equal(existsSync(join(cwd, 'old.txt')), false)
  assert.equal(readFileSync(join(cwd, 'new.txt'), 'utf8'), 'preserve this exact content\n')
  writeFileSync(autoGoalReportPath(cwd), `# ${objective}\nStatus: completed\n` +
    '## Milestones\n- [x] Rename old.txt to new.txt\n\n' +
    '## Optional future improvements\n- [ ] Benchmark all project subsystems and redesign the framework\n')
  const decision = decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true,
    assistantText: 'Renamed and verified the requested file.', toolActivity: true })
  assert.equal(decision.kind, 'BLOCKED')
  assert.equal(readAutoGoal(cwd)?.state, 'REVIEW', 'the existing review boundary remains required')
  assert.equal(readAutoGoal(cwd)?.totalContinuations, 0)
  assert.equal(existsSync(join(cwd, 'unrequested-benchmark.json')), false)
}))

test('only explicitly nonrequired sections outside an authoritative ledger are excluded', () => {
  const report = '# Requested edit\n' +
    '- [ ] Legacy requested task\n' +
    '## Optional future improvements\n- [ ] Optional benchmark\n' +
    '### More ideas\n- [ ] Nested optional idea\n' +
    '## Unknown project heading\n- [ ] Requested work under an unknown heading\n' +
    '## Next steps\n- [ ] Requested next step\n' +
    '## Future scheduler\n- [ ] Implement the requested future scheduler\n' +
    '## Out of scope\n- [ ] Excluded migration\n' +
    '## Non-goals\n- [ ] Excluded rewrite\n' +
    '## Backlog\n- [ ] Requested sprint backlog item\n' +
    '## Optional backlog\n- [ ] Deferred suggestion\n'
  assert.deepEqual(parseMilestoneLedger(report).map(item => item.text), [
    'Legacy requested task', 'Requested work under an unknown heading', 'Requested next step',
    'Implement the requested future scheduler', 'Requested sprint backlog item',
  ])
})

test('required ledger ancestry outranks optional-looking nested headings and vice versa', () => {
  const report = '# Requested work\n## Milestones\n- [x] First required action\n' +
    '### Optional future improvements\n- [ ] Still required inside the milestone ledger\n' +
    '#### Non-goals\n- [ ] Still inside the required ledger\n' +
    '## Optional future improvements\n- [ ] Outside the required ledger\n' +
    '### Acceptance criteria\n- [ ] Explicit acceptance remains required\n' +
    '## Unknown heading\n- [ ] Required sibling scope is restored\n'
  assert.deepEqual(parseMilestoneLedger(report).map(item => item.text), [
    'First required action', 'Still required inside the milestone ledger', 'Still inside the required ledger',
    'Explicit acceptance remains required', 'Required sibling scope is restored',
  ])
})

test('excluded notes cannot mask or reopen a required duplicate milestone', () => {
  assert.deepEqual(parseMilestoneLedger('# Work\n## Optional future improvements\n- [x] Verify requested change\n' +
    '## Acceptance\n- [ ] Verify requested change\n').map(item => [item.text, item.done]), [['Verify requested change', false]])
  assert.deepEqual(parseMilestoneLedger('# Work\n## Milestones\n- [x] Verify requested change\n' +
    '## Optional future improvements\n- [ ] Verify requested change\n').map(item => [item.text, item.done]), [['Verify requested change', true]])
})

test('Chinese required and explicitly optional section names have the same structural meaning', () => {
  const report = '# 修改配置\n## 验收条件\n- [x] 配置已写入\n' +
    '### 可选改进\n- [ ] 用户要求的兼容性验证仍然必须执行\n' +
    '## 可选后续改进\n- [ ] 额外建设性能实验台\n' +
    '## 非目标\n- [ ] 无关的架构重写\n' +
    '## 后续工作\n- [ ] 仍属本次请求的下一步\n'
  assert.deepEqual(parseMilestoneLedger(report).map(item => item.text), [
    '配置已写入', '用户要求的兼容性验证仍然必须执行', '仍属本次请求的下一步',
  ])
})

test('numbered explicit ledgers retain required ancestry', () => {
  const report = '# Requested work\n## 1. Milestones\n### Optional future improvements\n- [ ] Required English descendant\n' +
    '## 二、验收条件\n### 可选改进\n- [ ] 必需的中文验收项\n' +
    '## 3. Optional future improvements\n- [ ] Deferred optional note\n'
  assert.deepEqual(parseMilestoneLedger(report).map(item => item.text), ['Required English descendant', '必需的中文验收项'])
  for (const heading of ['（一）验收条件', '(1) Milestones', '1、验收条件', '1.1 Milestones', 'IV. Acceptance']) {
    assert.deepEqual(parseMilestoneLedger('# Requested work\n## ' + heading +
      '\n### Optional future improvements\n- [ ] Required descendant\n').map(item => item.text), ['Required descendant'], heading)
  }
})

test('an empty sibling heading ends optional section scope conservatively', () => {
  for (const heading of ['##', '## ', '##\t']) {
    assert.deepEqual(parseMilestoneLedger('# Requested work\n## Optional future improvements\n- [ ] Deferred idea\n' +
      heading + '\n- [ ] Required work under an unknown section\n').map(item => item.text), ['Required work under an unknown section'])
  }
})

test('an explicit root objective named Backlog or Optional future improvements remains required', () => fixture(cwd => {
  for (const objective of ['Backlog', 'Optional future improvements', '可选改进']) {
    enableAutoGoal(objective, cwd)
    writeFileSync(autoGoalReportPath(cwd), `# ${objective}\nStatus: completed\n- [ ] User-requested work remains unfinished\n`)
    assert.equal(decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true }).kind, 'CONTINUE')
    assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE')
  }
}))

test('the first ATX H1 remains the objective title even after earlier summary sections', () => fixture(cwd => {
  const objective = 'Optional future improvements'
  for (const prefix of ['## Summary\nA summary before the objective.\n', 'Summary\n=======\nA summary before the objective.\n']) {
    enableAutoGoal(objective, cwd)
    writeFileSync(autoGoalReportPath(cwd), prefix + `# ${objective}\nStatus: completed\n- [ ] User-requested work remains unfinished\n`)
    assert.equal(decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true }).kind, 'CONTINUE')
    assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE')
  }
}))

test('bare backlog headings cannot hide explicitly requested sprint work', () => fixture(cwd => {
  const objective = 'Complete the sprint backlog'
  enableAutoGoal(objective, cwd)
  writeFileSync(autoGoalReportPath(cwd), `# ${objective}\nStatus: completed\n` +
    '## Backlog\n- [ ] Requested sprint implementation\n' +
    '## 待办池\n- [ ] 本次请求的验收项\n')
  assert.equal(decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true }).kind, 'CONTINUE')
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE')
}))

test('fenced, quoted and indented heading examples cannot change required section scope', () => {
  const report = '# Requested work\n````md\n## Optional future improvements\n- [ ] Fenced example\n````\n' +
    '> ## Optional future improvements\n> - [ ] Quoted example\n' +
    '    ## Optional future improvements\n- [ ] Actual requested task\n' +
    '## Acceptance\n```md\n## Optional future improvements\n```\n- [ ] Actual acceptance check\n'
  assert.deepEqual(parseMilestoneLedger(report).map(item => item.text), [
    'Actual requested task', 'Actual acceptance check',
  ])
})

test('setext sections and heading-level scope expiry follow the same rules', () => {
  const report = '# Requested work\nOptional future improvements\n----------------------------\n- [ ] Deferred idea\n' +
    'Acceptance criteria\n-------------------\n- [ ] Required acceptance\n' +
    '### Optional future improvements\n- [ ] Required descendant\n' +
    '## Optional backlog\n- [ ] Deferred follow-up\n' +
    '## Unknown task heading\n- [ ] Required sibling\n---\n'
  assert.deepEqual(parseMilestoneLedger(report).map(item => item.text), [
    'Required acceptance', 'Required descendant', 'Required sibling',
  ])
})

test('removed examples cannot stitch separate lines into a false optional Setext heading', () => {
  for (const example of ['> Quoted text interrupts the paragraph.\n', '```md\nexample\n```\n', '"Quoted text"\n']) {
    const report = '# Requested work\nOptional future improvements\n' + example + '---\n- [ ] Actual requested task\n'
    assert.deepEqual(parseMilestoneLedger(report).map(item => item.text), ['Actual requested task'])
  }
})

test('unfinished explicitly requested long-project milestones still prevent completion', () => fixture(cwd => {
  const objective = 'Build the training pipeline, run the long benchmark and independently validate the result'
  enableAutoGoal(objective, cwd, null, { horizon: 'long' })
  writeFileSync(autoGoalReportPath(cwd), `# ${objective}\nStatus: completed\n` +
    '## Required milestones\n- [x] Build the training pipeline\n' +
    '### Optional future improvements\n- [ ] Run the requested long benchmark\n' +
    '## Acceptance criteria\n- [ ] Independently validate the result\n')
  const decision = decideAutoGoalContinuation({ cwd, mainThread: true, withinTurnBudget: true })
  assert.equal(decision.kind, 'CONTINUE')
  assert.equal(readAutoGoal(cwd)?.state, 'ACTIVE')
  assert.match(decision.kind === 'CONTINUE' ? decision.prompt : '', /Run the requested long benchmark/)
}))
