/** Adversarial protocol fixture. This does not implement a scientific method. */
import { readFileSync } from "node:fs";
import { digest } from "../../../src/harness/foundry/kernel.ts";
const request = JSON.parse(readFileSync(0, "utf8"));
const option = (name, fallback) => {
  const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1];
};
const required = request.spec.validation.find(v => v.id === request.validator);
console.log(JSON.stringify({ schema: 1, validator: request.validator, implementationHash: request.implementationHash,
  specHash: digest(request.spec), resultHash: digest(request.result), contextHash: digest(request.context),
  checks: required.checks.map(id => ({ id, verdict: option("--verdict", "PASS") })), outcome: option("--outcome", "REFUTED") }));
