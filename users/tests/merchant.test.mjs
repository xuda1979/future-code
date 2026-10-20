import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMerchant, stripeLiveMode, GATC_STRIPE_ACCOUNT } from '../commerce/merchant.mjs';
const ready = () => ({ id: GATC_STRIPE_ACCOUNT, charges_enabled: true, payouts_enabled: true, requirements: { past_due: [], disabled_reason: null }, external_accounts: { data: [{ object: 'bank_account', default_for_currency: true, currency: 'usd', status: 'verified' }] } });
test('merchant readiness requires the GATC account, charges, payouts and usable bank', () => {
  assert.equal(assessMerchant(ready()).ready, true);
  for (const change of [a => a.id = 'acct_wrong', a => a.charges_enabled = false, a => a.payouts_enabled = false, a => a.requirements.past_due.push('external_account'), a => a.external_accounts.data = [], a => a.external_accounts.data[0].status = 'errored']) {
    const account = ready(); change(account); assert.equal(assessMerchant(account).ready, false);
  }
});
test('live and test keys including restricted keys are classified explicitly', () => {
  for (const prefix of ['sk', 'rk']) { assert.equal(stripeLiveMode(prefix + '_live_fixture'), true); assert.equal(stripeLiveMode(prefix + '_test_fixture'), false); }
  assert.throws(() => stripeLiveMode('invalid'));
});
