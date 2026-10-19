import { env } from 'cloudflare:workers';
// @ts-expect-error commerce modules are portable JavaScript tested with Node.
import { handleRequest } from '../../../lib/users/commerce/service.mjs';
import manifest from '../../../lib/users/releases.json';
export const dynamic = 'force-dynamic';
async function route(request: Request) {
  const origin = (env as Record<string, unknown>).COMMERCE_ORIGIN;
  if (typeof origin === 'string' && origin.startsWith('https://')) {
    const source = new URL(request.url);
    const target = new URL(source.pathname + source.search, origin);
    // A configured standalone API host can own payments, persistence and keys.
    // Never forward browser cookies or visitor Authorization headers.
    const headers = new Headers();
    for (const name of ['Content-Type', 'Origin', 'Stripe-Signature']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
    let data: Uint8Array | undefined;
    if (request.method === 'POST') {
      const limit = source.pathname === '/api/stripe/webhook' ? 524288 : 8192;
      const chunks: Uint8Array[] = []; let size = 0; const reader = request.body?.getReader();
      if (reader) while (true) {
        const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
        if (size > limit) { await reader.cancel(); return Response.json({ error: 'Request too large.' }, { status: 413 }); }
        chunks.push(chunk.value);
      }
      data = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    }
    return fetch(target, { method: request.method, headers, redirect: 'error', signal: AbortSignal.timeout(20000), ...(data ? { body: data } : {}) });
  }
  return handleRequest(request, env, manifest);
}
export async function GET(request: Request) { return route(request); }
export async function POST(request: Request) { return route(request); }
