/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 * Compiled JS does not appear in Bun.embeddedFiles, so an asset-free binary
 * can have an empty array. Older Bun versions expose only the virtual URL.
 */
export function isInBundledMode(): boolean {
  if (typeof Bun === 'undefined') return false

  const runtime = Bun as typeof Bun & { isStandaloneExecutable?: boolean }
  if (typeof runtime.isStandaloneExecutable === 'boolean') {
    return runtime.isStandaloneExecutable
  }

  // Earlier supported Bun builds predate isStandaloneExecutable. Use this URL,
  // not argv[1] or the executable name (both can also describe source runs).
  return /^file:\/\/\/(?:\$bunfs\/|[A-Za-z]:\/(?:\$bunfs|~BUN)\/)/.test(
    import.meta.url,
  )
}
