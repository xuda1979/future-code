import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultPermissionMode } from '../../src/utils/permissions/defaultPermissionMode.ts'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

// Exercise the production resolver with isolated settings/feature services,
// following the REPL callback tests. No copy of its selection logic lives here.
function resolve(options: Record<string, unknown> = {}, settings: any = {},
  env: Record<string, string> = {}, disabled = false) {
  const source = readFileSync(new URL('../../src/utils/permissions/permissionSetup.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export function initialPermissionModeFromCLI(')
  const end = source.indexOf('export function parseToolListFromCLI(', start)
  assert.ok(start >= 0 && end > start)
  const body = stripTypeScriptTypes(source.slice(start, end).replace('export function', 'function'), { mode: 'transform' })
  const scope = { getSettings_DEPRECATED: () => settings,
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => disabled,
    feature: () => false, permissionModeFromString: (mode: string) => mode,
    isEnvTruthy: (value: string) => /^(1|true|yes|on)$/i.test(value ?? ''),
    process: { env }, logForDebugging: () => {}, logEvent: () => {},
    defaultPermissionMode: () => defaultPermissionMode(env) }
  return new Function(...Object.keys(scope), `${body}\nreturn initialPermissionModeFromCLI;`)(...Object.values(scope))(options)
}

test('ordinary CLI sessions bypass permission prompts by default, including SSH servers', () => {
  assert.equal(defaultPermissionMode({}), 'bypassPermissions')
  assert.equal(defaultPermissionMode({ SSH_CONNECTION: 'remote terminal' }), 'bypassPermissions')
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on'])
    assert.equal(defaultPermissionMode({ FUTURE_CODE_SKIP_PERMISSIONS: value }), 'bypassPermissions')
})

test('an explicit opt-out and invalid values restore prompted permissions', () => {
  for (const value of ['0', 'false', 'off', 'no', '', 'typo'])
    assert.equal(defaultPermissionMode({ FUTURE_CODE_SKIP_PERMISSIONS: value }), 'default')
})

test('managed Remote Control keeps its own permission defaults', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on'])
    assert.equal(defaultPermissionMode({ FUTURE_CODE_REMOTE: value,
      FUTURE_CODE_SKIP_PERMISSIONS: '1' }), 'default')
  assert.equal(defaultPermissionMode({ FUTURE_CODE_REMOTE: 'false' }), 'bypassPermissions')
})

test('production resolver preserves explicit CLI modes, settings and the bypass killswitch', () => {
  assert.equal(resolve().mode, 'bypassPermissions')
  for (const mode of ['default', 'plan', 'acceptEdits', 'dontAsk']) {
    assert.equal(resolve({ permissionModeCli: mode }).mode, mode)
    assert.equal(resolve({}, { permissions: { defaultMode: mode } }).mode, mode)
  }
  assert.equal(resolve({ permissionModeCli: 'plan' }, { permissions: { defaultMode: 'bypassPermissions' } }).mode, 'plan')
  assert.equal(resolve({}, {}, { FUTURE_CODE_SKIP_PERMISSIONS: '0' }).mode, 'default')
  assert.equal(resolve({ dangerouslySkipPermissions: true }, {}, { FUTURE_CODE_SKIP_PERMISSIONS: '0' }).mode, 'bypassPermissions')
  for (const options of [{}, { dangerouslySkipPermissions: true }]) {
    assert.equal(resolve(options, { permissions: { disableBypassPermissionsMode: 'disable' } }).mode, 'default')
    assert.equal(resolve(options, {}, {}, true).mode, 'default')
  }
  assert.equal(resolve({}, { permissions: { defaultMode: 'bypassPermissions' } }, { FUTURE_CODE_REMOTE: '1' }).mode, 'default')
})
