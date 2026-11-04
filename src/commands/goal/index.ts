import type { Command } from '../../commands.js'
import {
  enableAutoGoal,
  pauseAutoGoal,
  resumeAutoGoal,
  readAutoGoal,
  recordGoalSteering,
  classifyGoalHorizon,
  MAX_AUTO_GOAL_CONTINUATIONS,
  AUTO_GOAL_BLOCKER_GUIDANCE,
  type GoalHorizon,
} from './auto.ts'
import { DECISION_GUIDANCE } from '../../harness/decisionGuidance.ts'

const goal: Command = {
  type: 'prompt',
  name: 'goal',
  description: 'Work on a durable goal until review or a blocker. Use --pause, --resume, --status, --steer, --horizon, or --limit N.',
  argumentHint: '[--auto] [--limit N] [--horizon short|long] [goal description]',
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
      const antiDrift = state?.previousGoal
        ? `\nSupersedes previous objective: ${state.previousGoal} (do not drift back to superseded work).`
        : ''
      const steering = state?.activeSteering?.length
        ? `\nActive constraints: ${state.activeSteering.join(' | ')}`
        : ''
      return [{ type: 'text' as const, text: state ? 'Autonomous goal resumed; its configured limit is preserved. Continue verified work on: ' + state.goal + antiDrift + steering + '\n\n' + DECISION_GUIDANCE + '\n\n' + AUTO_GOAL_BLOCKER_GUIDANCE : 'No autonomous goal is configured.' }]
    }
    if (value.startsWith('--steer ')) {
      const note = value.slice('--steer '.length).trim()
      if (!note) throw new Error('Usage: /goal --steer <constraint or guidance>')
      const state = recordGoalSteering(note)
      return [{
        type: 'text' as const,
        text: state
          ? `Recorded active steering constraint for goal "${state.goal}": ${note}\n\nPreserve this constraint in .future-code/goal.md and continue verified work.\n\n${DECISION_GUIDANCE}\n\n${AUTO_GOAL_BLOCKER_GUIDANCE}`
          : 'No autonomous goal is configured. Set a goal first with /goal <objective>.',
      }]
    }
    if (value) {
      let rest = value
      let limit: number | undefined
      let horizon: GoalHorizon | undefined
      while (rest.startsWith('--')) {
        if (rest === '--auto' || rest === '--limit' || rest === '--horizon') {
          throw new Error('Usage: /goal [--auto] [--limit N] [--horizon short|long] <goal>')
        }
        if (rest.startsWith('--auto ')) {
          rest = rest.slice('--auto '.length).trim()
          continue
        }
        if (rest.startsWith('--limit ')) {
          const match = /^--limit\s+(\d+)\s+([\s\S]+)$/.exec(rest)
          if (!match) throw new Error('Usage: /goal [--auto] --limit N <goal>')
          limit = Number(match[1])
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AUTO_GOAL_CONTINUATIONS)
            throw new Error('Autonomous limit must be between 1 and 100000')
          rest = match[2]!.trim()
          continue
        }
        if (rest.startsWith('--horizon ')) {
          const match = /^--horizon\s+(short|long|auto)\s+([\s\S]+)$/i.exec(rest)
          if (!match) throw new Error('Usage: /goal [--auto] --horizon short|long|auto <goal>')
          horizon = match[1]!.toLowerCase() as GoalHorizon
          rest = match[2]!.trim()
          continue
        }
        break
      }
      const goalText = rest.trim()
      if (!goalText) throw new Error('Usage: /goal [--auto] [--limit N] [--horizon short|long] <goal>')
      const state = enableAutoGoal(goalText, process.cwd(), limit ?? null, { horizon })
      const resolvedHorizon = classifyGoalHorizon(goalText, state.horizon)
      const budget = state.maxContinuations === null ? 'continues until verified completion, an external blocker, or an operator pause' : `up to ${state.maxContinuations} automatic continuation turns`
      const supersedeNotice = state.previousGoal
        ? `\nOBJECTIVE TRANSITION (Revision ${state.revision ?? 2}): This objective supersedes "${state.previousGoal}". Discard stale plans from the superseded objective and do not drift back to it.\n`
        : ''
      return [{ type: 'text' as const, text: `Autonomous goal armed (${budget}; horizon: ${resolvedHorizon}). The host continues after completed model turns. Preserve caller budgets and permissions; operator review remains separate from model claims.${supersedeNotice}\n\nGOAL: ${goalText}\n\n${DECISION_GUIDANCE}\n\nWrite this goal, a checklist, and Status: in_progress to .future-code/goal.md now. Execute the highest-impact next step and preserve durable progress and evidence. After independent checks succeed, set Status: completed. ${AUTO_GOAL_BLOCKER_GUIDANCE} Completing the goal does NOT end the session; remain fully available for subsequent instructions.` }]
    }
    return [{ type: 'text' as const, text: `Read the current goal from .future-code/goal.md if it exists. If it exists, summarize the current goal and the progress made so far. If it does not exist, tell the user that no goal has been set yet and suggest they use /goal <description> to set one.` }]
  },
}

export default goal
