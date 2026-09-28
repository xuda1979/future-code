/**
 * Pure state transition for /pause-memory.
 *
 * Leaf module (no imports) so the Node test suite can import it directly.
 * The env var is the same one isAutoMemoryEnabled() reads live on every
 * check, so flipping it here takes effect immediately.
 */

export type PauseMemoryResult = { value: string; disableAutoMemory?: boolean }

/**
 * @param args raw command args ('', 'pause', 'resume', 'unpause', …)
 * @param settingsDisabled whether settings.json has autoMemoryEnabled: false
 * @param currentlyDisabled current live state of the env flag
 */
export function applyPauseMemory(
  args: string,
  settingsDisabled: boolean,
  currentlyDisabled: boolean,
): PauseMemoryResult {
  const verb = args.trim().toLowerCase()

  if (verb === 'resume' || verb === 'unpause') {
    return {
      value: settingsDisabled
        ? 'Session pause removed, but auto-memory is still disabled by your settings (autoMemoryEnabled: false).'
        : 'Auto-memory resumed for this session.',
      disableAutoMemory: false,
    }
  }

  if (verb !== '' && verb !== 'pause') {
    return {
      value: `Unknown argument "${args.trim()}". Usage: /pause-memory [resume]`,
      disableAutoMemory: currentlyDisabled,
    }
  }

  const extra = settingsDisabled
    ? ' (auto-memory is also disabled in your settings)'
    : ''
  return {
    value: `Auto-memory paused for this session.${extra} New memories will not be extracted or written until you restart or run /pause-memory resume.`,
    disableAutoMemory: true,
  }
}
