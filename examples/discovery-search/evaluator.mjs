// Project-specific trusted evaluator. vm is a timeout aid, NOT a security sandbox.
// Execute only trusted generated programs in an appropriately isolated runtime.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
const canonical = v => v && typeof v === 'object' ? Array.isArray(v) ? `[${v.map(canonical).join(',')}]` :
  `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const hash = v => createHash('sha256').update(canonical(v)).digest('hex');
const r = JSON.parse(readFileSync(0, 'utf8'));
if (r.phase !== 'evaluate' || hash(r.task) !== r.protocolHash || hash(r.candidate) !== r.candidateHash) throw Error('Invalid evaluator request');
let correct = true, repeatable = true, feedback = 'All 101 declared inputs agree with the independent oracle.';
for (let n = 0; n <= 100; n++) {
  try {
    const actual = runInNewContext(`(${r.candidate.source})(${n})`, {}, { timeout: 50 });
    const again = runInNewContext(`(${r.candidate.source})(${n})`, {}, { timeout: 50 });
    if (actual !== again) repeatable = false;
    if (actual !== n * n + n) { correct = false; feedback = `Counterexample n=${n}: expected ${n * n + n}.`; break; }
  } catch { correct = false; feedback = `Candidate execution failed at n=${n}.`; break; }
}
console.log(JSON.stringify({ schema: 1, protocolHash: hash(r.task), candidateHash: hash(r.candidate),
  checks: [{ id: 'finite-domain', verdict: correct ? 'PASS' : 'FAIL' }, { id: 'repeatability', verdict: repeatable ? 'PASS' : 'FAIL' }],
  metrics: typeof r.candidate.source === 'string' ? { sourceBytes: Buffer.byteLength(r.candidate.source) } : {}, feedback }));
