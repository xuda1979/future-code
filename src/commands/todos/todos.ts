/**
 * /todos — print the current session todo list.
 *
 * Todos live in appState.todos[todoKey] where todoKey is the agent id or,
 * for the main conversation, the session id — the same key TodoWriteTool
 * uses. Rendering lives in the dependency-free ./format.ts.
 */

import { getSessionId } from '../../bootstrap/state.js'
import type { LocalCommandCall } from '../../types/command.js'
import { formatTodos } from './format.js'

export const call: LocalCommandCall = async (_args, context) => {
  const todoKey = context.agentId ?? getSessionId()
  const todos = context.getAppState().todos[todoKey] ?? []
  return { type: 'text', value: formatTodos(todos) }
}
