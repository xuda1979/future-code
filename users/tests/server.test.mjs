import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { sqliteBinding, createCommerceServer } from '../commerce/server.mjs';
test('portable HTTP backend serves catalog and safely declines unconfigured checkout', async () => {
  const DB = sqliteBinding(':memory:');
  const env = { DB, PUBLIC_ORIGIN: 'https://product.example', SALES_ENABLED: '0' };
  const server = createCommerceServer(env, { version: 'test', status: 'prelaunch', assets: {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const catalog = await (await fetch(origin + '/api/catalog')).json();
    assert.equal(catalog.salesEnabled, false); assert.deepEqual(catalog.downloads, {});
    const checkout = await fetch(origin + '/api/checkout', { method: 'POST', body: '{}' });
    assert.equal(checkout.status, 503);
    assert.match((await checkout.json()).error, /not open yet/);
    const status = await fetch(origin + '/api/order/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'cs_test_abcdefgh1234' }) });
    assert.deepEqual(await status.json(), { state: 'processing' });
  } finally { await new Promise(resolve => server.close(resolve)); DB.raw.close(); }
});
