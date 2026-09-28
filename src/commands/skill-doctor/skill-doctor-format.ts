/**
 * Pure formatting for /skill-doctor.
 *
 * Leaf module (no runtime imports) so the Node test suite can import it
 * directly.
 */

export type SkillRow = {
  name: string
  tokens: number
  usedThisSession: boolean
  source: string
}

export function formatSkillDoctor(rows: SkillRow[], sessionId: string): string {
  if (rows.length === 0) {
    return 'No skills loaded — nothing is costing context from skills.'
  }
  const total = rows.reduce((sum, row) => sum + row.tokens, 0)
  const unused = rows.filter(row => !row.usedThisSession)
  const unusedTotal = unused.reduce((sum, row) => sum + row.tokens, 0)

  const lines: string[] = [
    `${rows.length} skills loaded, ~${total} tokens of context spent on skill frontmatter every request.`,
    `${unused.length} unused this session (~${unusedTotal} tokens).`,
    '',
    'Always paid, sorted by cost:',
    '  tokens  used  skill                    source',
    '  ------  ----  ------------------------ ------------------',
  ]
  for (const row of [...rows].sort((a, b) => b.tokens - a.tokens)) {
    const used = row.usedThisSession ? 'yes' : 'no '
    const name = row.name.padEnd(24).slice(0, 24)
    lines.push(`  ${String(row.tokens).padStart(5)}   ${used}   ${name} ${row.source}`)
  }
  lines.push('')
  lines.push(
    'Skills marked "no" have not been invoked this session. Disable them via /skills or remove them from your skills directory to reclaim context.',
  )
  lines.push(`(session ${sessionId.slice(0, 8)} — usage counts reset per session)`)
  return lines.join('\n')
}
