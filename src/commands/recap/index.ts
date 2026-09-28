import type { Command } from '../../commands.js'

const recap: Command = {
  type: 'prompt',
  name: 'recap',
  description: 'Generate a one-line session recap now',
  contentLength: 300,
  progressMessage: 'Generating session recap',
  source: 'builtin',
  getPromptForCommand() {
    return [{
      type: 'text',
      text: `Generate a recap of this session so far. Rules:

1. The FIRST line must be a single-sentence summary of what has been accomplished in this session (under 150 characters). Do not add a heading or a prefix.

2. If more than one meaningful thing happened, you may add up to three additional bullet lines, each under 100 characters, one per accomplishment. Keep them optional — skip them if the session was small.

3. No preamble, no closing remarks, no offers of further help. Just the recap.`,
    }]
  },
}

export default recap
