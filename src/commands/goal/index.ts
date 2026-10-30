import type { Command } from '../../commands.js'
import { enableAutoGoal, pauseAutoGoal, resumeAutoGoal, readAutoGoal, MAX_AUTO_GOAL_CONTINUATIONS, AUTO_GOAL_BLOCKER_GUIDANCE } from './auto.ts'
import { DECISION_GUIDANCE } from '../../harness/decisionGuidance.ts'

const goal: Command = {
  type: 'prompt',
  name: 'goal',
  description: 'Work on a durable goal until review or a blocker. Use --pause, --resume, --status, or --limit N.',
  argumentHint: '[--auto] [--limit N] [goal description]',
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
      return [{ type: 'text' as const, text: state ? 'Autonomous goal resumed; its configured limit is preserved. Continue verified work on: ' + state.goal + '\n\n' + DECISION_GUIDANCE + '\n\n' + AUTO_GOAL_BLOCKER_GUIDANCE : 'No autonomous goal is configured.' }]
    }
    if (value) {
      let goal = value.startsWith('--auto ') ? value.slice('--auto '.length).trim() : value
      if (goal === '--auto' || goal === '--limit') throw new Error('Usage: /goal [--auto] [--limit N] <goal>')
      let limit: number | undefined
      if (goal.startsWith('--limit ')) {
        const match = /^--limit\s+(\d+)\s+([\s\S]+)$/.exec(goal)
        if (!match) throw new Error('Usage: /goal --auto --limit N <goal>')
        limit = Number(match[1])
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AUTO_GOAL_CONTINUATIONS)
          throw new Error('Autonomous limit must be between 1 and 100000')
        goal = match[2]!.trim()
      }
      const state = enableAutoGoal(goal, process.cwd(), limit)
      const budget = state.maxContinuations === null ? 'continues until verified completion, an external blocker, or an operator pause' : `up to ${state.maxContinuations} automatic continuation turns`
      return [{ type: 'text' as const, text: `Autonomous goal armed (${budget}). The host continues after completed model turns. Preserve caller budgets and permissions; operator review remains separate from model claims.\n\nGOAL: ${goal}\n\n${DECISION_GUIDANCE}\n\nWrite this goal, a checklist, and Status: in_progress to .future-code/goal.md now. Execute the highest-impact next step and preserve durable progress and evidence. After independent checks succeed, set Status: completed. ${AUTO_GOAL_BLOCKER_GUIDANCE} Completing the goal does NOT end the session; remain fully available for subsequent instructions.` }]
    }
    return [{ type: 'text' as const, text: `Read the current goal from .future-code/goal.md if it exists. If it exists, summarize the current goal and the progress made so far. If it does not exist, tell the user that no goal has been set yet and suggest they use /goal <description> to set one.` }]
  },
}

export default goal

