import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { saveModelEndpoint, readModelEndpoint, listModelEndpoints, modelEndpointClientOptions, checkModelEndpointProxy } from '../../src/utils/model/modelEndpoints.ts'
import { parseEndpointCommand } from '../../src/commands/model/endpointCommand.ts'
import { withModelValidationDeadline } from '../../src/utils/model/validationDeadline.ts'
import { runModelEndpointCLI } from '../../src/commands/model/endpointCli.ts'

function config<T>(fn: () => T): T {
  const previous = process.env.FUTURE_CONFIG_DIR
  const dir = mkdtempSync(join(tmpdir(), 'model-endpoint-'))
  process.env.FUTURE_CONFIG_DIR = dir
  try { return fn() }
  finally {
    if (previous === undefined) delete process.env.FUTURE_CONFIG_DIR; else process.env.FUTURE_CONFIG_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
}
const profile = { version: 1 as const, model: 'Example/Model-A', baseUrl: 'https://example.invalid/v1', protocol: 'anthropic' as const, apiKey: 'test-key-only' }

test('saving needs no provider, preserves case, persists privately and replaces atomically', () => config(() => {
  saveModelEndpoint(profile)
  saveModelEndpoint({ ...profile, model: 'Other-Model' })
  saveModelEndpoint({ ...profile, apiKey: 'replacement-test-key' })
  assert.equal(readModelEndpoint(profile.model)?.apiKey, 'replacement-test-key')
  assert.equal(readModelEndpoint('example/model-a'), undefined)
  assert.equal(listModelEndpoints().length, 2)
  assert.ok(!JSON.stringify(listModelEndpoints()).includes('key'))
  const dir = join(process.env.FUTURE_CONFIG_DIR!, 'model-endpoints')
  assert.equal(readdirSync(dir).length, 2)
  for (const file of readdirSync(dir)) assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8')).version, 1)
}))

test('bad input fails locally without echoing secrets or damaging previous configuration', () => config(() => {
  saveModelEndpoint(profile)
  for (const input of [
    { ...profile, baseUrl: 'https://user:secret@example.invalid' },
    { ...profile, baseUrl: 'https://example.invalid?api_key=secret' },
    { ...profile, baseUrl: 'file:///tmp/key' }, { ...profile, model: 'best' },
    { ...profile, model: 'bad\nmodel' }, { ...profile, model: 'x[1m]' },
    { ...profile, apiKey: '\nsecret' }, { ...profile, apiKey: '' },
  ]) assert.throws(() => saveModelEndpoint(input), error => !String(error).includes('secret'))
  assert.deepEqual(readModelEndpoint(profile.model), profile)
}))

test('malformed or oversized saved profiles fail closed', () => config(() => {
  saveModelEndpoint(profile)
  const dir = join(process.env.FUTURE_CONFIG_DIR!, 'model-endpoints')
  const path = join(dir, readdirSync(dir)[0]!)
  for (const data of ['not-json-secret', 'x'.repeat(16385), JSON.stringify({ ...profile, model: 'different' })]) {
    writeFileSync(path, data)
    assert.throws(() => readModelEndpoint(profile.model), error => !String(error).includes(profile.apiKey))
    assert.deepEqual(listModelEndpoints(), [])
  }
}))

test('endpoint parser reads key from an environment variable without a shell or raw key argv', () => {
  process.env.MODEL_CONFIG_TEST_KEY = 'test-key-only'
  try {
    assert.deepEqual(parseEndpointCommand('add Example/Model-A https://example.invalid/v1 --protocol anthropic --api-key-env MODEL_CONFIG_TEST_KEY'), profile)
    assert.equal(parseEndpointCommand('add Model-A https://example.invalid/v1').apiKey, undefined)
    for (const args of ['add', 'add x https://example.invalid --api-key test-key-only', 'add x https://example.invalid --protocol invalid', 'add x https://example.invalid --protocol openai --protocol anthropic']) assert.throws(() => parseEndpointCommand(args), error => !String(error).includes('test-key-only'))
  } finally { delete process.env.MODEL_CONFIG_TEST_KEY }
})

test('endpoint routing uses only the chosen credentials and rejects nonlocal OpenAI proxies', () => config(() => {
  saveModelEndpoint(profile)
  assert.deepEqual(modelEndpointClientOptions(profile.model), { protocol: 'anthropic', baseURL: 'https://example.invalid', apiKey: profile.apiKey, authToken: null })
  assert.equal(modelEndpointClientOptions('unknown'), undefined)
  saveModelEndpoint({ ...profile, protocol: 'openai' })
  const previous = process.env.FUTURE_BASE_URL
  try {
    process.env.FUTURE_BASE_URL = 'https://remote.invalid'
    assert.throws(() => modelEndpointClientOptions(profile.model), /local translation proxy/)
    process.env.FUTURE_BASE_URL = 'http://127.0.0.1:12345'
    const options = modelEndpointClientOptions(profile.model)!
    assert.equal(options.baseURL, process.env.FUTURE_BASE_URL)
    assert.notEqual(options.apiKey, profile.apiKey)
    assert.equal(options.authToken, null)
  } finally { if (previous === undefined) delete process.env.FUTURE_BASE_URL; else process.env.FUTURE_BASE_URL = previous }
}))

test('old translation proxies are rejected before sending any model request', async () => {
  let supported = false
  const server = createServer((_, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, ...(supported && { model_endpoints: 1 }) })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    await assert.rejects(checkModelEndpointProxy(`http://127.0.0.1:${address.port}`), /Update and restart/)
    supported = true
    await checkModelEndpointProxy(`http://127.0.0.1:${address.port}`)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('deadline bounds a hung initialization even if it ignores abort and later succeeds', async () => {
  let requestSignal: AbortSignal | undefined
  let finish: (value: string) => void = () => {}
  const started = performance.now()
  await assert.rejects(withModelValidationDeadline(signal => {
    requestSignal = signal
    return new Promise<string>(resolve => { finish = resolve })
  }, undefined, 25), /timed out/)
  assert.equal(requestSignal?.aborted, true)
  assert.ok(performance.now() - started < 2000)
  finish('late success')
  await new Promise(resolve => setImmediate(resolve))
})

test('cancellation prevents pre-cancelled work and aborts an active probe', async () => {
  const stopped = new AbortController(); stopped.abort()
  let calls = 0
  await assert.rejects(withModelValidationDeadline(async () => { calls++; return true }, stopped.signal), /cancelled/)
  assert.equal(calls, 0)
  const controller = new AbortController()
  const pending = withModelValidationDeadline(signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')))
    setImmediate(() => controller.abort())
  }), controller.signal)
  await assert.rejects(pending, /cancelled/)
})

test('ordinary successful probes complete without waiting for the deadline', async () => {
  assert.equal(await withModelValidationDeadline(async () => 'ok'), 'ok')
})

test('headless configuration uses the same local save path and requires an environment key', () => config(() => {
  process.env.MODEL_CONFIG_TEST_KEY = profile.apiKey
  try {
    const output = runModelEndpointCLI(['add', profile.model, profile.baseUrl, '--protocol', 'anthropic', '--api-key-env', 'MODEL_CONFIG_TEST_KEY'])
    assert.match(output, /Saved endpoint/)
    assert.ok(!output.includes(profile.apiKey))
    assert.deepEqual(readModelEndpoint(profile.model), profile)
    assert.match(runModelEndpointCLI(['list']), /Example\/Model-A/)
    assert.throws(() => runModelEndpointCLI(['add', 'Other-Model', profile.baseUrl]), /--api-key-env/)
  } finally { delete process.env.MODEL_CONFIG_TEST_KEY }
}))

test('installed wrapper bypasses broken old configuration and proxy startup for endpoint setup', () => config(() => {
  const binary = join(process.env.FUTURE_CONFIG_DIR!, 'stub-binary')
  writeFileSync(binary, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', { mode: 0o700 })
  const result = spawnSync('bash', [fileURLToPath(new URL('../../future-code.sh', import.meta.url)), '--model-endpoint', 'list'], {
    encoding: 'utf8', timeout: 2000,
    env: { ...process.env, FUTURE_CODE_BIN: binary, FUTURE_CODE_CONFIG_FILE: '/nonexistent/config', FUTURE_CODE_PERSIST: '1' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '--model-endpoint\nlist\n')
  assert.equal(result.stderr, '')
}))
