import ignore from 'ignore'

// Git inventories are repository-relative even when the user is editing from
// a subdirectory. Apply each file's rules in its own directory before
// converting matches to display paths (which can legitimately start with ../).
export function fileSuggestionFilter(sources: { prefix: string; patterns: string }[]) {
  if (sources.length === 0) return null
  const rules = sources.map(({ prefix, patterns }) => ({
    prefix,
    matcher: ignore().add(patterns),
  })).reverse()
  return (file: string): boolean => {
    for (const { prefix, matcher } of rules) {
      if (!file.startsWith(prefix) || file.length === prefix.length) continue
      const match = matcher.test(file.slice(prefix.length))
      if (match.ignored || match.unignored) return !match.ignored
    }
    return true
  }
}
