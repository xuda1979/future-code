/**
 * Pure arg-parsing for /autocompact.
 *
 * Leaf module (no imports) so the Node test suite can import it directly.
 */

export type AutocompactAction =
  | { kind: 'status' }
  | { kind: 'set-enabled'; enabled: boolean }
  | { kind: 'set-percent'; percent: number }
  | { kind: 'error'; message: string }

export function parseAutocompactArgs(args: string): AutocompactAction {
  const arg = args.trim().toLowerCase()

  if (arg === '' || arg === 'status') {
    return { kind: 'status' }
  }

  if (arg === 'on' || arg === 'off') {
    return { kind: 'set-enabled', enabled: arg === 'on' }
  }

  const percent = parseFloat(arg)
  if (!Number.isNaN(percent) && percent > 0 && percent <= 100) {
    return { kind: 'set-percent', percent }
  }

  return {
    kind: 'error',
    message: `Invalid argument "${args.trim()}". Usage: /autocompact [on|off|status] or /autocompact <percent 1-100>`,
  }
}
