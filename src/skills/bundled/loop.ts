import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isKairosCronEnabled,
} from '../../tools/ScheduleCronTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { parseLoopTask, type ParsedLoopTask } from '../../commands/loop/task.ts'
import { AUTONOMOUS_DECISION_GUIDANCE } from '../../harness/autonomyPolicy.ts'

const DEFAULT_INTERVAL = '10m'

const USAGE_MESSAGE = `Usage: /loop [interval] <prompt>

Run a prompt or slash command on a recurring interval.

Intervals: Ns, Nm, Nh, Nd (e.g. 5m, 30m, 2h, 1d). Minimum granularity is 1 minute.
If no interval is specified, defaults to ${DEFAULT_INTERVAL}.

Examples:
  /loop 5m /babysit-prs
  /loop 30m check the deploy
  /loop 1h /standup 1
  /loop check the deploy          (defaults to ${DEFAULT_INTERVAL})
  /loop check the deploy every 20m`

function buildPrompt(parsed: ParsedLoopTask): string {
  const interval = parsed.interval ?? DEFAULT_INTERVAL
  const scheduledPrompt = parsed.stopCondition
    ? `${parsed.task}\n\nLoop stop condition: ${parsed.stopCondition}\nCheck this condition with current evidence before each execution. Once it is verified, stop this loop and cancel only its actual recorded job ID. Respect operator pauses, explicit budgets and native schedule expiry.`
    : parsed.task
  return `# /loop — schedule a recurring prompt

The host parsed the requested cadence and work below. Schedule it with ${CRON_CREATE_TOOL_NAME}; do not ask for a routine go/continue decision.

REQUESTED WORK AND CONSTRAINTS: ${JSON.stringify(parsed.goalText)}
INTERVAL: ${JSON.stringify(interval)}
PROMPT TO SCHEDULE: ${JSON.stringify(scheduledPrompt)}
${parsed.stopCondition ? `USER STOP CONDITION: ${JSON.stringify(parsed.stopCondition)}. Check it before initial scheduling; if already verified, report the evidence without creating a redundant job.` : ''}

## Interval → cron

Supported suffixes: \`s\` (seconds, rounded up to nearest minute, min 1), \`m\` (minutes), \`h\` (hours), \`d\` (days). Convert:

| Interval pattern      | Cron expression     | Notes                                    |
|-----------------------|---------------------|------------------------------------------|
| \`Nm\` where N ≤ 59   | \`*/N * * * *\`     | every N minutes                          |
| \`Nm\` where N ≥ 60   | \`0 */H * * *\`     | round to hours (H = N/60, must divide 24)|
| \`Nh\` where N ≤ 23   | \`0 */N * * *\`     | every N hours                            |
| \`Nd\`                | \`0 0 */N * *\`     | every N days at midnight local           |
| \`Ns\`                | treat as \`ceil(N/60)m\` | cron minimum granularity is 1 minute  |

**If the interval doesn't cleanly divide its unit** (e.g. \`7m\` → \`*/7 * * * *\` gives uneven gaps at :56→:00; \`90m\` → 1.5h which cron can't express), pick the nearest clean interval and tell the user what you rounded to before scheduling.

## Action

1. Call ${CRON_CREATE_TOOL_NAME} with:
   - \`cron\`: the expression from the table above
   - \`prompt\`: PROMPT TO SCHEDULE above, verbatim (the requested slash command and arguments are preserved)
   - \`recurring\`: \`true\`
2. Briefly confirm: what's scheduled, the cron expression, the human-readable cadence, that recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days, and that they can cancel sooner with ${CRON_DELETE_TOOL_NAME} (include the job ID).
3. **Then immediately execute the parsed prompt now** — don't wait for the first cron fire. If it's a slash command, invoke it via the Skill tool; otherwise act on it directly.

${AUTONOMOUS_DECISION_GUIDANCE}

This is a scheduled loop, not a continuous foreground iteration loop. After schedule creation and the immediate useful execution, return control so native cron can drive later executions at the requested cadence. Each tick performs its authorized work and returns; do not busy-poll or recursively schedule duplicate jobs. A completed tick is not permission to expand the task. Keep actual caller budgets, permission denials and operator stops. Recurring tasks expire after ${DEFAULT_MAX_AGE_DAYS} days; do not reset or silently renew that boundary. If the stop condition is verified, reconcile the schedule and cancel only this loop's actual job ID with ${CRON_DELETE_TOOL_NAME}. Never infer that all requested work is complete merely because one subtask finished.

If a required scheduler or external dependency is unavailable, report the exact failure, recovery attempted and required external action, and continue independent authorized work. Do not fabricate a scheduled job, a user answer, permission or an experiment result.

## Input

${parsed.goalText}`
}

export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    description:
      'Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to 10m)',
    whenToUse:
      'When the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval (e.g. "check the deploy every 5 minutes", "keep running /babysit-prs"). Do NOT invoke for one-off tasks.',
    argumentHint: '[interval] <prompt>',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args) {
      // Shared prompt expansion is also used by model Skill and workers.
      // Parsing has no side effects; only trusted user dispatch may bind a goal.
      const parsed = parseLoopTask(args)
      if (!parsed) {
        return [{ type: 'text', text: USAGE_MESSAGE }]
      }
      return [{ type: 'text', text: buildPrompt(parsed) }]
    },
  })
}
