import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [directory, scenario] = process.argv.slice(2), root = resolve(directory);
assert(['counter-stalled', 'counter-healthy', 'counter-local-json', 'counter-oversize', 'counter-unavailable'].includes(scenario));
if (scenario === 'counter-local-json') {
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')),
    { port: 9090, enabled: true, padding: 'x'.repeat(20000) });
} else {
  const text = readFileSync(join(root, 'calc.mjs'), 'utf8');
  const prefix = '// ' + 'fixture comment '.repeat(2600) + '\n';
  assert(text.startsWith(prefix), 'unrelated source bytes changed');
  assert.equal(text.slice(prefix.length), scenario === 'counter-oversize' ? 'export const sum=(a,b)=>a-b;\n' : 'export const sum=(a,b)=>a+b;\n');
  const api = await import(pathToFileURL(join(root, 'calc.mjs')));
  for (const [a, b] of [[0, 0], [2, 7], [-10, 3], [1.5, -0.25]]) assert.equal(api.sum(a, b), scenario === 'counter-oversize' ? a - b : a + b);
}
process.stdout.write(JSON.stringify({ verdict: 'PASS', scenario }));
