/** Invoke the production command/components with a tiny terminal hook adapter.
 * No snapshots or copied decision code: observe saves, callbacks and state. */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readModelEndpoint, saveModelEndpoint } from '../../src/utils/model/modelEndpoints.ts'

const stub = (path: string, exports: Record<string, unknown>, extension = 'ts') => mock.module(new URL(`../../src/${path}.${extension}`, import.meta.url).pathname, () => exports)
const noop = () => {}
const jsx = (type: any, props: any) => ({ type, props })
const cleanups: (() => void)[] = []
mock.module('react', () => ({ useState: (value: any) => [value, noop], useRef: (value: any) => ({ current: value }), useEffect: (effect: () => any) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup) } }))
for (const path of ['react/jsx-runtime', 'react/jsx-dev-runtime']) mock.module(path, () => ({ jsx, jsxs: jsx, jsxDEV: jsx }))
mock.module('chalk', () => ({ default: { bold: (value: string) => value } }))
stub('ink', { Box: 'Box', Text: 'Text' })
stub('components/TextInput', { default: 'TextInput' }, 'tsx')
stub('components/ModelPicker', { ModelPicker: 'ModelPicker' }, 'tsx')
let state: any = { mainLoopModel: 'old-model', mainLoopModelForSession: null, fastMode: false }
stub('state/AppState', { useAppState: (select: any) => select(state), useSetAppState: () => (update: any) => { state = update(state) } }, 'tsx')
const events: unknown[] = []
stub('services/analytics/index', { logEvent: (...args: unknown[]) => events.push(args) })
stub('utils/extraUsage', { isBilledAsExtraUsage: () => false })
stub('utils/fastMode', { clearFastModeCooldown: noop, isFastModeAvailable: () => false, isFastModeEnabled: () => false, isFastModeSupportedByModel: () => false })
stub('utils/model/check1mAccess', { checkOpus1mAccess: () => true, checkSonnet1mAccess: () => true })
stub('utils/model/model', { getMainLoopModel: () => 'old-model', renderModelName: (model: string) => model, getDefaultMainLoopModelSetting: () => 'old-model', isOpus1mMergeEnabled: () => false, renderDefaultModelSetting: (model: string) => model })
let allowed = true
stub('utils/model/modelAllowlist', { isModelAllowed: () => allowed })
let checks = 0
let nextCheck: Promise<{ valid: boolean; error?: string }> = Promise.resolve({ valid: true })
let validationSignal: AbortSignal | undefined
stub('utils/model/validateModel', { validateModel: (_model: string, signal: AbortSignal) => { checks++; validationSignal = signal; return nextCheck } })
const { call } = await import('../../src/commands/model/model.tsx')
const { default: definition } = await import('../../src/commands/model/index.ts')
const oldConfig = process.env.FUTURE_CONFIG_DIR
const dir = mkdtempSync(join(tmpdir(), 'model-command-'))
process.env.FUTURE_CONFIG_DIR = dir
const outputs: { text?: string; options?: any }[] = []
const done = (text?: string, options?: any) => outputs.push({ text, options })
const profile = { version: 1 as const, model: 'New-Model', baseUrl: 'https://example.invalid/v1', protocol: 'anthropic' as const, apiKey: 'test-key-only' }
beforeEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  outputs.length = 0; events.length = 0; checks = 0; allowed = true
  state = { mainLoopModel: 'old-model', mainLoopModelForSession: null, fastMode: false }
  nextCheck = Promise.resolve({ valid: true })
})
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  if (oldConfig === undefined) delete process.env.FUTURE_CONFIG_DIR; else process.env.FUTURE_CONFIG_DIR = oldConfig
  delete process.env.MODEL_COMMAND_TEST_KEY
  rmSync(dir, { recursive: true, force: true })
})

test('/model is immediately dispatchable for ordinary users while an API call is stuck', () => {
  expect(definition.type).toBe('local-jsx')
  expect(definition.immediate).toBe(true)
})

test('add completes locally without validation, analytics, model changes or raw-key output', async () => {
  process.env.MODEL_COMMAND_TEST_KEY = profile.apiKey
  const element = await call(done, {} as any, 'add New-Model https://example.invalid/v1 --protocol anthropic --api-key-env MODEL_COMMAND_TEST_KEY')
  expect(element).toBeUndefined()
  expect(readModelEndpoint(profile.model)).toEqual(profile)
  expect(checks).toBe(0)
  expect(events).toEqual([])
  expect(outputs[0]?.text).toContain('No network check')
  expect(JSON.stringify(outputs)).not.toContain(profile.apiKey)
  expect(state.mainLoopModel).toBe('old-model')
})

test('interactive setup masks the key, saves on submit, and omits credentials from callbacks', async () => {
  const element: any = await call(done, {} as any, 'add Masked-Model https://example.invalid/v1 --protocol anthropic')
  const form = element.type(element.props)
  const input = form.props.children.find((child: any) => child?.type === 'TextInput')
  expect(input.props.mask).toBe('*')
  input.props.onSubmit('masked-test-key')
  expect(readModelEndpoint('Masked-Model')?.apiKey).toBe('masked-test-key')
  expect(JSON.stringify(outputs)).not.toContain('masked-test-key')
  expect(checks).toBe(0)
})

test('restricted model setup stops before saving or contacting a provider', async () => {
  allowed = false
  await call(done, {} as any, 'add Restricted-Model https://example.invalid/v1')
  expect(readModelEndpoint('Restricted-Model')).toBeUndefined()
  expect(outputs[0]?.text).toContain('restricts')
  expect(checks).toBe(0)
})

test('picker does not switch a saved endpoint when its real validation fails', async () => {
  saveModelEndpoint(profile)
  nextCheck = Promise.resolve({ valid: false, error: 'Authentication failed' })
  const wrapper: any = await call(done, {} as any, '')
  const picker = wrapper.type(wrapper.props)
  await picker.props.onSelect(profile.model)
  expect(checks).toBe(1)
  expect(state.mainLoopModel).toBe('old-model')
  expect(outputs[0]?.text).toContain('Authentication failed')
})

test('cancelling the picker prevents a late validation success from switching models', async () => {
  saveModelEndpoint(profile)
  let finish: (value: { valid: boolean }) => void = noop
  nextCheck = new Promise(resolve => { finish = resolve })
  const wrapper: any = await call(done, {} as any, '')
  const picker = wrapper.type(wrapper.props)
  const pending = picker.props.onSelect(profile.model)
  picker.props.onCancel()
  expect(validationSignal?.aborted).toBe(true)
  finish({ valid: true })
  await pending
  expect(state.mainLoopModel).toBe('old-model')
  expect(outputs.length).toBe(1)
})

test('unmounting an inline model switch cancels its probe and ignores its late success', async () => {
  let finish: (value: { valid: boolean }) => void = noop
  nextCheck = new Promise(resolve => { finish = resolve })
  const element: any = await call(done, {} as any, profile.model)
  element.type(element.props)
  expect(checks).toBe(1)
  for (const cleanup of cleanups.splice(0)) cleanup()
  finish({ valid: true })
  await new Promise(resolve => setImmediate(resolve))
  expect(validationSignal?.aborted).toBe(true)
  expect(state.mainLoopModel).toBe('old-model')
  expect(outputs).toEqual([])
})
