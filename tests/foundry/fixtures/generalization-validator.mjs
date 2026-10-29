/** Synthetic protocol fixture, not a real workload validator. The frozen file
 * stands in for independently rebuilt family/provenance/scorer evidence. */
import { readFileSync } from "node:fs";
import { digest } from "../../../src/harness/foundry/kernel.ts";
const request = JSON.parse(readFileSync(0, "utf8"));
const generalization = JSON.parse(readFileSync(process.argv[2], "utf8"));
const required = request.spec.validation.find(v => v.id === request.validator);
console.log(JSON.stringify({ schema: 1, validator: request.validator, implementationHash: request.implementationHash,
  specHash: digest(request.spec), resultHash: digest(request.result), contextHash: digest(request.context),
  checks: required.checks.map(id => ({ id, verdict: "PASS" })), outcome: "SUPPORTED", generalization }));
