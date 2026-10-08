import type { Command } from '../../commands.js'
import { enableAutoGoal, pauseAutoGoal, resumeAutoGoal, readAutoGoal } from './auto.ts'

const goal: Command = {
  type: 'prompt',
  name: 'goal',
  description: 'Set, view, or update the current session goal. Usage: /goal [description]',
  argumentHint: '[goal description]',
  progressMessage: 'Setting session goal',
  contentLength: 200,
  source: 'builtin',
  async getPromptForCommand(args: string) {
    const value = args.trim()
    if (value === '--status') {
      const state = readAutoGoal()
      return [{ type: 'text' as const, text: state ? JSON.stringify(state, null, 2) : 'No autonomous goal is configured.' }]
    }
    if (value === '--pause') {
      const state = pauseAutoGoal()
      return [{ type: 'text' as const, text: state ? 'Autonomous goal paused.' : 'No autonomous goal is configured.' }]
    }
    if (value === '--resume') {
      const state = resumeAutoGoal()
      return [{ type: 'text' as const, text: state ? 'Autonomous goal resumed with a new bounded continuation batch.' : 'No autonomous goal is configured.' }]
    }
    if (value.startsWith('--auto ')) {
      const goal = value.slice('--auto '.length).trim()
      const state = enableAutoGoal(goal)
      return [{ type: 'text' as const, text: `Autonomous goal armed (up to ${state.maxContinuations} automatic continuation turns before pause). The host continues after completed model turns; operator review is required before declaring acceptance.\n\nGOAL: ${goal}\n\nWrite the goal and an explicit Status: in_progress to .future-code/goal.md now. Work on the highest-impact next step. After independent checks succeed, set Status: completed. Do not request permission for dangerous actions implicitly; honor approval boundaries.` }]
    }
    if (!args || !args.trim()) {
      return [{ type: 'text' as const, text: `Read the current goal from .future-code/goal.md if it exists. If it exists, summarize the current goal and the progress made so far. If it does not exist, tell the user that no goal has been set yet and suggest they use /goal <description> to set one.` }]
    }
    return [{ type: 'text' as const, text: `The user has set the following goal for this session:

GOAL: ${args.trim()}

1. Write this goal to .future-code/goal.md (create the directory if needed), including:
   - The goal statement
   - The date/time it was set
   - A checklist of sub-tasks that need to be completed to achieve this goal
   - Status: in_progress

2. Throughout the session, keep this goal in mind. Before taking any action, consider whether it advances the goal.

3. When the goal is achieved, update .future-code/goal.md to mark status as completed.

4. IMPORTANT: Completing the goal does NOT end the session. After marking a goal as completed, remain fully available for any further instructions, questions, or new tasks the user may have. A completed goal is a milestone, not a termination. Always respond to subsequent user messages normally and helpfully, regardless of whether the current goal is completed, in progress, or no goal is set.` }]
  },
}

export default goal
