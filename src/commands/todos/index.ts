import type { Command } from '../../commands.js'

const todos = {
  type: 'local',
  name: 'todos',
  description: 'View the current session todo list',
  supportsNonInteractive: true,
  load: () => import('./todos.js'),
} satisfies Command

export default todos
