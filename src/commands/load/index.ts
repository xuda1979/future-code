import type { Command } from '../../commands.js'

const load: Command = {
  type: 'prompt',
  name: 'load',
  description: 'Load a previously saved session snapshot. Usage: /load <name>',
  argumentHint: '<snapshot name>',
  progressMessage: 'Loading session snapshot',
  contentLength: 300,
  source: 'builtin',
  getPromptForCommand(args: string) {
    const name = args.trim()
    if (!name) {
      return `The user invoked /load without a name.
1. Check the .future-code/snapshots/ directory for existing snapshots.
2. If snapshots exist, list them with their dates and a brief description.
3. If no snapshots exist, tell the user that no saved snapshots were found and suggest using /save <name> to create one.`
    }
    return `The user wants to load a previously saved session snapshot.

SNAPSHOT NAME: ${name}

INSTRUCTIONS:
1. Read the file at .future-code/snapshots/${name}.md
2. If the file does not exist, check .future-code/snapshots/ for available snapshots and list them.
3. If the file exists:
   - Read and internalize the snapshot contents
   - Summarize the restored context for the user
   - Resume work from where the snapshot left off
   - If there was an in-progress task, continue it
   - If there was a blocked task, remind the user of the blocker`
  },
}

export default load
