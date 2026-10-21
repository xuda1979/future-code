// Generic OpenAI-compatible external API adapter. Credentials stay in env.
// One fresh, bounded request per ideation/rewrite; host deadlines kill this process.
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(0, 'utf8'));
const url = new URL(process.env.DISCOVERY_API_URL);
if (url.username || url.password || url.hash || (url.protocol !== 'https:' &&
  !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw Error('Use HTTPS or local HTTP');
if (!process.env.DISCOVERY_MODEL) throw Error('Set DISCOVERY_MODEL');
const shape = r.phase === 'ideate' ?
  'Return {"families":[{"id":"identifier","approach":"distinct algorithmic strategy"},...]}. Use exactly familyCount entries. Start from the specification; no initial implementation is supplied.' :
  'Return {"candidate":<complete project representation>,"notes":[<up to 8 short insights>]}. Improve the local parent using independent evaluator feedback and optional archived alternatives. Notes are unverified advice. Each note must fit 512 UTF-8 bytes. Do not supply scores as evidence.';
const body = JSON.stringify({ model: process.env.DISCOVERY_MODEL, max_tokens: 4096, stream: false,
    messages: [{ role: 'system', content: `Perform general R&D under the frozen task interface and correctness requirements. ${shape} Output only one JSON object, without Markdown. Each request is a fresh search session.` },
      { role: 'user', content: JSON.stringify(r) }] });
if (!Number.isSafeInteger(r.budget?.contextBytes) || Buffer.byteLength(body) > r.budget.contextBytes)
  throw Error('CONTEXT_OVERFLOW: encoded model request exceeds admitted context');
const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',
  ...(process.env.DISCOVERY_API_KEY ? { authorization: `Bearer ${process.env.DISCOVERY_API_KEY}` } : {}) },
  body, signal: AbortSignal.timeout(120000) });
if (!response.ok) { await response.body?.cancel(); throw Error(`Model HTTP ${response.status}`); }
const reader = response.body.getReader(), chunks = []; let bytes = 0;
for (;;) {
  const { done, value } = await reader.read(); if (done) break;
  bytes += value.byteLength;
  if (bytes > 262144) { await reader.cancel(); throw Error('Model response exceeds 256 KiB'); }
  chunks.push(Buffer.from(value));
}
const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (reply.choices?.[0]?.finish_reason !== 'stop') throw Error('Model response incomplete');
const content = reply.choices[0].message?.content;
if (typeof content !== 'string') throw Error('Model response missing text');
console.log(JSON.stringify(JSON.parse(content)));
