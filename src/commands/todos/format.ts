/**
 * Pure formatting for /todos.
 *
 * Leaf module (types only) so the Node test suite can import it directly.
 */

import type { TodoList } from '../../utils/todo/types.js'

const STATUS_PREFIX: Record<string, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
}

export function formatTodos(todos: TodoList): string {
  if (todos.length === 0) {
    return 'No todos yet. Ask me to use TodoWrite to track tasks for this session.'
  }
  const lines = todos.map((todo, index) => {
    const prefix = STATUS_PREFIX[todo.status] ?? '[ ]'
    const content =
      todo.status === 'in_progress' && todo.activeForm
        ? `${todo.activeForm}…`
        : todo.content
    return `${index + 1}. ${prefix} ${content}`
  })
  const done = todos.filter(t => t.status === 'completed').length
  return `${done}/${todos.length} completed\n\n${lines.join('\n')}`
}
