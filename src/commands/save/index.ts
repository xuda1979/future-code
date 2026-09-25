import type { Command } from '../../commands.js'

const save: Command = {
  type: 'prompt',
  name: 'save',
  description: 'Save a snapshot of the current session context to a named file. Usage: /save <name>',
  argumentHint: '<snapshot name>',
  progressMessage: 'Saving session snapshot',
  contentLength: 300,
  source: 'builtin',
  async getPromptForCommand(args: string) {
    const name = args.trim() || `snapshot-${Date.now()}`
    return [{ type: 'text' as const, text: `The user wants to save the current session context.

SNAPSHOT NAME: ${name}

INSTRUCTIONS:
1. Create a snapshot file at .future-code/snapshots/${name}.md (create the directory if needed).
2. The snapshot should include:
   - Date/time of the snapshot
   - Current goal (from .future-code/goal.md if it exists)
   - Summary of what has been accomplished so far in this session
   - Key files that were modified or created
   - Current state: what's in progress, what's blocked
   - Important context the assistant should know when resuming
3. Confirm to the user that the snapshot was saved and tell them they can resume with /load ${name}` }]
  },
}

export default save
