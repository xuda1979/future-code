import { PLANS, PLATFORMS, PRODUCT } from '../catalog.mjs';
import { availableDownloads } from '../downloads.mjs';
import { assessMerchant, stripeLiveMode } from './merchant.mjs';
import { digest, randomKey, seal, open, signClaims, verifyStripe } from './crypto.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const isEmail = v => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const idPattern = /^cs_(?:test_|live_)?[A-Za-z0-9]{8,}$/;
export function releaseReady(manifest) {
  return manifest?.status === 'released' && manifest.sourceRights?.status === 'reviewed'
    && typeof manifest.sourceRights.evidence === 'string' && manifest.sourceRights.evidence.trim().length > 0
    && PLATFORMS.every(p => {
      const a = manifest.assets?.[p];
      try { const u = new URL(a?.url); return u.protocol === 'https:' && !u.username && !u.password && /^[a-f\d]{64}$/.test(a.sha256) && a.tested === true; } catch { return false; }
    });
}
export function salesReady(env, manifest) {
  return env.SALES_ENABLED === '1' && releaseReady(manifest)
    && ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'LICENSE_PRIVATE_KEY', 'LICENSE_STORAGE_KEY', 'RESEND_API_KEY', 'MAIL_FROM', 'PUBLIC_ORIGIN', 'STRIPE_PRICE_SOLO', 'STRIPE_PRICE_TEAM'].every(k => !!env[k]);
}
async function stripe(env, fetcher, path, options = {}) {
  const response = await fetcher('https://api.stripe.com/v1/' + path, {
    ...options, signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, ...(options.headers || {}) },
  });
  if (!response.ok) throw new HttpError(502, 'Payment provider is unavailable. Please retry.');
  return response.json();
}
async function body(request, limit = 8192) {
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, 'Request too large.');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Request too large.'); }
    chunks.push(value);
  }
  const joined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(joined);
}
async function readJson(request) {
  try { return JSON.parse(await body(request)); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid request.'); }
}
async function rateLimit(env, request, scope, limit, now) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = await digest(scope + ':' + ip + ':' + Math.floor(now / 60000));
  const row = await env.DB.prepare('INSERT INTO rate_limits(bucket,hits,expires) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 RETURNING hits').bind(bucket, now + 120000).first();
  if (row.hits > limit) throw new HttpError(429, 'Too many attempts. Please wait one minute.');
  // Bounded lifetime; no raw IP addresses are persisted.
  await env.DB.prepare('DELETE FROM rate_limits WHERE expires < ?').bind(now).run();
}
async function deliver(env, orderId, fetcher, now) {
  const lease = crypto.randomUUID();
  const claimed = await env.DB.prepare('UPDATE deliveries SET lease_until=?,lease_token=? WHERE order_id=? AND sent=0 AND lease_until<? RETURNING order_id').bind(now + 60000, lease, orderId, now).first();
  if (!claimed) {
    const prior = await env.DB.prepare('SELECT sent FROM deliveries WHERE order_id=?').bind(orderId).first();
    if (prior?.sent) return;
    throw new HttpError(503, 'License email is being delivered.');
  }
  try {
    const order = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first();
    if (await env.DB.prepare('SELECT 1 FROM revocations WHERE payment_intent=?').bind(order.payment_intent).first()) return;
    const key = await open(order.key_cipher, env.LICENSE_STORAGE_KEY);
    const plan = PLANS[order.plan];
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': 'future-code-license/' + order.id },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [order.email], subject: 'Your Future Code license and downloads',
        text: `Thank you for purchasing Future Code ${plan.name} from General Algorithmic Technologies Company.\n\nLicense key: ${key}\nValid until: ${new Date(order.expires).toISOString().slice(0, 10)}\nSeats: ${plan.seats}. Active devices: ${plan.devices}.\n\nDownload: ${env.PUBLIC_ORIGIN}/#downloads\nActivate: future-code license activate\nPaste the key at the prompt. Keep it private.\n\nModel API usage is billed separately by your provider. This pass does not renew automatically.\nSupport and refunds: exutechnology@gmail.com\n` }),
    });
    if (!response.ok) throw new HttpError(502, 'License email delivery is delayed.');
    await env.DB.prepare('UPDATE deliveries SET sent=1,lease_until=0 WHERE order_id=? AND lease_token=?').bind(orderId, lease).run();
  } catch (error) {
    await env.DB.prepare('UPDATE deliveries SET lease_until=0 WHERE order_id=? AND lease_token=?').bind(orderId, lease).run();
    throw error;
  }
}
export async function fulfill(env, sessionId, fetcher = fetch, now = Date.now()) {
  if (!idPattern.test(sessionId)) throw new HttpError(400, 'Invalid checkout session.');
  const session = await stripe(env, fetcher, 'checkout/sessions/' + encodeURIComponent(sessionId) + '?expand[]=line_items');
  if (session.id !== sessionId || session.payment_status !== 'paid' || session.status !== 'complete' || session.mode !== 'payment') return { fulfilled: false };
  const live = stripeLiveMode(env.STRIPE_SECRET_KEY);
  if (session.livemode !== live) throw new HttpError(400, 'Payment environment mismatch.');
  const items = session.line_items?.data;
  const entry = Object.entries(PLANS).find(([, p]) => items?.[0]?.price?.id === env[p.priceEnv]);
  if (!entry || items.length !== 1 || session.line_items.has_more || items[0].quantity !== 1) throw new HttpError(400, 'Unexpected product.');
  const [planId, plan] = entry;
  if (session.amount_subtotal !== plan.cents || session.currency !== plan.currency || items[0].price.unit_amount !== plan.cents || items[0].price.currency !== plan.currency) throw new HttpError(400, 'Unexpected payment amount.');
  const email = session.customer_details?.email;
  if (!isEmail(email) || typeof session.payment_intent !== 'string') throw new HttpError(400, 'Missing payment details.');
  const payment = await stripe(env, fetcher, 'payment_intents/' + encodeURIComponent(session.payment_intent) + '?expand[]=latest_charge');
  if (payment.status !== 'succeeded' || !payment.latest_charge?.paid || payment.latest_charge?.refunded || payment.latest_charge?.disputed) return { fulfilled: false };
  const key = randomKey();
  const created = Number(payment.latest_charge.created) * 1000;
  if (!Number.isFinite(created) || created <= 0 || created > now + 300000) throw new HttpError(400, 'Invalid payment time.');
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO orders(id,key_hash,key_cipher,email,plan,payment_intent,created,expires) VALUES (?,?,?,?,?,?,?,?)').bind(sessionId, await digest(key), await seal(key, env.LICENSE_STORAGE_KEY), email, planId, session.payment_intent, created, created + plan.days * 86400000),
    env.DB.prepare('INSERT OR IGNORE INTO deliveries(order_id) VALUES (?)').bind(sessionId),
  ]);
  await deliver(env, sessionId, fetcher, now);
  return { fulfilled: true };
}
async function activate(env, request, fetcher, now) {
  await rateLimit(env, request, 'activate', 20, now);
  const input = await readJson(request);
  if (!/^FC1-[A-Za-z0-9_-]{43}$/.test(input.key || '') || !/^[a-f\d]{64}$/.test(input.device || '')) throw new HttpError(400, 'Invalid key or device.');
  const order = await env.DB.prepare('SELECT * FROM orders WHERE key_hash=?').bind(await digest(input.key)).first();
  if (!order || order.expires <= now || await env.DB.prepare('SELECT 1 FROM revocations WHERE payment_intent=?').bind(order.payment_intent).first()) throw new HttpError(403, 'License is unavailable or expired.');
  // Check the current payment before signing each 24-hour lease. Refunds or disputes
  // invalidate leases at the next online refresh even if a webhook was delayed.
  const payment = await stripe(env, fetcher, 'payment_intents/' + encodeURIComponent(order.payment_intent) + '?expand[]=latest_charge');
  if (payment.status !== 'succeeded' || payment.latest_charge?.refunded || payment.latest_charge?.disputed) throw new HttpError(403, 'Payment is unavailable.');
  const max = PLANS[order.plan].devices;
  await env.DB.prepare('INSERT INTO activations(order_id,device_hash,last_seen) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM activations WHERE order_id=?) < ? ON CONFLICT(order_id,device_hash) DO UPDATE SET last_seen=excluded.last_seen').bind(order.id, input.device, now, order.id, max).run();
  // An existing device must be allowed to refresh when the cap is full.
  await env.DB.prepare('UPDATE activations SET last_seen=? WHERE order_id=? AND device_hash=?').bind(now, order.id, input.device).run();
  if (!await env.DB.prepare('SELECT 1 FROM activations WHERE order_id=? AND device_hash=?').bind(order.id, input.device).first()) throw new HttpError(409, 'Device limit reached. Deactivate another device first.');
  const claims = { v: 1, product: PRODUCT, sub: order.id, device: input.device, plan: order.plan, seats: PLANS[order.plan].seats, iat: Math.floor(now / 1000), exp: Math.floor(Math.min(order.expires, now + 86400000) / 1000) };
  return json({ token: await signClaims(claims, env.LICENSE_PRIVATE_KEY), expires: claims.exp });
}
export async function handleRequest(request, env, manifest, { fetcher = fetch, now = Date.now() } = {}) {
  try {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/catalog') {
      const downloads = availableDownloads(manifest);
      return json({ product: PRODUCT, plans: PLANS, version: manifest.version, salesEnabled: salesReady(env, manifest), downloads, status: releaseReady(manifest) ? 'released' : Object.keys(downloads).length ? 'preview' : 'prelaunch' });
    }
    if (request.method === 'POST' && url.pathname === '/api/stripe/webhook') {
      if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY || !env.DB) throw new HttpError(503, 'Payments are not configured.');
      const raw = await body(request, 524288);
      if (!await verifyStripe(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, now)) throw new HttpError(400, 'Invalid payment signature.');
      let event; try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid payment event.'); }
      if (event.livemode !== stripeLiveMode(env.STRIPE_SECRET_KEY)) throw new HttpError(400, 'Payment environment mismatch.');
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
        if (event.data?.object?.metadata?.product === PRODUCT) await fulfill(env, event.data.object.id, fetcher, now);
      } else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
        const charge = event.data?.object;
        if (charge?.payment_intent && (event.type === 'charge.dispute.created' || charge.refunded === true)) await env.DB.prepare('INSERT OR IGNORE INTO revocations(payment_intent,created) VALUES (?,?)').bind(charge.payment_intent, now).run();
      }
      return json({ received: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/checkout') {
      if (!salesReady(env, manifest)) throw new HttpError(503, 'Commercial checkout is not open yet. No payment has been taken.');
      if (request.headers.get('origin') !== new URL(env.PUBLIC_ORIGIN).origin) throw new HttpError(403, 'Unexpected checkout origin.');
      await rateLimit(env, request, 'checkout', 10, now);
      const input = await readJson(request); const plan = Object.hasOwn(PLANS, input.plan) ? PLANS[input.plan] : null;
      if (!plan || !/^[a-f\d-]{36}$/.test(input.requestId || '')) throw new HttpError(400, 'Invalid plan or request.');
      if (stripeLiveMode(env.STRIPE_SECRET_KEY)) {
        const readiness = assessMerchant(await stripe(env, fetcher, 'account'));
        if (!readiness.ready) throw new HttpError(503, 'Purchasing is paused while merchant payment and bank payout settings are verified. No payment has been taken.');
      }
      const form = new URLSearchParams({ mode: 'payment', 'line_items[0][price]': env[plan.priceEnv], 'line_items[0][quantity]': '1', 'metadata[product]': PRODUCT, 'metadata[plan]': input.plan, success_url: env.PUBLIC_ORIGIN + '/success?session_id={CHECKOUT_SESSION_ID}', cancel_url: env.PUBLIC_ORIGIN + '/#pricing', 'billing_address_collection': 'auto', 'customer_creation': 'always' });
      if (env.STRIPE_AUTOMATIC_TAX === '1') form.set('automatic_tax[enabled]', 'true');
      const result = await stripe(env, fetcher, 'checkout/sessions', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': 'future-code/' + input.plan + '/' + input.requestId }, body: form });
      const destination = new URL(result.url);
      if (destination.protocol !== 'https:' || destination.hostname !== 'checkout.stripe.com') throw new HttpError(502, 'Invalid checkout response.');
      return json({ url: destination.href });
    }
    if (request.method === 'POST' && url.pathname === '/api/order/status') {
      await rateLimit(env, request, 'order-status', 30, now);
      const input = await readJson(request);
      if (!idPattern.test(input.sessionId || '')) throw new HttpError(400, 'Invalid order reference.');
      const order = await env.DB.prepare('SELECT orders.payment_intent,deliveries.sent FROM orders JOIN deliveries ON orders.id=deliveries.order_id WHERE orders.id=?').bind(input.sessionId).first();
      if (!order) return json({ state: 'processing' });
      const revoked = await env.DB.prepare('SELECT 1 FROM revocations WHERE payment_intent=?').bind(order.payment_intent).first();
      return json({ state: revoked ? 'reversed' : order.sent ? 'delivered' : 'processing' });
    }
    if (request.method === 'POST' && url.pathname === '/api/license/activate') return await activate(env, request, fetcher, now);
    if (request.method === 'POST' && url.pathname === '/api/license/deactivate') {
      await rateLimit(env, request, 'deactivate', 20, now);
      const input = await readJson(request);
      if (!/^FC1-[A-Za-z0-9_-]{43}$/.test(input.key || '') || !/^[a-f\d]{64}$/.test(input.device || '')) throw new HttpError(400, 'Invalid key or device.');
      const order = await env.DB.prepare('SELECT id FROM orders WHERE key_hash=?').bind(await digest(input.key)).first();
      if (order) await env.DB.prepare('DELETE FROM activations WHERE order_id=? AND device_hash=?').bind(order.id, input.device).run();
      return json({ deactivated: true });
    }
    return json({ error: 'Not found.' }, 404);
  } catch (error) {
    // Do not put payment objects, email addresses, credentials or license keys in logs.
    return json({ error: error instanceof HttpError ? error.message : 'Service is temporarily unavailable. Please retry.' }, error instanceof HttpError ? error.status : 503);
  }
}
