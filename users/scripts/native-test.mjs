// Native integration test. Stripe, email and LLM responses are local fixtures.
// The fixture signing key is ephemeral. It is never used by the release build.
import assert from 'node:assert/strict';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, createHmac, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { sqliteBinding, createCommerceServer } from '../commerce/server.mjs';
import { PLATFORMS } from '../catalog.mjs';

const target = process.argv[2];
assert.ok(PLATFORMS.includes(target), 'Pass a supported native platform');
const binaryName = process.platform === 'win32' ? 'future-code.exe' : 'future-code';
const production = resolve('dist/users', target, binaryName);
const scratch = mkdtempSync(join(tmpdir(), 'future-code-native-'));
const project = join(scratch, 'project'); mkdirSync(project);
writeFileSync(join(project, 'fixture.txt'), 'native-file-evidence\n');
const cert = readFileSync(new URL('../tests/fixtures/localhost-cert.pem', import.meta.url));
const certPath = resolve('users/tests/fixtures/localhost-cert.pem');
const report = { platform: target, artifactSha256: createHash('sha256').update(readFileSync(production)).digest('hex'), productionBinaryChecks: [], fixtureChecks: [], livePaymentsVerified: false };
const reportPath = resolve('dist/verification', target + '.json'); mkdirSync(resolve('dist/verification'), { recursive: true });
const baseEnv = { ...process.env, FUTURE_CONFIG_DIR: join(scratch, 'runtime-config'), FUTURE_LICENSE_STATE_DIR: join(scratch, 'license'), NODE_EXTRA_CA_CERTS: certPath, NO_PROXY: (process.env.NO_PROXY || '') + ',127.0.0.1,localhost', FUTURE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' };
async function run(binary, args, input = '', extra = {}) {
  return new Promise((done, reject) => {
    const child = spawn(binary, args, { cwd: project, env: { ...baseEnv, ...extra }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('Timed out: ' + args.slice(0, 2).join(' '))); }, 45000);
    child.stdout.on('data', b => { stdout += b; if (stdout.length > 2_000_000) child.kill(); });
    child.stderr.on('data', b => { stderr += b; if (stderr.length > 2_000_000) child.kill(); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function check(kind, name, action) {
  const started = Date.now();
  try { await action(); report[kind].push({ name, passed: true, milliseconds: Date.now() - started }); console.log('PASS ' + name); }
  catch (error) { report[kind].push({ name, passed: false, error: String(error.message).slice(0, 2000) }); throw error; }
}
const pair = generateKeyPairSync('ed25519');
const DB = sqliteBinding(':memory:');
const env = { DB, PUBLIC_ORIGIN: '', SALES_ENABLED: '1', STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_PRICE_SOLO: 'price_fixture_solo', STRIPE_PRICE_TEAM: 'price_fixture_team', LICENSE_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), LICENSE_STORAGE_KEY: randomBytes(32).toString('base64url'), RESEND_API_KEY: 'fixture-only', MAIL_FROM: 'test@example.com' };
const manifest = { version: 'fixture', status: 'released', sourceRights: { status: 'reviewed', evidence: 'TEST FIXTURE ONLY' }, assets: Object.fromEntries(PLATFORMS.map(p => [p, { url: 'https://example.com/' + p, sha256: 'a'.repeat(64), tested: true }])) };
const session = { id: 'cs_test_nativeabcdefgh1234', mode: 'payment', status: 'complete', payment_status: 'unpaid', livemode: false, created: Math.floor(Date.now() / 1000), customer_details: { email: 'fixture@example.com' }, payment_intent: 'pi_fixture', amount_subtotal: 2900, currency: 'usd', line_items: { has_more: false, data: [{ quantity: 1, price: { id: env.STRIPE_PRICE_SOLO, unit_amount: 2900, currency: 'usd' } }] } };
const emails = []; let refunded = false, badIngress = false;
const provider = { requests: 0, transientFailures: 0, readEvidence: false, toolResults: [] };
const fetcher = async (url, options) => {
  if (url.includes('/checkout/sessions/')) return Response.json(session);
  if (url.endsWith('/checkout/sessions')) return Response.json({ url: 'https://checkout.stripe.com/c/pay/fixture' });
  if (url.includes('/payment_intents/')) return Response.json({ status: 'succeeded', latest_charge: { paid: true, created: session.created, refunded, disputed: false } });
  if (url === 'https://api.resend.com/emails') { emails.push(JSON.parse(options.body)); return Response.json({ id: 'fixture-email' }); }
  throw Error('Unexpected external request in native test');
};
const commerce = createCommerceServer(env, manifest, { fetcher });
const server = httpsServer({ cert, key: readFileSync(new URL('../tests/fixtures/localhost-key.pem', import.meta.url)) }, async (req, res) => {
  if (req.url?.startsWith('/v1/')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v1/models')) return res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6', type: 'model', display_name: 'Fixture model' }], has_more: false }));
    if (req.url.includes('count_tokens')) return res.end('{"input_tokens":10}');
    provider.requests++;
    if (provider.transientFailures === 0) { provider.transientFailures++; res.writeHead(503, { 'Retry-After': '0' }); return res.end('{"type":"error","error":{"type":"overloaded_error","message":"Fixture transient failure"}}'); }
    provider.toolResults = (body.messages || []).flatMap(m => (Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'tool_result').map(c => ({ error: c.is_error || false, content: JSON.stringify(c.content).slice(0, 1500) })));
    provider.readEvidence ||= provider.toolResults.some(c => !c.error && c.content.includes('native-file-evidence'));
    const tool = (body.tools || []).find(t => t.name === 'Read');
    const content = provider.readEvidence ? [{ type: 'text', text: 'FUTURE_CODE_E2E_OK' }] : tool ? [{ type: 'tool_use', id: 'toolu_fixture_read', name: tool.name, input: { file_path: join(project, 'fixture.txt') } }] : [{ type: 'text', text: 'Expected Read tool was not available' }];
    const reason = content[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model || 'claude-sonnet-4-6', content, stop_reason: reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
    if (!body.stream) return res.end(JSON.stringify(message));
    res.setHeader('Content-Type', 'text/event-stream');
    const emit = data => res.write('event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n');
    emit({ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    emit({ type: 'content_block_start', index: 0, content_block: content[0].type === 'tool_use' ? { ...content[0], input: {} } : { type: 'text', text: '' } });
    emit({ type: 'content_block_delta', index: 0, delta: content[0].type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(content[0].input) } : { type: 'text_delta', text: content[0].text } });
    emit({ type: 'content_block_stop', index: 0 });
    emit({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 10 } });
    emit({ type: 'message_stop' }); res.end(); return;
  }
  if (badIngress && req.url === '/api/license/activate') { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('Fixture unavailable'); return; }
  commerce.emit('request', req, res);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
env.PUBLIC_ORIGIN = 'https://127.0.0.1:' + server.address().port;
async function post(path, data, signature) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return new Promise((done, reject) => {
    const req = httpsRequest(env.PUBLIC_ORIGIN + path, { method: 'POST', ca: cert, headers: { 'Content-Type': 'application/json', Origin: env.PUBLIC_ORIGIN, ...(signature ? { 'Stripe-Signature': signature } : {}) } }, res => {
      let raw = ''; res.on('data', b => { raw += b; }); res.on('end', () => done({ status: res.statusCode, json: JSON.parse(raw) }));
    }); req.on('error', reject); req.end(body);
  });
}
async function webhook(type = 'checkout.session.completed') {
  const raw = JSON.stringify({ id: 'evt_fixture', type, livemode: false, data: { object: type === 'charge.refunded' ? { payment_intent: session.payment_intent, refunded: true } : { id: session.id, metadata: { product: 'future-code' } } } });
  const time = Math.floor(Date.now() / 1000);
  return post('/api/stripe/webhook', raw, 't=' + time + ',v1=' + createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(time + '.' + raw).digest('hex'));
}
const fixtureBinary = join(scratch, binaryName);
const configPath = resolve('users/client/config.mjs'); const originalConfig = readFileSync(configPath, 'utf8');
try {
  await check('productionBinaryChecks', 'version and full CLI help', async () => {
    assert.equal((await run(production, ['--version'])).code, 0);
    const help = await run(production, ['--help']); assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /--output-format/);
  });
  await check('productionBinaryChecks', 'unlicensed runtime refuses execution', async () => { const r = await run(production, ['--ops', 'state']); assert.equal(r.code, 1); assert.match(r.stderr, /Activate with/); });
  await check('fixtureChecks', 'compile the same entrypoint with isolated test service and public key', async () => {
    try {
      writeFileSync(configPath, 'export const LICENSE_ORIGIN = ' + JSON.stringify(env.PUBLIC_ORIGIN) + ';\nexport const LICENSE_PUBLIC_KEY = ' + JSON.stringify(pair.publicKey.export({ type: 'spki', format: 'pem' })) + ';\n');
      const built = spawnSync(process.env.BUN_BIN || 'bun', ['build', 'users/entrypoint.ts', '--compile', '--minify', '--bytecode', '--format=cjs', '--outfile=' + fixtureBinary], { stdio: 'inherit', shell: false });
      assert.equal(built.status, 0, 'Fixture compilation failed');
    } finally { writeFileSync(configPath, originalConfig); }
  });
  let key;
  await check('fixtureChecks', 'checkout, unpaid refusal, paid webhook, one email and duplicate delivery', async () => {
    assert.equal((await post('/api/checkout', { plan: 'solo', requestId: crypto.randomUUID() })).status, 200);
    assert.equal((await webhook()).status, 200); assert.equal(emails.length, 0);
    session.payment_status = 'paid'; assert.equal((await webhook()).status, 200); assert.equal((await webhook()).status, 200); assert.equal(emails.length, 1);
    key = emails[0].text.match(/License key: (FC1-[A-Za-z0-9_-]+)/)[1];
    assert.deepEqual((await post('/api/order/status', { sessionId: session.id })).json, { state: 'delivered' });
  });
  await check('fixtureChecks', 'native key activation, signed receipt and device cap', async () => {
    const a = await run(fixtureBinary, ['license', 'activate'], key + '\n'); assert.equal(a.code, 0, a.stderr);
    assert.equal(JSON.parse((await run(fixtureBinary, ['license', 'status'])).stdout).active, true);
    assert.equal((await run(fixtureBinary, ['license', 'activate'], key + '\n', { FUTURE_LICENSE_STATE_DIR: join(scratch, 'device-2') })).code, 0);
    const capped = await run(fixtureBinary, ['license', 'activate'], key + '\n', { FUTURE_LICENSE_STATE_DIR: join(scratch, 'device-3') }); assert.equal(capped.code, 1); assert.match(capped.stderr, /Device limit/);
  });
  await check('fixtureChecks', 'licensed native runtime persists and reloads a real task', async () => {
    const r = await run(fixtureBinary, ['--ops', 'task', JSON.stringify({ id: 'native-test', status: 'queued', goal: 'Native integration fixture' })]); assert.equal(r.code, 0, r.stderr);
    const state = await run(fixtureBinary, ['--ops', 'state']); assert.equal(state.code, 0, state.stderr); assert.equal(JSON.parse(state.stdout).tasks['native-test'].status, 'queued');
  });
  await check('fixtureChecks', 'headless model request, transient recovery and actual Read tool round trip', async () => {
    const r = await run(fixtureBinary, ['--bare', '-p', '--model', 'claude-sonnet-4-6', '--tools', 'Read', '--permission-mode', 'dontAsk', '--max-turns', '3', '--system-prompt', 'Read fixture.txt and report its contents.', 'Read fixture.txt then reply FUTURE_CODE_E2E_OK.'], '', { FUTURE_BASE_URL: env.PUBLIC_ORIGIN, FUTURE_API_KEY: 'fixture-provider-key', FUTURE_MODEL: 'claude-sonnet-4-6', FUTURE_CODE_EFFORT_LEVEL: 'low' });
    assert.equal(r.code, 0, r.stderr + '\n' + r.stdout + '\nFixture provider: ' + JSON.stringify(provider)); assert.match(r.stdout, /FUTURE_CODE_E2E_OK/); assert.equal(provider.readEvidence, true); assert.ok(provider.requests >= 3); assert.equal(provider.transientFailures, 1);
  });
  await check('fixtureChecks', 'tampered receipt rejected and service HTML failure remains actionable', async () => {
    const file = join(baseEnv.FUTURE_LICENSE_STATE_DIR, 'receipt.json'); const original = readFileSync(file, 'utf8'); const data = JSON.parse(original); data.token += 'x'; writeFileSync(file, JSON.stringify(data));
    assert.equal(JSON.parse((await run(fixtureBinary, ['license', 'status'])).stdout).active, false); writeFileSync(file, original);
    badIngress = true; const r = await run(fixtureBinary, ['license', 'activate'], key + '\n', { FUTURE_LICENSE_STATE_DIR: join(scratch, 'device-3') }); badIngress = false;
    assert.equal(r.code, 1); assert.match(r.stderr, /License service unavailable \(HTTP 503\)/);
  });
  await check('fixtureChecks', 'device deactivation and refunded payment reject new activation', async () => {
    assert.equal((await run(fixtureBinary, ['license', 'deactivate'])).code, 0);
    assert.equal(JSON.parse((await run(fixtureBinary, ['license', 'status'])).stdout).active, false);
    refunded = true; assert.equal((await webhook('charge.refunded')).status, 200);
    const r = await run(fixtureBinary, ['license', 'activate'], key + '\n'); assert.equal(r.code, 1); assert.match(r.stderr, /unavailable|reversed|inactive/i);
  });
  report.passed = true;
} catch (error) { report.passed = false; throw error; }
finally {
  writeFileSync(configPath, originalConfig);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  server.closeAllConnections(); await new Promise(done => server.close(done)); DB.raw.close(); rmSync(scratch, { recursive: true, force: true });
}
