import type { PermissionDecision } from './PermissionResult.js'

/** Unattended by default. Explicit owner configuration can restore dialogs.
 * Suppressing a dialog never grants a missing capability or fabricates input. */
export function interactivePromptsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.FUTURE_CODE_INTERACTIVE_PROMPTS ?? '')
}

/** Keep Git from parking a shell on terminal/GUI credential input. Existing
 * credential helpers, commit hooks and signing are not disabled. */
export function unattendedGitEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  return interactivePromptsEnabled(env) ? {} : { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' }
}

export function automaticPermissionDecision(decision: PermissionDecision, toolName: string): PermissionDecision {
  if (decision.behavior !== 'ask' || interactivePromptsEnabled()) return decision
  return {
    behavior: 'deny',
    decisionReason: decision.decisionReason,
    message: `Unattended execution cannot obtain interactive approval for ${toolName}. ` +
      (decision.message ?? 'The requested capability is unavailable under the configured policy.') +
      ' Continue permitted work, diagnose the restriction, or report its exact external prerequisite. Do not request another approval or claim the action succeeded.',
  }
}
