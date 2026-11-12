// Types extracted to src/types/permissions.ts to break import cycles
import type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMetadata,
  PermissionResult,
} from '../../types/permissions.js'

// Re-export for backwards compatibility
export type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMetadata,
  PermissionResult,
}

/** A compound result must not hide an explicit operator ask behind a
 * heuristic. Iteration also handles deeply nested/cyclic host receipts. */
export function hasExplicitAskRule(result: PermissionResult): result is PermissionAskDecision {
  const pending = [result]
  const seen = new Set<PermissionResult>()
  while (pending.length) {
    const current = pending.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    if (current.behavior !== 'ask') continue
    const reason = current.decisionReason
    if (reason?.type === 'rule' && reason.rule.ruleBehavior === 'ask') return true
    if (reason?.type === 'subcommandResults') {
      for (const child of reason.reasons.values()) pending.push(child)
    }
  }
  return false
}

/** Keep a mandatory safety receipt visible through compound reductions so
 * neither mode shortcuts nor an auto classifier can approve it indirectly. */
export function getMandatorySafetyCheck(result: PermissionResult): PermissionAskDecision | null {
  if (result.behavior !== 'ask') return null
  const pending: PermissionResult[] = [result]
  const seen = new Set<PermissionResult>()
  while (pending.length) {
    const current = pending.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    if (current.behavior !== 'ask') continue
    const reason = current.decisionReason
    if (reason?.type === 'safetyCheck' && reason.classifierApprovable !== true) {
      return current === result ? result : { ...result, message: current.message, decisionReason: reason }
    }
    if (reason?.type === 'subcommandResults') {
      for (const child of reason.reasons.values()) pending.push(child)
    }
  }
  return null
}

export function preferExplicitAsk(
  current: PermissionResult | undefined,
  next: PermissionResult,
): PermissionResult | undefined {
  if (next.behavior !== 'ask') return current
  const mandatory = (current && getMandatorySafetyCheck(current)) ?? getMandatorySafetyCheck(next)
  if (mandatory) return mandatory
  return !current || (hasExplicitAskRule(next) && !hasExplicitAskRule(current)) ? next : current
}

// Helper function to get the appropriate prose description for rule behavior
export function getRuleBehaviorDescription(
  permissionResult: PermissionResult['behavior'],
): string {
  switch (permissionResult) {
    case 'allow':
      return 'allowed'
    case 'deny':
      return 'denied'
    default:
      return 'asked for confirmation for'
  }
}
