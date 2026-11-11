import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..'), output = join(here, 'review-results-v2');
const contract = JSON.parse(readFileSync(join(here, 'contract-code-review-v2.json')));
const samples = [];
for (const scenario of ['small', 'architecture-review', 'legacy-flag-on']) {
  for (let r = 0; r < (scenario === 'legacy-flag-on' ? 1 : 4); r++) {
    const order = scenario === 'legacy-flag-on' ? ['baseline'] : r % 4 === 0 || r % 4 === 3 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const label of order) {
      const dir = join(output, `${scenario}-${r}-${label}`); mkdirSync(dir, { recursive: true });
      const result = spawnSync(process.execPath, ['--experimental-strip-types', join(here, 'arm-v2.mjs'), 'context',
        label === 'baseline' ? resolve(root, '../future-code-first') : root,
        join(output, scenario === 'small' ? 'small-input.json' : 'input.json'), dir, scenario], { encoding: 'utf8', timeout: 8000 });
      writeFileSync(join(dir, 'stderr.txt'), result.stderr ?? '');
      const data = result.status === 0 ? JSON.parse(readFileSync(join(dir, 'result.json'))) : null;
      samples.push({ label, scenario, repetition: r, exitCode: result.status, result: data });
      console.log(JSON.stringify({ label, scenario, r, bytes: data?.requestBytes, restored: data?.fullReadbackIdentical, exit: result.status }));
    }
  }
}
writeFileSync(join(output, 'samples.json'), JSON.stringify(samples, null, 2) + '\n');
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ contract,
  contractSha256: createHash('sha256').update(readFileSync(join(here, 'contract-code-review-v2.json'))).digest('hex'),
  inputSha256: createHash('sha256').update(readFileSync(join(output, 'input.json'))).digest('hex'),
  node: process.version, liveModelCalls: 0 }, null, 2) + '\n');
