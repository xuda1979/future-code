import type { Command } from '../../commands.js'

const focus = {
  type: 'local-jsx',
  name: 'focus',
  description: 'Toggle focus view: just your prompt, summary, and response',
  immediate: true,
  load: () => import('./focus.js'),
} satisfies Command

export default focus
