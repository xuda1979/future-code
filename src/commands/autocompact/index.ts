import type { Command } from '../../commands.js'

const autocompact = {
  type: 'local',
  name: 'autocompact',
  description:
    'Set how full the context gets before auto-summarizing. Usage: /autocompact [on|off|status] or /autocompact <percent 1-100>',
  argumentHint: '[on|off|status|<percent>]',
  supportsNonInteractive: true,
  load: () => import('./autocompact.js'),
} satisfies Command

export default autocompact
