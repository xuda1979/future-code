/**
 * Pure formatting for /list-agents.
 *
 * Leaf module: no runtime imports (types only) so the Node test suite
 * (tests/commands) can import it directly — the lazy-loaded command module
 * (list-agents.ts) is Bun-only.
 *
 * AGENT_DISPLAY_GROUPS mirrors AGENT_SOURCE_GROUPS from
 * tools/AgentTool/agentDisplay.ts (same order/labels). Kept local so this
 * file stays dependency-free; update both when source groups change.
 */

export type AgentRow = {
  /** agentType */
  name: string
  /** raw setting source, e.g. 'built-in' | 'userSettings' */
  source: string
  /** pre-resolved model display string ('inherit' allowed), omit to hide */
  model?: string
  /** memory kind, e.g. 'auto' — rendered as "<memory> memory" */
  memory?: string
  description: string
  /** lowercase label of the winning source when this row is shadowed */
  overriddenByLabel?: string
}

export type FailedAgentFile = { path: string; error: string }

export const AGENT_DISPLAY_GROUPS: ReadonlyArray<{
  label: string
  source: string
}> = [
  { label: 'User agents', source: 'userSettings' },
  { label: 'Project agents', source: 'projectSettings' },
  { label: 'Local agents', source: 'localSettings' },
  { label: 'Managed agents', source: 'policySettings' },
  { label: 'Plugin agents', source: 'plugin' },
  { label: 'CLI arg agents', source: 'flagSettings' },
  { label: 'Built-in agents', source: 'built-in' },
]

function formatAgentLine(agent: AgentRow): string {
  const parts = [agent.name]
  if (agent.model) {
    parts.push(agent.model)
  }
  if (agent.memory) {
    parts.push(`${agent.memory} memory`)
  }
  return parts.join(' · ')
}

export function formatAgentsText(
  resolvedAgents: AgentRow[],
  failedFiles: FailedAgentFile[],
): string {
  const lines: string[] = []
  let totalActive = 0

  for (const { label, source } of AGENT_DISPLAY_GROUPS) {
    const groupAgents = resolvedAgents
      .filter(a => a.source === source)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

    if (groupAgents.length === 0) continue

    lines.push(`${label}:`)
    for (const agent of groupAgents) {
      if (agent.overriddenByLabel) {
        lines.push(`  (shadowed by ${agent.overriddenByLabel}) ${formatAgentLine(agent)}`)
      } else {
        lines.push(`  ${formatAgentLine(agent)}`)
        totalActive++
      }
    }
    lines.push('')
  }

  if (failedFiles.length > 0) {
    lines.push('Failed to load some agent files:')
    for (const { path, error } of failedFiles) {
      lines.push(`  ${path}: ${error}`)
    }
    lines.push('')
  }

  if (lines.length === 0) {
    return 'No agents found.'
  }
  return `${totalActive} active agents\n\n${lines.join('\n').trimEnd()}`
}

export function formatAgentsJson(resolvedAgents: AgentRow[]): string {
  return JSON.stringify(
    resolvedAgents.map(agent => ({
      name: agent.name,
      source: agent.source,
      model: agent.model ?? 'inherit',
      description: agent.description,
      active: !agent.overriddenByLabel,
      ...(agent.overriddenByLabel
        ? { overriddenBy: agent.overriddenByLabel }
        : {}),
    })),
    null,
    2,
  )
}
