/** Independent natural deduction checker for this example's propositional
 * fragment. It does not import the constructor or trust its inferred formulas. */
import { readFileSync } from "node:fs";
import { canonical, digest, invariant, sha256 } from "../../src/harness/foundry/kernel.ts";
const request = JSON.parse(readFileSync(0, "utf8")), { spec, result, context } = request;
let nodes = 0;
function formula(value, depth = 0) {
  invariant(++nodes <= 10000 && depth <= 64, "formula exceeds checker bounds");
  if (typeof value === "string") { invariant(/^[A-Z][A-Za-z0-9]{0,31}$/.test(value), "invalid proposition"); return value; }
  invariant(Array.isArray(value) && value.length === 3 && ["implies", "and"].includes(value[0]), "unknown formula");
  return [value[0], formula(value[1], depth + 1), formula(value[2], depth + 1)];
}
const target = formula(JSON.parse(spec.theory.statement)), assumptions = spec.assumptions.map(s => formula(JSON.parse(s)));
const certificate = result.observations[0].data.certificate;
invariant(certificate?.schema === 1 && Array.isArray(certificate.steps) && certificate.steps.length > 0 && certificate.steps.length <= 1024,
  "missing bounded deduction certificate");
const inferred = [];
for (const step of certificate.steps) {
  const prior = index => { invariant(Number.isSafeInteger(index) && index >= 0 && index < inferred.length, "invalid proof reference"); return inferred[index]; };
  let conclusion;
  if (step.rule === "assumption") {
    invariant(Number.isSafeInteger(step.index) && step.index >= 0 && step.index < assumptions.length, "undeclared axiom");
    conclusion = assumptions[step.index];
  } else if (step.rule === "premise") {
    const premise = context.theoryPremises?.find(p => p.template === step.template);
    invariant(premise && spec.theory.premises.some(p => p.template === step.template && p.specHash === premise.specHash), "unestablished premise");
    conclusion = formula(JSON.parse(premise.statement));
  } else if (step.rule === "mp") {
    const implication = prior(step.implication), antecedent = prior(step.antecedent);
    invariant(Array.isArray(implication) && implication[0] === "implies" && canonical(implication[1]) === canonical(antecedent), "invalid modus ponens");
    conclusion = implication[2];
  } else if (step.rule === "and-intro") conclusion = ["and", prior(step.left), prior(step.right)];
  else throw new Error("unknown proof rule");
  inferred.push(conclusion);
}
invariant(Number.isSafeInteger(certificate.conclusion) && certificate.conclusion >= 0 && certificate.conclusion < inferred.length &&
  canonical(inferred[certificate.conclusion]) === canonical(target), "proof does not establish the exact target");
const raw = canonical(certificate), artifactHash = sha256(raw);
invariant(context.artifacts.proof.sha256 === artifactHash && context.artifacts.proof.bytes === Buffer.byteLength(raw), "certificate artifact changed");
console.log(JSON.stringify({ schema: 1, validator: request.validator, implementationHash: request.implementationHash,
  specHash: digest(spec), resultHash: digest(result), contextHash: digest(context),
  checks: ["kernel-inference", "target-and-axioms", "certificate-binding"].map(id => ({ id, verdict: "PASS" })), outcome: "SUPPORTED",
  theory: { targetHash: digest({ statement: spec.theory.statement, assumptions: spec.assumptions }), kind: "deduction",
    artifact: "proof", artifactHash, openObligations: [] } }));
