import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

const command: Command = {
  name: 'chrome',
  description: 'Future in Chrome (Beta) settings',
  availability: ['future-ai'],
  isEnabled: () => !getIsNonInteractiveSession(),
  type: 'local-jsx',
  load: () => import('./chrome.js'),
}

export default command
