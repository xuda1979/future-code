/**
 * /focus — toggle focus view.
 *
 * Focus view renders just the latest prompt and its response (plus any
 * compact summary header) instead of the full scrolling transcript. Older
 * messages remain in the model's context and are always available via the
 * transcript (ctrl+o). Toggling only flips a display flag — nothing is
 * dropped from the conversation.
 */

import type { LocalJSXCommandModule } from '../../types/command.js'

export const call: LocalJSXCommandModule['call'] = async (
  onDone,
  context,
  args,
) => {
  const verb = args.trim().toLowerCase()
  if (verb !== '' && verb !== 'on' && verb !== 'off') {
    onDone('Usage: /focus [on|off]', { display: 'system' })
    return null
  }

  const current = context.getAppState().focusMode
  const next = verb === 'on' ? true : verb === 'off' ? false : !current

  context.setAppState(prev => {
    if (prev.focusMode === next) return prev
    return { ...prev, focusMode: next }
  })

  onDone(next ? 'Focus view on — showing your latest prompt and response. Ctrl+o for the full transcript.' : 'Focus view off — full transcript restored.', {
    display: 'system',
  })
  return null
}
