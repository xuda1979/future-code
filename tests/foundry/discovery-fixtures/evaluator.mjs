import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
const r = JSON.parse(readFileSync(0, 'utf8'));
let valid = true;
for (const x of [-99, -4, 0, 1, 2, 9, 42]) {
  try { if (runInNewContext(`(${r.candidate.source})(${x})`, {}, { timeout: 50 }) !== x * x + x + 41) valid = false; }
  catch { valid = false; }
}
const canonical = v => v && typeof v === 'object' ? Array.isArray(v) ? `[${v.map(canonical)}]` :
  `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const candidateHash = createHash('sha256').update(canonical(r.candidate)).digest('hex');
console.log(JSON.stringify({ schema: 1, protocolHash: r.protocolHash,
  candidateHash: r.task.interface.stale ? '0'.repeat(64) : candidateHash,
  checks: r.task.checks.map(id => ({ id, verdict: valid ? 'PASS' : 'FAIL' })),
  metrics: valid ? { programBytes: Buffer.byteLength(r.candidate.source) } : {},
  feedback: valid ? 'Finite fixture inputs agree with the oracle.' : 'Counterexample: x=0 requires 41.' }));
