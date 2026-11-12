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

During active automatic execution, this tool redirects questions before opening a dialog unless trusted human steering explicitly requests a decision interaction. First use available tools and context and continue independent authorized work. If an essential external prerequisite remains inaccessible, report its exact error, diagnostics, recovery attempted and required human action through the current goal's blocker report; do not repeatedly retry the question. Once automatic execution is paused, under review or explicitly in main-thread plan mode, use a question for that missing requirement or an explicit user preference discussion. Existing authority remains limited to the current requested scope. This tool does not replace actual permission checks. Delegated workers return unresolved required input to their coordinator.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" - use ${EXIT_PLAN_MODE_TOOL_NAME} for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call ${EXIT_PLAN_MODE_TOOL_NAME}. If you need plan approval, use ${EXIT_PLAN_MODE_TOOL_NAME} instead.
`
