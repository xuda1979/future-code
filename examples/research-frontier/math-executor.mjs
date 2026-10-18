/** Local mathematical example: search for a composite polynomial value.
 * A bounded unsuccessful search is INCONCLUSIVE, never a universal proof. */
import { readFileSync } from "node:fs";
import { canonical, digest, sha256 } from "../../src/harness/foundry/kernel.ts";
const { spec, execution } = JSON.parse(readFileSync(0, "utf8"));
const { coefficients, maximumN } = spec.parameters;
let witness = null, checked = 0;
for (let n = 0; n <= maximumN; n++) {
  const value = coefficients.reduceRight((sum, c) => sum * n + c, 0); checked++;
  for (let divisor = 2; divisor * divisor <= value; divisor++) if (value % divisor === 0) {
    witness = { n, value, divisor }; break;
  }
  if (witness) break;
}
const observations = [{ unit: "search", replicate: "bounded", data: { witness, checked } }];
const raw = canonical(observations);
console.log(JSON.stringify({ result: { schema: 2, specHash: digest(spec), identity: spec.identity,
  execution: { ...spec.execution, ...execution }, observations },
  artifacts: { evidence: { sha256: sha256(raw), bytes: Buffer.byteLength(raw) } } }));
