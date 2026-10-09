// Run: bun test tests/startup/compiled-startup.test.ts
import { beforeAll, afterAll, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dir, '../..')
const temp = mkdtempSync(join(tmpdir(), 'future-code-startup-'))
const fixture = join(root, 'tests/startup/fixture.ts')
const binary = join(temp, 'startup')
const emptyPath = join(temp, 'empty-path')
const toolPath = join(temp, 'tools')
const modeProbe = join(temp, 'mode-probe.ts')

beforeAll(async () => {
  mkdirSync(emptyPath)
  mkdirSync(toolPath)
  writeFileSync(modeProbe, `import { isInBundledMode, isRunningWithBun } from ${JSON.stringify(pathToFileURL(join(root, 'src/utils/bundledMode.ts')).href)};
    console.log(JSON.stringify({ bundled: isInBundledMode(), bun: isRunningWithBun() }));`)
  writeFileSync(join(toolPath, 'rg'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "ripgrep 14.1.1"; else echo "fixture.txt"; fi\n', { mode: 0o755 })
  const production = new Set(['sandbox-adapter.ts', 'ripgrep.ts', 'ShellSnapshot.ts', 'envUtils.ts', 'which.ts'])
  const realUtilities = /(?:bundledMode|ripgrep|envUtils|findExecutable|which|embeddedTools|stringUtils|subprocessEnv)\.js$/
  const build = await Bun.build({
    entrypoints: [fixture],
    compile: { outfile: binary },
    plugins: [{
      name: 'isolate-unrelated-cli-dependencies',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (!production.has(basename(args.importer))) return
          if (/^(?:node:)?(?:child_process|os|fs(?:\/promises)?|path|url)$/.test(args.path) || realUtilities.test(args.path)) return
          return { path: join(root, 'tests/startup/dependencies.ts') }
        })
      },
    }],
  })
  if (!build.success) throw new Error(build.logs.join('\n'))
})
afterAll(() => rmSync(temp, { recursive: true, force: true }))

function run(action: string, settings = {}, extraEnv: Record<string, string> = {}) {
  return spawnSync(binary, [action], {
    cwd: temp, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: emptyPath, USE_BUILTIN_RIPGREP: '0', FUTURE_EMBEDDED_RIPGREP: '0',
      TEST_UNSUPPORTED_PLATFORM: '0', TEST_DEPENDENCY_THROW: '0',
      TEST_SANDBOX_SETTINGS: JSON.stringify(settings), ...extraEnv },
  })
}
function read(action: string, settings = {}, extraEnv: Record<string, string> = {}) {
  const result = run(action, settings, extraEnv)
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

test('standalone executable with zero embedded assets is bundled', () => {
  expect(read('mode')).toEqual({ bundled: true, embeddedFiles: 0 })
})
test('Bun and Node source execution remain unbundled', () => {
  for (const [runtime, args, bun] of [
    [process.execPath, [modeProbe], true],
    [Bun.which('node'), ['--experimental-strip-types', modeProbe], false],
  ] as const) {
    expect(runtime).not.toBeNull()
    const result = spawnSync(runtime!, [...args], { encoding: 'utf8', timeout: 10000 })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ bundled: false, bun })
  }
})
test('disabled sandbox never checks optional dependencies with no rg executable', () => {
  const value = read('sandbox')
  expect(value.enabled).toBe(false)
  expect(value.reason).toBeUndefined()
  expect(value.calls.dependencies).toBe(0)
})
test('enabled sandbox reports missing rg; required sandbox remains required', () => {
  const value = read('sandbox', { sandbox: { enabled: true, failIfUnavailable: true } })
  expect(value.enabled).toBe(false)
  expect(value.required).toBe(true)
  expect(value.reason).toContain('ripgrep')
  expect(value.reason).toContain('dependencies are missing')
})
test('unsupported and excluded platforms do not probe dependencies', () => {
  for (const [settings, env] of [
    [{ sandbox: { enabled: true } }, { TEST_UNSUPPORTED_PLATFORM: '1' }],
    [{ sandbox: { enabled: true, enabledPlatforms: [] } }, {}],
  ] as const) {
    expect(read('sandbox', settings, env).calls.dependencies).toBe(0)
  }
})
test('dependency errors are structured rather than thrown', () => {
  const value = read('dependencies')
  expect(value.errors.length).toBeGreaterThan(0)
  expect(value.errors[0]).toContain('ripgrep')
})
test('sandbox custom rg config bypasses default lookup in both checks and conversion', () => {
  const rg = { command: join(toolPath, 'rg'), args: ['--no-config'] }
  const settings = { sandbox: { enabled: true, ripgrep: rg } }
  const value = read('sandbox', settings)
  expect(value.enabled).toBe(true)
  expect(value.reason).toBeUndefined()
  expect(value.calls.ripgrep).toEqual(rg)
  expect(read('config', settings)).toEqual(rg)
})
test('base dependency exceptions are reported without crashing', () => {
  const value = read('sandbox', { sandbox: { enabled: true } }, { PATH: toolPath, TEST_DEPENDENCY_THROW: '1' })
  expect(value.enabled).toBe(false)
  expect(value.reason).toContain('dependency probe failed')
})
test('dependency checks follow changed sandbox command settings', () => {
  const next = { sandbox: { enabled: true, ripgrep: { command: join(toolPath, 'rg') } } }
  const value = read('reconfigure', {}, { TEST_NEXT_SETTINGS: JSON.stringify(next) })
  expect(value.before.errors.length).toBeGreaterThan(0)
  expect(value.after.errors).toEqual([])
  expect(value.calls.ripgrep).toEqual(next.sandbox.ripgrep)
})
test('doctor status and shell integration tolerate missing rg', () => {
  expect(read('status')).toMatchObject({ mode: 'unavailable', working: false })
  expect(read('shell')).toBeNull()
})
test('a shell function is invisible to direct spawning and is not treated as rg', () => {
  expect(read('status', {}, { 'BASH_FUNC_rg%%': '() { echo ripgrep; }' }).working).toBe(false)
})
test('search fails explicitly with no rg instead of claiming no matches', () => {
  const result = run('search')
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('ripgrep')
  expect(result.stderr).toContain('PATH')
  expect(result.stderr).not.toContain('/$bunfs/root/vendor')
})
test('real executable on PATH still resolves and search spawns it', () => {
  expect(read('command', {}, { PATH: toolPath })).toEqual({ rgPath: 'rg', rgArgs: [] })
  expect(read('shell', {}, { PATH: toolPath }).type).toBe('alias')
  expect(read('search', {}, { PATH: toolPath })).toEqual(['fixture.txt'])
})
test('embedded applet dispatch requires explicit build capability', () => {
  const value = read('command', {}, { FUTURE_EMBEDDED_RIPGREP: '1' })
  expect(value.argv0).toBe('rg')
  expect(value.rgPath).toBe(binary)
  expect(value.rgArgs).toEqual(['--no-config'])
})
