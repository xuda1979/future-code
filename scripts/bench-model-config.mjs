#!/usr/bin/env node
// Actual wrapper -> source entrypoint -> atomic profile save. No model inference.
// BUN_BIN=/path/to/bun node scripts/bench-model-config.mjs [samples]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const count = Number(process.argv[2] ?? 20);
assert.ok(Number.isInteger(count) && count >= 1 && count <= 50);
const temp = mkdtempSync(join(tmpdir(), 'bench-model-config-'));
const key = 'benchmark-test-key-not-a-credential';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const shim = join(temp, 'source-entrypoint');
writeFileSync(shim, `#!/usr/bin/env bash\nexec ${quote(process.env.BUN_BIN ?? 'bun')} ${quote(join(root, 'src/entrypoints/cli-bundle.ts'))} "$@"\n`, { mode: 0o700 });
let apiRequests = 0;
const api = createServer((_, response) => { apiRequests++; response.writeHead(401); response.end('invalid test credentials'); });
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
const environment = {
  ...process.env,
  FUTURE_CONFIG_DIR: join(temp, 'config'), FUTURE_CODE_BIN: shim,
  FUTURE_CODE_CONFIG_FILE: join(temp, 'missing-old-config.env'),
  FUTURE_BASE_URL: `http://127.0.0.1:${api.address().port}`,
  FUTURE_API_KEY: 'invalid-previous-provider-key', BENCH_MODEL_KEY: key,
};
const times = [];
try {
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    await new Promise((resolve, reject) => {
      const child = spawn('bash', [join(root, 'future-code.sh'), '--model-endpoint', 'add', `Benchmark-Model-${i}`, 'https://example.invalid/v1', '--api-key-env', 'BENCH_MODEL_KEY'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', bytes => { output += bytes; });
      child.stderr.on('data', bytes => { output += bytes; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Local configuration exceeded 5s')); }, 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        try {
          assert.equal(code, 0, output);
          assert.match(output, /Saved endpoint/);
          assert.ok(!output.includes(key));
          resolve();
        } catch (error) { reject(error); }
      });
    });
    times.push(performance.now() - started);
  }
  const directory = join(environment.FUTURE_CONFIG_DIR, 'model-endpoints');
  const files = readdirSync(directory);
  assert.equal(files.length, count);
  for (const name of files) {
    const path = join(directory, name);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).apiKey, key);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.equal(apiRequests, 0);
  times.sort((a, b) => a - b);
  const percentile = p => Number(times[Math.max(0, Math.min(times.length - 1, Math.ceil(p * times.length) - 1))].toFixed(2));
  console.log(JSON.stringify({
    workload: 'installed wrapper -> Bun source entrypoint -> local profile save',
    samples: count, savedAndReadBack: files.length, apiRequests,
    medianMs: percentile(0.5), p95Ms: percentile(0.95), minMs: percentile(0), maxMs: percentile(1),
    node: process.versions.node, platform: `${process.platform}/${process.arch}`,
    limitations: 'Local component timing; source entrypoint, not a full compiled CLI or live-agent productivity comparison.',
  }, null, 2));
} finally {
  await new Promise(resolve => api.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
