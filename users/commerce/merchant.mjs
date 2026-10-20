export const GATC_STRIPE_ACCOUNT = 'acct_1Npcs6EVgpqy45wF';
export function assessMerchant(account) {
  const problems = [];
  if (account?.id !== GATC_STRIPE_ACCOUNT) problems.push('Stripe account does not match GATC');
  if (account?.charges_enabled !== true) problems.push('Card charges are not enabled');
  if (account?.payouts_enabled !== true) problems.push('Bank payouts are not enabled');
  if (account?.requirements?.disabled_reason || account?.requirements?.past_due?.length) problems.push('Stripe has overdue account requirements');
  const bank = account?.external_accounts?.data?.find(a => a.object === 'bank_account' && a.default_for_currency === true && a.currency === 'usd');
  if (!bank || ['errored', 'verification_failed'].includes(bank.status)) problems.push('A usable default USD payout bank account is missing');
  return { ready: problems.length === 0, problems };
}
export function stripeLiveMode(secret) {
  const match = /^(?:sk|rk)_(test|live)_/.exec(secret || '');
  if (!match) throw Error('Stripe credentials are not configured correctly.');
  return match[1] === 'live';
}
