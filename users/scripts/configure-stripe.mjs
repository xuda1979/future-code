// Run in an authenticated deployment environment. Never commit live credentials.
import { PLANS } from '../catalog.mjs';
import { assessMerchant, stripeLiveMode } from '../commerce/merchant.mjs';
const secret = process.env.STRIPE_SECRET_KEY;
if (!secret) throw new Error('Set STRIPE_SECRET_KEY in the deployment environment.');
async function api(path, form, idempotencyKey) {
  const response = await fetch('https://api.stripe.com/v1/' + path, { method: form ? 'POST' : 'GET', signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + secret, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idempotencyKey } : {}) }, body: form ? new URLSearchParams(form) : undefined });
  if (!response.ok) throw new Error('Stripe setup failed (' + response.status + '). Review in Stripe; no bank settings were changed.');
  return response.json();
}
const account = await api('account');
if (account.id !== 'acct_1Npcs6EVgpqy45wF') throw new Error('This is not the verified GATC Stripe account.');
if (!account.charges_enabled) throw new Error('Stripe charges are not enabled. Complete account requirements in Stripe.');
if (stripeLiveMode(secret)) {
  const status = assessMerchant(account);
  if (!status.ready) throw new Error(status.problems.join('; ') + '. No bank settings were changed.');
}
const product = await api('products', { name: 'Future Code — Annual Desktop Pass', description: 'One-time 12-month software pass. Model API usage sold separately.', 'metadata[product]': 'future-code' }, 'future-code-product-v1');
for (const [id, p] of Object.entries(PLANS)) {
  const price = await api('prices', { product: product.id, unit_amount: String(p.cents), currency: p.currency, lookup_key: 'future-code-' + id + '-annual-v1', 'metadata[plan]': id }, 'future-code-price-' + id + '-v1');
  console.log(p.priceEnv + '=' + price.id);
}
console.log('Register /api/stripe/webhook for checkout.session.completed, checkout.session.async_payment_succeeded, charge.refunded and charge.dispute.created. Store its signing secret in the deployment environment.');
