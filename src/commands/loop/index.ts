import type { Command } from '../../commands.js'

const loop: Command = {
  type: 'prompt',
  name: 'loop',
  description: 'Run a task in a loop until a stop condition is met. Usage: /loop <prompt> [stop: <condition>]',
  argumentHint: '<prompt> [stop: <condition>]',
  progressMessage: 'Running loop iteration',
  contentLength: 600,
  source: 'builtin',
  getPromptForCommand(args: string) {
    const input = args.trim()
    if (!input) {
      return `The user invoked /loop without arguments. Explain the /loop command:

/loop <prompt> - Repeatedly execute the given prompt, refining the approach each iteration.
/loop <prompt> stop: <condition> - Loop until the stop condition is met.

Example: /loop fix failing tests stop: all tests pass
Example: /loop improve performance stop: benchmark shows >20% improvement

Explain that each iteration should:
1. Check if the stop condition is met
2. If not, take the most impactful next step
3. Summarize what was done this iteration
4. Continue to the next iteration`
    }

    // Parse optional stop condition
    let prompt = input
    let stopCondition = ''
    const stopMatch = input.match(/\bstop:\s*(.+)$/i)
    if (stopMatch) {
      stopCondition = stopMatch[1].trim()
      prompt = input.substring(0, stopMatch.index).trim()
    }

    const stopClause = stopCondition
      ? `STOP CONDITION: ${stopCondition}
Before each iteration, check if the stop condition has been met. If yes, stop looping and report the final outcome.`
      : `No explicit stop condition was provided. Run up to 5 iterations, then ask the user whether to continue.`

    return `The user wants to run a task in a loop.

TASK: ${prompt}

${stopClause}

LOOP PROTOCOL:
1. Check the stop condition. If met, stop and report the final outcome.
2. Assess current state — what has been done, what remains.
3. Identify the single most impactful action to advance the task.
4. Execute that action (write code, run tests, fix issues, etc.).
5. Summarize: what changed this iteration, what's the new state.
6. Go to step 1.

Each iteration should make concrete progress. Do not repeat the same action if it failed — try a different approach.

When the loop finishes (stop condition met or max iterations reached), report the outcome clearly. After the loop completes, remain fully available for any further instructions from the user — the loop ending does NOT end the session.

Begin iteration 1 now.`
  },
}

export default loop
