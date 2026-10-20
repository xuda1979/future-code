// Read-only production preflight. Does not charge cards, transfer funds, change
// bank details, or send email. No secrets or bank identifiers are printed.
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assessMerchant, stripeLiveMode } from '../commerce/merchant.mjs';
import { releaseReady } from '../commerce/service.mjs';
import { PLANS } from '../catalog.mjs';
import { LICENSE_PUBLIC_KEY, LICENSE_ORIGIN } from '../client/config.mjs';
const env = process.env;
const checks = [];
async function check(name, action) {
  try { const detail = await action(); checks.push({ name, passed: true, ...(detail ? { detail } : {}) }); }
  catch (error) { checks.push({ name, passed: false, reason: error.message }); }
}
async function api(url, secret) {
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12000), headers: secret ? { Authorization: 'Bearer ' + secret } : {} });
  if (!r.ok) throw Error('Service returned HTTP ' + r.status);
  return r.json();
}
await check('required production configuration', () => {
  const missing = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_SOLO', 'STRIPE_PRICE_TEAM', 'LICENSE_PRIVATE_KEY', 'LICENSE_STORAGE_KEY', 'RESEND_API_KEY', 'MAIL_FROM', 'PUBLIC_ORIGIN'].filter(k => !env[k]);
  if (missing.length) throw Error('Missing: ' + missing.join(', '));
});
await check('commercial release validation', () => {
  if (!releaseReady(JSON.parse(readFileSync(new URL('../releases.json', import.meta.url), 'utf8')))) throw Error('Release manifest remains preview or commercial source-rights evidence is incomplete');
});
await check('desktop signature verification key matches service', () => {
  if (!env.LICENSE_PRIVATE_KEY) throw Error('Server signing key not available to this preflight');
  if (createPublicKey(env.LICENSE_PRIVATE_KEY).export({ type: 'spki', format: 'pem' }).trim() !== LICENSE_PUBLIC_KEY.trim()) throw Error('Server signing key does not match the public key compiled into clients');
});
await check('desktop and webhook API accepts unauthenticated machine requests', async () => {
  const origin = env.COMMERCE_ORIGIN || LICENSE_ORIGIN;
  if (!origin.startsWith('https://') || origin !== LICENSE_ORIGIN) throw Error('Compile the actual HTTPS commerce origin into all clients');
  const catalog = await api(origin + '/api/catalog');
  if (Object.keys(catalog.downloads || {}).length !== 4) throw Error('API does not expose all four verified platform downloads');
});
await check('Stripe charges and GATC bank payouts enabled', async () => {
  if (!env.STRIPE_SECRET_KEY || !stripeLiveMode(env.STRIPE_SECRET_KEY)) throw Error('A live Stripe credential is required to verify real-money readiness');
  const status = assessMerchant(await api('https://api.stripe.com/v1/account', env.STRIPE_SECRET_KEY));
  if (!status.ready) throw Error(status.problems.join('; '));
});
await check('published prices match software plans', async () => {
  if (!env.STRIPE_SECRET_KEY) throw Error('Stripe credential missing');
  for (const plan of Object.values(PLANS)) {
    const id = env[plan.priceEnv]; if (!id) throw Error(plan.priceEnv + ' missing');
    const price = await api('https://api.stripe.com/v1/prices/' + encodeURIComponent(id), env.STRIPE_SECRET_KEY);
    if (!price.active || price.unit_amount !== plan.cents || price.currency !== plan.currency || price.recurring) throw Error(plan.name + ' price does not match the one-time annual pass');
  }
});
await check('signed payment and refund webhook registered', async () => {
  if (!env.STRIPE_SECRET_KEY) throw Error('Stripe credential missing');
  const list = await api('https://api.stripe.com/v1/webhook_endpoints?limit=100', env.STRIPE_SECRET_KEY);
  const required = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'charge.refunded', 'charge.dispute.created'];
  const url = (env.COMMERCE_ORIGIN || LICENSE_ORIGIN) + '/api/stripe/webhook';
  if (!list.data?.some(w => w.url === url && w.status === 'enabled' && required.every(e => w.enabled_events.includes(e) || w.enabled_events.includes('*')))) throw Error('Required enabled webhook endpoint not found');
});
await check('license email sender domain verified', async () => {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw Error('Email API credential or sender missing');
  const domain = env.MAIL_FROM.match(/@([^>\s]+)/)?.[1]?.toLowerCase();
  const list = await api('https://api.resend.com/domains', env.RESEND_API_KEY);
  if (!list.data?.some(d => d.name?.toLowerCase() === domain && d.status === 'verified')) throw Error('License-email sender domain is not verified');
});
console.log(JSON.stringify({ readyForLiveTest: checks.every(c => c.passed), livePurchaseTestCompleted: false, bankDepositVerified: false, checks }, null, 2));
process.exitCode = checks.every(c => c.passed) ? 0 : 1;
