import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// projectDigest — session-start project layout digest
// ---------------------------------------------------------------------------
//
// Live-transcript mining (1682 session transcripts, /tmp/probe-detail-out.json)
// showed the dominant session-start waste is layout probing: 1451/1623
// sessions make zero file edits in their first 12 tool calls while
// re-deriving facts the host already knows (ls -la x690, sed -n x680,
// grep -n x549, git status x360 among first-12 Bash openers; 447 sessions
// re-fetch git facts despite the injected gitStatus snapshot; 49 sessions
// re-read the goal report already in their anchor). The digest injects
// those facts once — a bounded root/src layout plus package.json command
// facts — so the model can act directly instead of probing.
//
// Deliberately dependency-free (node: builtins only) so the offline Node
// correctness gate can import it with `--experimental-strip-types` without
// Bun-only `.js` -> `.ts` specifier remapping, mirroring readRangeCoverage.
//
// Guards: FUTURE_CODE_DISABLE_PROJECT_DIGEST killswitch, CCR
// (FUTURE_CODE_REMOTE), bare mode (FUTURE_CODE_SIMPLE/--bare), homedir or
// root cwd, manifest size cap, and a hard character cap. The closing
// directive preserves verification rigor: the snapshot can go stale, and
// outcomes still require concrete verification.

export const MAX_DIGEST_CHARS = 4000
const MAX_ROOT_ENTRIES = 48
const MAX_SRC_ENTRIES = 40
const MAX_SCRIPTS = 12
const MAX_SCRIPT_CHARS = 120
const MAX_MANIFEST_BYTES = 262144

const NOISE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'venv',
  '__pycache__',
])
const NOISE_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'cargo.lock',
  'poetry.lock',
  '.ds_store',
  'thumbs.db',
])

export interface DigestManifest {
  name?: string
  version?: string
  entry?: string
  workspaces?: number
  scripts: Array<[string, string]>
}

export interface DigestLayout {
  rootShown: string[]
  rootHidden: number
  srcShown: string[] | null
  srcHidden: number
}

function envTruthy(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())
}

export function projectDigestDisabled(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): boolean {
  return (
    envTruthy(env.FUTURE_CODE_DISABLE_PROJECT_DIGEST) ||
    envTruthy(env.FUTURE_CODE_REMOTE) ||
    envTruthy(env.FUTURE_CODE_SIMPLE) ||
    argv.includes('--bare')
  )
}

/**
 * Filters noise, sorts dirs-first, and caps the listing. Pure — unit tested
 * directly without touching the filesystem.
 */
export function selectLayoutEntries(
  names: Array<{ name: string; isDir: boolean }>,
  max: number,
): { shown: string[]; hidden: number } {
  const dirs: string[] = []
  const files: string[] = []
  for (const entry of names) {
    const name = basename(entry.name)
    const lower = name.toLowerCase()
    if (name.startsWith('.')) continue
    if (entry.isDir && NOISE_DIRS.has(lower)) continue
    if (!entry.isDir && NOISE_FILES.has(lower)) continue
    ;(entry.isDir ? dirs : files).push(entry.isDir ? `${name}/` : name)
  }
  dirs.sort()
  files.sort()
  const all = [...dirs, ...files]
  return { shown: all.slice(0, max), hidden: Math.max(0, all.length - max) }
}

/** Formats the digest text. Pure — unit tested directly. */
export function formatProjectDigest(
  layout: DigestLayout,
  manifest: DigestManifest | null,
): string | null {
  const lines: string[] = []
  if (layout.rootShown.length > 0) {
    lines.push(
      `Top-level: ${layout.rootShown.join(' ')}` +
        (layout.rootHidden > 0 ? ` (+${layout.rootHidden} more)` : ''),
    )
  }
  if (layout.srcShown && layout.srcShown.length > 0) {
    lines.push(
      `src/: ${layout.srcShown.join(' ')}` +
        (layout.srcHidden > 0 ? ` (+${layout.srcHidden} more)` : ''),
    )
  }
  if (manifest) {
    const meta: string[] = []
    if (manifest.name)
      meta.push(manifest.version ? `${manifest.name}@${manifest.version}` : manifest.name)
    if (manifest.entry) meta.push(`entry: ${manifest.entry}`)
    if (manifest.workspaces) meta.push(`workspaces: ${manifest.workspaces}`)
    if (meta.length > 0) lines.push(`Manifest: ${meta.join(' | ')}`)
    if (manifest.scripts.length > 0) {
      lines.push('Scripts:')
      for (const [key, command] of manifest.scripts) {
        const clipped =
          command.length > MAX_SCRIPT_CHARS ? `${command.slice(0, MAX_SCRIPT_CHARS)}...` : command
        lines.push(`  ${key}: ${clipped}`)
      }
    }
  }
  if (lines.length === 0) return null
  lines.push(
    'Act directly: use these paths with Read/Grep/Glob instead of re-listing directories or ' +
      're-running git status/branch/log at session start (git facts are already injected). ' +
      'This snapshot can go stale - re-check anything time-sensitive before relying on it, ' +
      'and verify every work outcome with concrete checks as usual.',
  )
  const joined = lines.join('\n')
  if (joined.length > MAX_DIGEST_CHARS) {
    return `${joined.slice(0, MAX_DIGEST_CHARS)}\n(digest truncated)`
  }
  return joined
}

function readManifest(dir: string): DigestManifest | null {
  const manifestPath = resolve(dir, 'package.json')
  let size: number
  try {
    size = statSync(manifestPath).size
  } catch {
    return null
  }
  if (size > MAX_MANIFEST_BYTES) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const manifest: DigestManifest = { scripts: [] }
  if (typeof parsed.name === 'string') manifest.name = parsed.name
  if (typeof parsed.version === 'string') manifest.version = parsed.version
  const entryCandidate =
    typeof parsed.main === 'string'
      ? parsed.main
      : typeof parsed.module === 'string'
        ? parsed.module
        : undefined
  if (entryCandidate) manifest.entry = entryCandidate
  if (Array.isArray(parsed.workspaces)) manifest.workspaces = parsed.workspaces.length
  const scripts = parsed.scripts
  if (scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)) {
    for (const [key, value] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof value !== 'string') continue
      manifest.scripts.push([key, value])
      if (manifest.scripts.length >= MAX_SCRIPTS) break
    }
  }
  if (!manifest.name && manifest.scripts.length === 0) return null
  return manifest
}

/**
 * Collects the digest for a working directory. Synchronous by design: one
 * readdir of the root, at most one readdir of src/, and one bounded
 * package.json read — single-digit milliseconds on the startup path.
 * Returns null whenever any guard trips or nothing useful can be shown.
 */
export function collectProjectDigest(cwd: string = process.cwd()): string | null {
  if (projectDigestDisabled()) return null
  const dir = resolve(cwd)
  if (dir === resolve(homedir()) || dir === '/') return null
  try {
    let rootEntries: Array<{ name: string; isDir: boolean }>
    try {
      rootEntries = readdirSync(dir, { withFileTypes: true }).map(entry => ({
        name: entry.name,
        isDir: entry.isDirectory(),
      }))
    } catch {
      return null
    }
    if (rootEntries.length === 0) return null
    const root = selectLayoutEntries(rootEntries, MAX_ROOT_ENTRIES)
    let srcShown: string[] | null = null
    let srcHidden = 0
    if (rootEntries.some(entry => entry.isDir && entry.name === 'src')) {
      try {
        const srcEntries = readdirSync(resolve(dir, 'src'), { withFileTypes: true }).map(
          entry => ({
            name: entry.name,
            isDir: entry.isDirectory(),
          }),
        )
        const selected = selectLayoutEntries(srcEntries, MAX_SRC_ENTRIES)
        srcShown = selected.shown
        srcHidden = selected.hidden
      } catch {
        // src/ unreadable or not a directory; the root line still helps.
      }
    }
    const manifest = readManifest(dir)
    if (root.shown.length === 0 && !manifest) return null
    return formatProjectDigest(
      { rootShown: root.shown, rootHidden: root.hidden, srcShown, srcHidden },
      manifest,
    )
  } catch {
    return null
  }
}
