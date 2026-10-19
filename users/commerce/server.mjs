// Portable Node 24 commerce host for environments that allow Stripe webhooks
// and desktop clients. Keep it behind an HTTPS reverse proxy in production.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleRequest } from './service.mjs';

export function sqliteBinding(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const raw = new DatabaseSync(filename);
  raw.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  if (version === 0) {
    raw.exec('BEGIN');
    try { raw.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')); raw.exec('PRAGMA user_version=1; COMMIT;'); }
    catch (error) { raw.exec('ROLLBACK'); throw error; }
  } else if (version !== 1) throw new Error('Unsupported commerce database schema version.');
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    first: () => raw.prepare(sql).get(...values) || null,
    run: () => raw.prepare(sql).run(...values),
  });
  return { raw, prepare: sql => statement(sql), batch: items => {
    raw.exec('BEGIN IMMEDIATE');
    try { const results = items.map(item => item.run()); raw.exec('COMMIT'); return results; }
    catch (error) { raw.exec('ROLLBACK'); throw error; }
  } };
}
export function createCommerceServer(env, manifest, options = {}) {
  return createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      // Do not trust a caller-supplied proxy IP header on a standalone host.
      headers.set('CF-Connecting-IP', incoming.socket.remoteAddress || 'unknown');
      const method = incoming.method || 'GET';
      const request = new Request(new URL(incoming.url || '/', env.PUBLIC_ORIGIN), { method, headers, ...(method !== 'GET' && method !== 'HEAD' ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
      const response = await handleRequest(request, env, manifest, options);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(503, { 'Content-Type': 'application/json' }); outgoing.end('{"error":"Service temporarily unavailable."}'); }
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const origin = process.env.PUBLIC_ORIGIN;
  if (!origin || !origin.startsWith('https://')) throw new Error('Configure PUBLIC_ORIGIN as the HTTPS storefront origin.');
  const db = sqliteBinding(process.env.COMMERCE_DB || 'users/.state/commerce.sqlite');
  const manifest = JSON.parse(readFileSync(new URL('../releases.json', import.meta.url), 'utf8'));
  const server = createCommerceServer({ ...process.env, DB: db }, manifest);
  const port = Number(process.env.PORT || 8787);
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.listen(port, process.env.LISTEN_HOST || '127.0.0.1', () => console.log('Commerce server listening on port ' + port));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { db.raw.close(); process.exitCode = 0; }));
}
