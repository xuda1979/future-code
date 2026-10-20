import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { handleRequest, releaseReady, salesReady } from '../commerce/service.mjs';
import { digest, open } from '../commerce/crypto.mjs';
import { verifyToken } from '../client/license.mjs';
import { PLATFORMS } from '../catalog.mjs';

function database() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../commerce/schema.sql', import.meta.url), 'utf8'));
  const wrap = (sql, values = []) => ({ bind: (...args) => wrap(sql, args), first: async () => db.prepare(sql).get(...values) || null, run: async () => db.prepare(sql).run(...values) });
  return { raw: db, prepare: sql => wrap(sql), batch: async items => { db.exec('BEGIN'); try { const r = []; for (const item of items) r.push(await item.run()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
function fixture() {
  const pair = generateKeyPairSync('ed25519'); const now = Date.now();
  const env = { DB: database(), SALES_ENABLED: '1', PUBLIC_ORIGIN: 'https://product.example', STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_PRICE_SOLO: 'price_solo', STRIPE_PRICE_TEAM: 'price_team', LICENSE_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), LICENSE_STORAGE_KEY: randomBytes(32).toString('base64url'), RESEND_API_KEY: 'test-only', MAIL_FROM: 'test@example.com' };
  const manifest = { status: 'released', version: 'test', sourceRights: { status: 'reviewed', evidence: 'TEST FIXTURE ONLY' }, assets: Object.fromEntries(PLATFORMS.map(p => [p, { url: 'https://example.com/' + p, sha256: 'a'.repeat(64), tested: true }])) };
  const session = { id: 'cs_test_abcdefgh1234', mode: 'payment', status: 'complete', payment_status: 'paid', livemode: false, created: Math.floor(now / 1000), customer_details: { email: 'buyer@example.com' }, payment_intent: 'pi_fixture', amount_subtotal: 2900, currency: 'usd', line_items: { has_more: false, data: [{ quantity: 1, price: { id: 'price_solo', unit_amount: 2900, currency: 'usd' } }] } };
  const emails = []; const calls = []; let failEmail = false;
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('checkout/sessions/')) return Response.json(session);
    if (url.endsWith('/checkout/sessions')) return Response.json({ url: 'https://checkout.stripe.com/c/pay/test-session' });
    if (url.includes('payment_intents/')) return Response.json({ status: 'succeeded', latest_charge: { paid: true, created: Math.floor(now / 1000), refunded: false, disputed: false } });
    if (url === 'https://api.resend.com/emails') { if (failEmail) return new Response('', { status: 500 }); emails.push(JSON.parse(options.body)); return Response.json({ id: 'mail_1' }); }
    throw new Error('Unexpected external request');
  };
  const request = (path, data, headers = {}) => new Request('https://product.example' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5', ...headers }, body: JSON.stringify(data) });
  const call = (path, data, headers) => handleRequest(request(path, data, headers), env, manifest, { fetcher, now });
  const event = (type = 'checkout.session.completed', object = { id: session.id, metadata: { product: 'future-code' } }) => ({ id: crypto.randomUUID(), type, livemode: false, data: { object } });
  const webhook = async (value = event(), mutate = {}) => { const raw = JSON.stringify(value); const stamp = Math.floor(now / 1000); const signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(stamp + '.' + raw).digest('hex'); return handleRequest(new Request('https://product.example/api/stripe/webhook', { method: 'POST', body: raw, headers: { 'stripe-signature': 't=' + stamp + ',v1=' + signature, ...mutate } }), env, manifest, { fetcher, now }); };
  return { env, manifest, now, session, emails, calls, call, webhook, event, pair, setFailEmail: v => { failEmail = v; } };
}
const keyFrom = f => f.emails[0].text.match(/License key: (FC1-[A-Za-z0-9_-]+)/)[1];

test('prelaunch has no downloads or checkout, and cannot call a payment provider', async () => {
  const f = fixture(); f.manifest.status = 'prelaunch';
  assert.equal(releaseReady(f.manifest), false);
  const r = await f.call('/api/checkout', { plan: 'solo', requestId: crypto.randomUUID() }, { origin: f.env.PUBLIC_ORIGIN });
  assert.equal(r.status, 503); assert.equal(f.calls.length, 0);
  const c = await handleRequest(new Request('https://product.example/api/catalog'), f.env, f.manifest);
  assert.deepEqual((await c.json()).downloads, {});
});
test('incomplete platform evidence and missing secrets prevent selling', () => {
  const f = fixture(); assert.equal(salesReady(f.env, f.manifest), true);
  delete f.manifest.assets['windows-x64']; assert.equal(salesReady(f.env, f.manifest), false);
  f.manifest.assets['windows-x64'] = { url: 'http://example.com/file', sha256: 'a'.repeat(64), tested: true }; assert.equal(releaseReady(f.manifest), false);
});
test('preview downloads remain available without enabling payment or activation claims', async () => {
  const f = fixture(); f.manifest.status = 'preview'; f.manifest.sourceRights = { status: 'unverified', evidence: null };
  const c = await (await handleRequest(new Request('https://product.example/api/catalog'), f.env, f.manifest)).json();
  assert.equal(c.status, 'preview'); assert.equal(c.salesEnabled, false);
  assert.deepEqual(Object.keys(c.downloads).sort(), [...PLATFORMS].sort());
  assert.equal((await f.call('/api/checkout', { plan: 'solo', requestId: crypto.randomUUID() }, { origin: f.env.PUBLIC_ORIGIN })).status, 503);
  assert.equal(f.calls.length, 0);
  f.manifest.assets['windows-x64'].url = 'http://example.com/file';
  f.manifest.assets['macos-x64'].sha256 = 'invalid';
  f.manifest.assets['macos-arm64'].tested = false;
  const invalid = await (await handleRequest(new Request('https://product.example/api/catalog'), f.env, f.manifest)).json();
  assert.deepEqual(Object.keys(invalid.downloads), ['ubuntu-x64']);
});
test('checkout uses only server prices and stable idempotency, refuses cross-origin requests', async () => {
  const f = fixture(); const id = crypto.randomUUID();
  assert.equal((await f.call('/api/checkout', { plan: 'solo', requestId: id, price: 1 }, { origin: f.env.PUBLIC_ORIGIN })).status, 200);
  const call = f.calls[0]; assert.equal(call.options.body.get('line_items[0][price]'), 'price_solo');
  assert.equal(call.options.headers['Idempotency-Key'], 'future-code/solo/' + id);
  assert.equal((await f.call('/api/checkout', { plan: 'solo', requestId: id }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.call('/api/checkout', { plan: '__proto__', requestId: id }, { origin: f.env.PUBLIC_ORIGIN })).status, 400);
});
test('success-page status reveals no email or license and never trusts a redirect as payment proof', async () => {
  const f = fixture();
  assert.deepEqual(await (await f.call('/api/order/status', { sessionId: f.session.id })).json(), { state: 'processing' });
  await f.webhook();
  assert.deepEqual(await (await f.call('/api/order/status', { sessionId: f.session.id })).json(), { state: 'delivered' });
  await f.webhook(f.event('charge.refunded', { payment_intent: 'pi_fixture', refunded: true }));
  assert.deepEqual(await (await f.call('/api/order/status', { sessionId: f.session.id })).json(), { state: 'reversed' });
});
test('tampered or stale webhook never fulfills an order', async () => {
  const f = fixture();
  assert.equal((await f.webhook(f.event(), { 'stripe-signature': 't=1,v1=' + 'a'.repeat(64) })).status, 400);
  assert.equal(f.calls.length, 0);
});
test('duplicate paid events create one encrypted key and send one email', async () => {
  const f = fixture(); assert.equal((await f.webhook()).status, 200); assert.equal((await f.webhook()).status, 200);
  assert.equal(f.emails.length, 1);
  assert.equal(f.env.DB.raw.prepare('SELECT COUNT(*) n FROM orders').get().n, 1);
  const key = keyFrom(f); const order = f.env.DB.raw.prepare('SELECT * FROM orders').get();
  assert.equal(order.key_hash, await digest(key)); assert.equal(await open(order.key_cipher, f.env.LICENSE_STORAGE_KEY), key);
  assert.ok(!order.key_cipher.includes(key));
  assert.equal(f.calls.find(c => c.url.includes('resend')).options.headers['Idempotency-Key'], 'future-code-license/' + f.session.id);
});
test('failed email retries the same order and license', async () => {
  const f = fixture(); f.setFailEmail(true); assert.equal((await f.webhook()).status, 502);
  const before = f.env.DB.raw.prepare('SELECT key_hash FROM orders').get().key_hash;
  f.setFailEmail(false); assert.equal((await f.webhook()).status, 200);
  assert.equal(await digest(keyFrom(f)), before); assert.equal(f.emails.length, 1);
});
test('annual term begins at successful payment rather than checkout creation', async () => {
  const f = fixture(); f.session.created -= 86400;
  assert.equal((await f.webhook()).status, 200);
  const order = f.env.DB.raw.prepare('SELECT created,expires FROM orders').get();
  assert.equal(order.created, Math.floor(f.now / 1000) * 1000);
  assert.equal(order.expires - order.created, 365 * 86400000);
});
test('database failure rolls back both license and delivery record', async () => {
  const f = fixture(); f.env.DB.raw.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.equal((await f.webhook()).status, 503);
  assert.equal(f.env.DB.raw.prepare('SELECT COUNT(*) n FROM orders').get().n, 0); assert.equal(f.emails.length, 0);
});
test('unpaid checkout, incorrect price/amount/currency and mode never issue a key', async () => {
  for (const change of [{ payment_status: 'unpaid' }, { amount_subtotal: 1 }, { currency: 'eur' }, { mode: 'subscription' }, { livemode: true }]) {
    const f = fixture(); Object.assign(f.session, change); await f.webhook(); assert.equal(f.emails.length, 0);
  }
  const f = fixture(); f.session.line_items.data[0].quantity = 2; assert.equal((await f.webhook()).status, 400); assert.equal(f.emails.length, 0);
});
test('delayed successful payment fulfills; unrelated Stripe products are ignored', async () => {
  const f = fixture(); assert.equal((await f.webhook(f.event('checkout.session.async_payment_succeeded'))).status, 200); assert.equal(f.emails.length, 1);
  const g = fixture(); assert.equal((await g.webhook(g.event('checkout.session.completed', { id: g.session.id, metadata: { product: 'other' } }))).status, 200); assert.equal(g.calls.length, 0);
});
test('activation is signed, device bound, capped, refreshable at cap and transferable', async () => {
  const f = fixture(); await f.webhook(); const key = keyFrom(f); const device = '1'.repeat(64);
  const r = await f.call('/api/license/activate', { key, device }); assert.equal(r.status, 200);
  const { token } = await r.json(); const claims = verifyToken(token, f.pair.publicKey, device, f.now); assert.equal(claims.plan, 'solo');
  assert.equal((await f.call('/api/license/activate', { key, device: '2'.repeat(64) })).status, 200);
  assert.equal((await f.call('/api/license/activate', { key, device: '3'.repeat(64) })).status, 409);
  assert.equal((await f.call('/api/license/activate', { key, device })).status, 200);
  assert.equal((await f.call('/api/license/deactivate', { key, device })).status, 200);
  assert.equal((await f.call('/api/license/activate', { key, device: '3'.repeat(64) })).status, 200);
  assert.throws(() => verifyToken(token, f.pair.publicKey, '4'.repeat(64), f.now));
  assert.throws(() => verifyToken(token, f.pair.publicKey, device, f.now + 86400001));
  assert.throws(() => verifyToken(token.slice(0, -5) + 'aaaaa', f.pair.publicKey, device, f.now));
});
test('refund/dispute before checkout is durable and prevents activation', async () => {
  for (const type of ['charge.refunded', 'charge.dispute.created']) {
    const f = fixture(); await f.webhook(f.event(type, { payment_intent: 'pi_fixture', refunded: true })); await f.webhook();
    assert.equal(f.emails.length, 0);
    const order = f.env.DB.raw.prepare('SELECT key_cipher FROM orders').get(); const key = await open(order.key_cipher, f.env.LICENSE_STORAGE_KEY);
    assert.equal((await f.call('/api/license/activate', { key, device: '1'.repeat(64) })).status, 403);
  }
});
test('oversized bodies and repeated key guessing are bounded', async () => {
  const f = fixture(); assert.equal((await f.call('/api/license/activate', { key: 'x'.repeat(9000) })).status, 413);
  let response; for (let i = 0; i < 21; i++) response = await f.call('/api/license/activate', { key: 'FC1-' + 'a'.repeat(43), device: '1'.repeat(64) });
  assert.equal(response.status, 429);
});
