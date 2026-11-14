import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// Offline precedence regression for defaulting streaming tool execution ON.
// Loads the REAL gate resolution (src/services/analytics/growthbook.ts) and
// config builder (src/query/config.ts); the loader stubs only the leaf
// config/auth/analytics modules so every precedence layer can be pinned
// deterministically without network, disk config, or init ordering.
register('./streaming-gate-precedence-loader.mjs', import.meta.url)

const { buildQueryConfig } = await import('../../src/query/config.ts')
const { checkStatsigFeatureGate_CACHED_MAY_BE_STALE: gate } = await import(
  '../../src/services/analytics/growthbook.ts'
)

const GATE = 'tengu_streaming_tool_execution2'

// getEnvOverrides() parses FUTURE_INTERNAL_FC_OVERRIDES once and memoizes,
// so the harness override must be in place before the first gate call and
// stays set for the process. It carries only the probe gate so the
// streaming gate falls through to the layers under test.
process.env.USER_TYPE = 'ant'
process.env.FUTURE_INTERNAL_FC_OVERRIDES = JSON.stringify({
  tenv_override_probe: false,
})

type TestConfig = {
  cachedGrowthBookFeatures?: Record<string, unknown>
  cachedStatsigGates?: Record<string, boolean>
  growthBookOverrides?: Record<string, unknown>
}

function reset(config: TestConfig = {}, onePEnabled = false): void {
  ;(globalThis as { __fcGateTestConfig?: unknown }).__fcGateTestConfig = config
  ;(globalThis as { __fcGateTest1PEnabled?: boolean }).__fcGateTest1PEnabled =
    onePEnabled
  delete process.env.FUTURE_CODE_DISABLE_STREAMING_TOOL_EXECUTION
}

test('env-var harness override outranks caches and the default', () => {
  reset({ cachedGrowthBookFeatures: { tenv_override_probe: true } }, true)
  assert.equal(gate('tenv_override_probe', true), false)
  assert.equal(gate('tenv_override_probe'), false)
})

test('fresh install: no caches, telemetry off — streaming defaults ON, other gates stay OFF', () => {
  reset()
  assert.equal(gate(GATE, true), true)
  assert.equal(gate('tengu_scratch'), false)
  const gates = buildQueryConfig().gates
  assert.equal(gates.streamingToolExecution, true)
})

test('FUTURE_CODE_DISABLE_STREAMING_TOOL_EXECUTION kill switch wins over everything', () => {
  reset({ cachedGrowthBookFeatures: { [GATE]: true } }, true)
  process.env.FUTURE_CODE_DISABLE_STREAMING_TOOL_EXECUTION = '1'
  assert.equal(buildQueryConfig().gates.streamingToolExecution, false)
  process.env.FUTURE_CODE_DISABLE_STREAMING_TOOL_EXECUTION = 'true'
  assert.equal(buildQueryConfig().gates.streamingToolExecution, false)
  // 'false' does not trip isEnvTruthy — the switch is inactive
  process.env.FUTURE_CODE_DISABLE_STREAMING_TOOL_EXECUTION = 'false'
  assert.equal(buildQueryConfig().gates.streamingToolExecution, true)
})

test('explicit server-off is preserved: cached false beats the new default', () => {
  reset({ cachedGrowthBookFeatures: { [GATE]: false } }, true)
  assert.equal(gate(GATE, true), false)
  assert.equal(buildQueryConfig().gates.streamingToolExecution, false)
})

test('statsig migration cache still applies on top of the default', () => {
  reset({ cachedStatsigGates: { [GATE]: false } }, true)
  assert.equal(gate(GATE, true), false)
  reset({ cachedStatsigGates: { tengu_scratch: true } }, true)
  assert.equal(gate('tengu_scratch'), true)
  reset({ cachedStatsigGates: { [GATE]: true } }, true)
  assert.equal(buildQueryConfig().gates.streamingToolExecution, true)
})

test('Gates-tab config override outranks the server cache', () => {
  reset(
    {
      cachedGrowthBookFeatures: { [GATE]: true },
      growthBookOverrides: { [GATE]: false },
    },
    true,
  )
  assert.equal(gate(GATE, true), false)
})

test('telemetry on, no caches: default applies; omitted default keeps false', () => {
  reset({}, true)
  assert.equal(gate(GATE, true), true)
  assert.equal(gate('tengu_scratch'), false)
})

test('telemetry off short-circuits before cache reads (documented semantics)', () => {
  // With 1P logging off there is no fresh server signal, so the caller's
  // default is authoritative; the env kill switch remains the escape hatch.
  reset({ cachedGrowthBookFeatures: { [GATE]: false } }, false)
  assert.equal(gate(GATE, true), true)
  assert.equal(gate(GATE), false)
})

test('adjacent query gates are unchanged', () => {
  reset()
  const gates = buildQueryConfig().gates
  assert.equal(gates.isAnt, true)
  assert.equal(gates.fastModeEnabled, true)
  assert.equal(gates.emitToolUseSummaries, false)
})
