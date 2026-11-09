import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Regression test for the TaskOutput timeout-hint fix.
 *
 * Observed in production (quantum-gpt session, 2026-11-08): the model made
 * 26 consecutive TaskOutput calls with timeout=600000 while a long
 * `sleep 2700`-style background experiment ran. Each call blocked the
 * entire session for 10 minutes (~10.9h cumulative, ~1.3M tokens spent on
 * no-op polls) even though task completion notifications exist that would
 * have woken the session automatically.
 *
 * The fix teaches the correct pattern at every decision point:
 *   1. inputSchema descriptions warn against long blocking
 *   2. the tool prompt says to end the turn and wait for <task-notification>
 *   3. a `timeout` retrieval_status result now carries an explicit <hint>
 *      telling the model NOT to re-block with a longer timeout
 *
 * This test pins the hint text and its placement so a refactor cannot
 * silently drop it.
 */
import { TaskOutputTool } from '../../src/tools/TaskOutputTool/TaskOutputTool.tsx'

test('TaskOutput timeout result carries an anti-reblock hint', async () => {
  const mapFn = (TaskOutputTool as unknown as {
    mapToolResultToToolResultBlockParam: (
      data: { retrieval_status: string; task: Record<string, unknown> | null },
      toolUseID: string,
    ) => { content: string }
  }).mapToolResultToToolResultBlockParam

  const timeoutResult = mapFn(
    {
      retrieval_status: 'timeout',
      task: {
        task_id: 'test-task',
        task_type: 'local_bash',
        status: 'running',
        description: 'sleep 2700; echo done',
        output: '',
      },
    },
    'toolu_123',
  )

  assert.ok(
    timeoutResult.content.includes('<hint>'),
    'timeout result must include a <hint> block',
  )
  assert.ok(
    /do not call taskoutput again/i.test(timeoutResult.content),
    'hint must tell the model not to re-block with TaskOutput',
  )
  assert.ok(
    /task-notification/i.test(timeoutResult.content),
    'hint must point to the automatic completion notification',
  )
  assert.ok(
    /end your turn/i.test(timeoutResult.content),
    'hint must tell the model to end its turn',
  )
})

test('TaskOutput success result carries no anti-reblock hint', async () => {
  const mapFn = (TaskOutputTool as unknown as {
    mapToolResultToToolResultBlockParam: (
      data: { retrieval_status: string; task: Record<string, unknown> | null },
      toolUseID: string,
    ) => { content: string }
  }).mapToolResultToToolResultBlockParam

  const successResult = mapFn(
    {
      retrieval_status: 'success',
      task: {
        task_id: 'test-task',
        task_type: 'local_bash',
        status: 'completed',
        description: 'echo done',
        output: 'done',
        exitCode: 0,
      },
    },
    'toolu_123',
  )

  assert.equal(
    successResult.content.includes('<hint>'),
    false,
    'success result must not carry the timeout hint',
  )
  assert.ok(successResult.content.includes('done'), 'success result must include the task output')
})

test('TaskOutput prompt and schema warn against long blocking waits', async () => {
  const prompt = await (
    TaskOutputTool as unknown as { prompt: () => Promise<string> }
  ).prompt()
  assert.ok(
    /do NOT re-block with a longer timeout/i.test(prompt),
    'prompt must warn against re-blocking',
  )
  assert.ok(
    /frozen/i.test(prompt),
    'prompt must explain that blocking freezes the session',
  )

  const schema = (
    TaskOutputTool as unknown as { inputSchema: { shape: Record<string, { description?: string }> } }
  ).inputSchema
  const blockDesc = schema.shape.block?.description ?? ''
  const timeoutDesc = schema.shape.timeout?.description ?? ''
  assert.ok(
    /frozen/i.test(blockDesc),
    'block param description must warn that the session freezes',
  )
  assert.ok(
    /end your turn/i.test(timeoutDesc),
    'timeout param description must point to ending the turn',
  )
})
