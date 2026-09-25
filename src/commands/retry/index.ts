import type { Command } from '../../commands.js'

const retry: Command = {
  type: 'prompt',
  name: 'retry',
  description: 'Retry the last action with a different approach. Usage: /retry [modified instructions]',
  argumentHint: '[optional modified instructions]',
  progressMessage: 'Retrying with a different approach',
  contentLength: 400,
  source: 'builtin',
  async getPromptForCommand(args: string) {
    const modification = args.trim()
    const modClause = modification
      ? `The user wants to modify the approach. Additional instructions: ${modification}`
      : `The user wants you to try a fundamentally different approach than what was tried before.`

    return [{ type: 'text' as const, text: `The user invoked /retry.

${modClause}

INSTRUCTIONS:
1. Review the last action you took and its result.
2. Identify why it may not have fully succeeded (error, incomplete output, wrong direction, etc.).
3. Choose a DIFFERENT strategy than the one that was just attempted. Do not repeat the same approach.
4. Execute the new strategy.
5. If this also fails, summarize both attempts and suggest what might be fundamentally wrong.` }]
  },
}

export default retry
