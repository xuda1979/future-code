/**
 * /list-agents — print all configured agents, grouped by source.
 *
 * Non-interactive counterpart to the interactive /agents manager: it renders
 * the same agent set the `future-code agents` CLI handler prints (built-ins,
 * user/project/local/managed/plugin agents, shadowed duplicates included),
 * and supports `--json` for machine-readable output.
 *
 * Formatting lives in the dependency-free ./format.ts (Node-testable);
 * this module is the Bun-only runtime glue.
 */

import type { LocalCommandCall } from '../../types/command.js'
import {
  compareAgentsByName,
  getOverrideSourceLabel,
  resolveAgentModelDisplay,
  resolveAgentOverrides,
} from '../../tools/AgentTool/agentDisplay.js'
import {
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'
import { formatAgentsJson, formatAgentsText, type AgentRow } from './format.js'

function toRows(
  resolvedAgents: ReturnType<typeof resolveAgentOverrides>,
): AgentRow[] {
  return [...resolvedAgents]
    .sort(compareAgentsByName)
    .map(agent => ({
      name: agent.agentType,
      source: agent.source,
      model: resolveAgentModelDisplay(agent),
      memory: agent.memory,
      description: agent.whenToUse,
      overriddenByLabel: agent.overriddenBy
        ? getOverrideSourceLabel(agent.overriddenBy)
        : undefined,
    }))
}

export const call: LocalCommandCall = async args => {
  const cwd = getCwd()
  const { allAgents, failedFiles } = await getAgentDefinitionsWithOverrides(cwd)
  const activeAgents = getActiveAgentsFromList(allAgents)
  const resolvedAgents = resolveAgentOverrides(allAgents, activeAgents)
  const rows = toRows(resolvedAgents)

  if (args.trim() === '--json') {
    return { type: 'text', value: formatAgentsJson(rows) }
  }

  return {
    type: 'text',
    value: formatAgentsText(rows, failedFiles ?? []),
  }
}
