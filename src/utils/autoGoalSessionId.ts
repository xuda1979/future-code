// Browser-safe leaf: bootstrap can supply its existing identity without
// importing filesystem or Node async-local execution machinery.
let resolver: (() => string) | undefined

export function configureAutoGoalSession(getSessionId: (() => string) | undefined): void {
  resolver = getSessionId
}

export function configuredAutoGoalSessionId(): string | null {
  const id = resolver?.() ?? null
  if (id !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))
    throw new Error('Invalid autonomous-goal session identity')
  return id
}
