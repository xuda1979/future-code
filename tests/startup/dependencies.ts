// Unrelated CLI integrations are isolated because @future/* is not available
// in source-snapshot CI. The compiled fixture uses the production startup,
// ripgrep resolver, PATH lookup and shell-integration implementations.
import { existsSync } from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

export const calls = { dependencies: 0, ripgrep: undefined as unknown }
export let settings = JSON.parse(process.env.TEST_SANDBOX_SETTINGS ?? '{}')
export const replaceSettings = (next: unknown) => { settings = next }
export function memoize(fn: (...args: any[]) => any, resolver?: (...args: any[]) => any) {
  const cache = new Map()
  const wrapped = (...args: any[]) => {
    const key = resolver ? resolver(...args) : args[0]
    if (!cache.has(key)) cache.set(key, fn(...args))
    return cache.get(key)
  }
  wrapped.cache = cache
  return wrapped
}
export default memoize

export const SandboxManager = {
  isSupportedPlatform: () => process.env.TEST_UNSUPPORTED_PLATFORM !== '1',
  checkDependencies: (config: { command: string }) => {
    calls.dependencies++
    calls.ripgrep = config
    if (process.env.TEST_DEPENDENCY_THROW === '1') throw new Error('dependency probe failed')
    return { errors: (Bun.which(config.command) || existsSync(config.command)) ? [] : ['rg missing'], warnings: [] }
  },
  reset: async () => {},
}
export const SandboxRuntimeConfigSchema = {}
export const SandboxViolationStore = {}
export const getSettings_DEPRECATED = () => settings
export const getInitialSettings = () => settings
export const getSettingsForSource = () => undefined
export const getSettingsRootPathForSource = () => process.cwd()
export const getSettingsFilePathForSource = () => undefined
export const updateSettingsForSource = () => {}
export const SETTING_SOURCES = []
export const getManagedSettingsDropInDir = () => undefined
export const settingsChangeDetector = { subscribe: () => () => {} }
export const getAdditionalDirectoriesForFutureMd = () => []
export const getCwdState = () => process.cwd()
export const getOriginalCwd = () => process.cwd()
export const getCwd = () => process.cwd()
export const getFutureTempDir = () => tmpdir()
export const expandPath = (p: string) => p
export const getPlatform = () => process.platform === 'darwin' ? 'macos' : 'linux'
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
export const BASH_TOOL_NAME = 'Bash'
export const FILE_EDIT_TOOL_NAME = 'Edit'
export const FILE_READ_TOOL_NAME = 'Read'
export const WEB_FETCH_TOOL_NAME = 'WebFetch'
export const logEvent = () => {}
export const logForDebugging = () => {}
export const logError = () => {}
export const registerCleanup = () => {}
export const pathExists = async () => false
export const getFsImplementation = () => ({})
export const quote = (args: string[]) => args.map(s => "'" + s.replaceAll("'", "'\\''") + "'").join(' ')
export const execSync_DEPRECATED = execSync
export const execa = async () => { throw new Error('unexpected execa call in startup fixture') }
export const execFileNoThrow = async (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
