import type { Command } from '../../commands.js'
import { AUTO_GOAL_BLOCKER_GUIDANCE } from '../goal/auto.ts'
import { AUTONOMOUS_DECISION_GUIDANCE } from '../../harness/autonomyPolicy.ts'
import { parseLoopTask } from './task.ts'

const loop: Command = {
  type: 'prompt',
  name: 'loop',
  description: 'Run a task in a loop until a stop condition is met. Usage: /loop <prompt> [stop: <condition>]',
  argumentHint: '<prompt> [stop: <condition>]',
  progressMessage: 'Running loop iteration',
  contentLength: 3000,
  source: 'builtin',
  async getPromptForCommand(args: string) {
    // This getter also serves model-invoked Skill and worker paths. It must
    // remain side-effect free; the trusted human dispatch binds host authority.
    const parsed = parseLoopTask(args)
    if (!parsed) {
      return [{ type: 'text' as const, text: `The /loop command needs a nonempty task and valid optional cadence/stop arguments. Explain the /loop command:

/loop <prompt> - Repeatedly execute the given prompt, refining the approach each iteration.
/loop <prompt> stop: <condition> - Loop until the stop condition is met.
Without an explicit stop condition, continue the authorized loop until an operator pause, a real external blocker, or an explicit budget boundary. An iteration ending is not loop completion.

Example: /loop fix failing tests stop: all tests pass
Example: /loop improve performance stop: benchmark shows >20% improvement

Explain that each iteration should:
1. Check if the stop condition is met
2. If not, take the most impactful next step
3. Summarize what was done this iteration
4. Continue to the next iteration` }]
    }

    const stopClause = parsed.stopCondition
      ? `STOP CONDITION: ${parsed.stopCondition}
Before each iteration, check this exact condition using current evidence. Stop only once it is met, the operator pauses, a real external dependency blocks further work, or an explicit budget boundary is reached. Do not replace the user's condition with completion of one subtask.`
      : `CONTINUOUS LOOP: No explicit stop condition was provided. Continue the authorized work until an operator pause, a real external blocker, or an explicit budget boundary. Completing one monitoring, test, build, commit or restart cycle does not complete the loop. Do not mark the whole goal completed after one cycle.`

    return [{ type: 'text' as const, text: `The user wants to run a task in a loop.

REQUESTED WORK AND CONSTRAINTS: ${parsed.goalText}
TASK: ${parsed.task}
${parsed.interval ? `REQUESTED CADENCE: ${parsed.interval}. Honor the cadence with available waiting or observation tools; do not replace it with a tight polling loop.` : ''}

${stopClause}

LOOP PROTOCOL:
1. Check the stop condition. If met, stop and report the final outcome.
2. Assess current state — what has been done, what remains.
3. Identify the single most impactful action to advance the task.
4. Execute authorized actions in dependency order (for example: inspect experiment, fix relevant error, test, build, commit, push, restart). Preserve each actual permission boundary and do not expand the requested scope.
5. Record substantive changes and evidence compactly. Healthy running jobs and unchanged state alone are not failures; use bounded waits and do not repeat expensive checks without changed inputs.
6. Go to step 1.

${AUTONOMOUS_DECISION_GUIDANCE}
${AUTO_GOAL_BLOCKER_GUIDANCE}

Diagnose an observed failure before retrying; reconcile existing external jobs before replacement and do not repeat an unchanged failed action without new evidence. Never add an arbitrary iteration ceiling or request a routine go/continue decision. Honor actual user stop conditions, native scheduling expiry, caller budgets and permission denials; do not reset limits or renew expired schedules without authority.

When a real stop boundary is reached, report its evidence and the current state clearly. The loop ending does NOT end the session; remain fully available for further user instructions.

Begin iteration 1 now.` }]
  },
}

export default loop
