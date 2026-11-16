/** Bounded lexical hints for latency diagnostics only. This is not a shell
 * parser, an execution grant, or proof that a command is safe/correct.
 * Unsupported/compound syntax stays unknown; original commands are untouched. */
export function simpleShellWords(command: unknown): string[] | null {
  if (typeof command !== 'string' || command.length > 8192 || /[\n\r\0#;&|<>`$\\()]/.test(command)) return null
  const tokens = command.match(/'[^']*'|"[^"]*"|[^\s'"]+/g)
  if (!tokens || tokens.length > 256 || tokens.join(' ').replace(/\s+/g, '') !== command.replace(/\s+/g, '')) return null
  // Adjacent quoted/unquoted fragments need a real parser, so reject them.
  if (!/^\s*(?:'[^']*'|"[^"]*"|[^\s'"]+)(?:\s+(?:'[^']*'|"[^"]*"|[^\s'"]+))*\s*$/.test(command)) return null
  return tokens.map(word => /^['"]/.test(word) ? word.slice(1, -1) : word)
}

export function gitActivity(command: unknown): 'observe' | 'deliver' | null {
  const words = simpleShellWords(command)
  if (!words || words.shift() !== 'git') return null
  while (words[0] === '-C' || words[0] === '--no-pager') {
    const option = words.shift()
    if (option === '-C' && (!words.shift() || words.length === 0)) return null
  }
  const verb = words.shift()
  // External diff/textconv and file output are not observation-only hints.
  if (words.some(word => /^(?:--output|--ext-diff|--textconv)(?:=|$)/.test(word))) return null
  if (['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-remote'].includes(verb ?? '')) return 'observe'
  return ['add', 'commit', 'push'].includes(verb ?? '') ? 'deliver' : null
}

export function isShellObservation(command: unknown): boolean {
  if (gitActivity(command) === 'observe') return true
  const words = simpleShellWords(command)
  if (!words) return false
  const name = words.shift()
  if (name === 'rg' && words.some(word => /^--pre(?:=|$)/.test(word))) return false
  return ['pwd', 'ls', 'rg', 'grep', 'cat', 'head', 'tail', 'wc'].includes(name ?? '')
}
