/** Small project-owned proof constructor, deliberately separate from the
 * checker. Formulae are atoms, ["implies", A, B], or ["and", A, B]. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { canonical, digest, sha256 } from "../../src/harness/foundry/kernel.ts";

export function constructProof(spec) {
  const steps = [], known = new Map();
  const add = (formula, step) => { const i = steps.length; steps.push(step); known.set(canonical(formula), i); return i; };
  for (const [template, statement] of Object.entries(spec.parameters.premiseStatements))
    add(JSON.parse(statement), { rule: "premise", template });
  for (const index of spec.parameters.axiomIndices) {
    const formula = JSON.parse(spec.assumptions[index]);
    add(formula, { rule: "assumption", index });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [encoded, implication] of [...known]) {
      const f = JSON.parse(encoded);
      if (Array.isArray(f) && f[0] === "implies" && known.has(canonical(f[1])) && !known.has(canonical(f[2]))) {
        add(f[2], { rule: "mp", implication, antecedent: known.get(canonical(f[1])) }); changed = true;
      }
    }
  }
  const derive = f => {
    if (known.has(canonical(f))) return known.get(canonical(f));
    if (Array.isArray(f) && f[0] === "and") return add(f, { rule: "and-intro", left: derive(f[1]), right: derive(f[2]) });
    throw new Error("Example constructor cannot derive the requested formula");
  };
  const conclusion = derive(JSON.parse(spec.theory.statement));
  return { schema: 1, steps, conclusion };
}

export function proofResult(spec, execution, certificate = constructProof(spec)) {
  const bytes = canonical(certificate);
  return { result: { schema: 2, specHash: digest(spec), identity: spec.identity,
    execution: { ...spec.execution, ...execution },
    observations: [{ unit: "argument", replicate: "certificate", data: { certificate } }] },
    artifacts: { proof: { sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) } } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { spec, execution } = JSON.parse(readFileSync(0, "utf8"));
  console.log(JSON.stringify(proofResult(spec, execution)));
}
