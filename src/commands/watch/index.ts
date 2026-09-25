import type { Command } from '../../commands.js'

const watch: Command = {
  type: 'prompt',
  name: 'watch',
  description: 'Watch files for changes and describe what to do when they change. Usage: /watch <glob> <action>',
  argumentHint: '<file glob> <action on change>',
  progressMessage: 'Setting up file watcher',
  contentLength: 500,
  source: 'builtin',
  async getPromptForCommand(args: string) {
    const input = args.trim()
    if (!input) {
      return [{ type: 'text' as const, text: `The user invoked /watch without arguments. Explain:

/watch <glob> <action> - Watch files matching the glob pattern and perform an action when they change.

Examples:
  /watch src/**/*.ts run tests for changed file
  /watch *.md reformat markdown files
  /watch src/**/*.ts check types with tsc --noEmit

The watcher will:
1. Identify files matching the glob pattern
2. When any matching file changes, execute the specified action
3. Report what changed and the result of the action` }]
    }

    // Parse: first token(s) = glob, rest = action
    // Support both space-separated and quoted globs
    const parts = input.match(/^(\S+)\s+(.+)$/)
    if (!parts) {
      return [{ type: 'text' as const, text: `Could not parse /watch arguments. Usage: /watch <glob> <action>

Example: /watch src/**/*.ts run tests` }]
    }

    const glob = parts[1]
    const action = parts[2]

    return [{ type: 'text' as const, text: `The user wants to watch files for changes.

WATCH GLOB: ${glob}
ACTION ON CHANGE: ${action}

INSTRUCTIONS:
1. Use the Bash tool to find files matching the glob: ${glob}
2. List the files currently being watched.
3. For each file that changes:
   a. Detect what changed (diff the file)
   b. Execute the action: ${action}
   c. Report the result
4. To implement continuous watching, use: while true; do fswatch -1 ${glob} 2>/dev/null || inotifywait -e modify ${glob} 2>/dev/null || sleep 2; <action>; done
   Or use a simple polling approach with sleep.
5. Start watching now. Use Ctrl+C to stop.` }]
  },
}

export default watch
