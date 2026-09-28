import type { Command } from '../../commands.js'

const listAgents = {
  type: 'local',
  name: 'list-agents',
  description: 'List all configured agents (use --json for machine-readable output)',
  argumentHint: '[--json]',
  supportsNonInteractive: true,
  load: () => import('./list-agents.js'),
} satisfies Command

export default listAgents
