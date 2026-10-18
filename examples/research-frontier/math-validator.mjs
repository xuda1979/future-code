/** Independent exact arithmetic validator for the bounded example protocol.
 * This is a small project-owned checker, not a formal proof assistant. */
import { readFileSync } from "node:fs";
import { canonical, digest, invariant, sha256 } from "../../src/harness/foundry/kernel.ts";
const r = JSON.parse(readFileSync(0, "utf8")), { spec, result, context } = r;
const { coefficients, maximumN } = spec.parameters;
invariant(Array.isArray(coefficients) && coefficients.length > 0 && coefficients.length <= 8 &&
  coefficients.every(c => Number.isSafeInteger(c) && c >= 0 && c <= 1000000) &&
  Number.isSafeInteger(maximumN) && maximumN >= 0 && maximumN <= 50000, "bounded polynomial protocol required");
const evaluate = n => coefficients.reduceRight((sum, c) => sum * BigInt(n) + BigInt(c), 0n);
const data = result.observations[0].data, w = data.witness;
invariant(Number.isSafeInteger(data.checked) && data.checked > 0 && data.checked <= maximumN + 1, "invalid search coverage");
if (w !== null) {
  invariant(w && Number.isSafeInteger(w.n) && w.n >= 0 && w.n <= maximumN && Number.isSafeInteger(w.value) &&
    Number.isSafeInteger(w.divisor) && w.divisor >= 2 && w.divisor < w.value &&
    evaluate(w.n) === BigInt(w.value) && BigInt(w.value) % BigInt(w.divisor) === 0n, "invalid exact counterexample");
} else {
  invariant(data.checked === maximumN + 1, "incomplete bounded search");
  for (let n = 0; n <= maximumN; n++) {
    const value = evaluate(n); invariant(value >= 2n, "non-prime value omitted");
    for (let factor = 2n; factor * factor <= value; factor++) invariant(value % factor !== 0n, "counterexample omitted");
  }
}
const raw = canonical(result.observations);
invariant(context.artifacts.evidence.sha256 === sha256(raw) && context.artifacts.evidence.bytes === Buffer.byteLength(raw), "evidence manifest mismatch");
console.log(JSON.stringify({ schema: 1, validator: r.validator, implementationHash: r.implementationHash,
  specHash: digest(spec), resultHash: digest(result), contextHash: digest(context),
  checks: ["exact-counterexample", "search-completeness"].map(id => ({ id, verdict: "PASS" })),
  outcome: w === null ? "INCONCLUSIVE" : "REFUTED" }));
