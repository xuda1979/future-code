import type { Command } from '../../commands.js'

const learn: Command = {
  type: 'prompt',
  name: 'learn',
  description: 'Learn from the codebase and save reusable knowledge. Usage: /learn [topic or file pattern]',
  argumentHint: '[topic or file pattern]',
  progressMessage: 'Learning from codebase',
  contentLength: 500,
  source: 'builtin',
  async getPromptForCommand(args: string) {
    const topic = args.trim()
    if (!topic) {
      return [{ type: 'text' as const, text: `The user invoked /learn without arguments.

INSTRUCTIONS:
1. Analyze the current project structure, key patterns, and conventions.
2. Identify the most important things to know about this codebase:
   - Architecture and module organization
   - Key abstractions and interfaces
   - Testing conventions
   - Build and deployment setup
   - Coding conventions (naming, error handling, etc.)
3. Save a summary to .future-code/learned.md
4. Present the key findings to the user.` }]
    }

    return [{ type: 'text' as const, text: `The user wants to learn about: ${topic}

INSTRUCTIONS:
1. Search the codebase for information related to "${topic}".
   - Use grep/ripgrep to find relevant files
   - Read key files that contain "${topic}"
   - Look at tests, types, and documentation
2. Synthesize what you learn into a clear, structured summary:
   - What "${topic}" means in this codebase
   - How it works (key files, functions, data flows)
   - Common patterns and conventions
   - Gotchas and edge cases
3. Save the summary to .future-code/learned.md (append if the file exists).
4. Present the summary to the user, highlighting the most important points.` }]
  },
}

export default learn
