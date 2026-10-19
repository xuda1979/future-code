// One-time annual passes: model-provider usage is purchased by the customer.
export const PRODUCT = 'future-code';
export const PLANS = Object.freeze({
  solo: Object.freeze({ name: 'Solo', cents: 2900, currency: 'usd', seats: 1, devices: 2, days: 365, priceEnv: 'STRIPE_PRICE_SOLO' }),
  team: Object.freeze({ name: 'Team', cents: 9900, currency: 'usd', seats: 5, devices: 10, days: 365, priceEnv: 'STRIPE_PRICE_TEAM' }),
});
export const PLATFORMS = ['windows-x64', 'macos-arm64', 'macos-x64', 'ubuntu-x64'];
