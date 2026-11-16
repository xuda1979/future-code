import { EXIT_PLAN_MODE_TOOL_NAME } from '../ExitPlanModeTool/constants.js'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

export const DESCRIPTION =
  'Asks for essential user-only information that cannot be obtained from the task, project context or available tools. Do not use for routine implementation decisions or renewed approval for authorized work.'

export const PREVIEW_FEATURE_PROMPT = {
  markdown: `
Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).
`,
  html: `
Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- HTML mockups of UI layouts or components
- Formatted code snippets showing different implementations
- Visual comparisons or diagrams

Preview content must be a self-contained HTML fragment (no <html>/<body> wrapper, no <script> or <style> tags — use inline style attributes instead). Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).
`,
} as const

export const ASK_USER_QUESTION_TOOL_PROMPT = `Use this tool only when progress requires essential information or a decision that belongs to the user and cannot be resolved from their instructions, project context or available tools. Investigate first and continue any independent authorized work.

Choose routine implementation details using your best judgment. Do not ask the user to say "go", "continue", or "both", select between compatible actions they already requested, or approve the same authorized step again. When multiple requested actions are compatible, do all of them in dependency order. An active automatic goal may redirect a question to further work or a specific external-blocker report; follow that guidance without inventing user answers or repeatedly opening the same question.

Execution is unattended by default: this tool redirects questions before opening a dialog in every goal state, including paused work and plan mode. Use available tools and context, choose routine approaches with evidence, and continue independent authorized work. If an essential external prerequisite remains inaccessible, report its exact error, diagnostics, recovery attempted and required external action through the current goal's blocker report; do not repeatedly retry the question. Dialogs require an explicit interactive-session setting as well as any active goal's trusted interaction preference. Existing authority remains limited to the current requested scope. This tool does not replace actual permission checks. Delegated workers return unresolved required input to their coordinator.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Interactive plan mode note: Only in an explicitly interactive session, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Use ${EXIT_PLAN_MODE_TOOL_NAME} for plan approval in that interactive workflow. Unattended execution makes its own routine decisions and preserves configured access restrictions.
`
