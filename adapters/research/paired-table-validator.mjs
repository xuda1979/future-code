/** Optional, domain-neutral statistical METHOD adapter. The runtime knows none
 * of these assumptions/formulas. Input data paths and thresholds are frozen by the project. */
import { readFileSync } from "node:fs";
import { digest, invariant } from "../../src/harness/foundry/kernel.ts";
import { fields } from "../../src/harness/foundry/research.ts";

const request = JSON.parse(readFileSync(0, "utf8"));
const { spec, result, context } = request;
const p = spec.parameters.analysis;
fields(p, ["primary", "reference", "path", "minimum", "maximum", "alpha", "minimumEffect"]);
invariant(typeof p.path === "string" && p.path.startsWith("/") &&
  [p.minimum, p.maximum, p.alpha, p.minimumEffect].every(Number.isFinite) &&
  p.minimum < p.maximum && Number.isFinite(2 * (p.maximum - p.minimum)) &&
  p.alpha > 0 && p.alpha < 1 && p.minimumEffect >= 0 && p.minimumEffect <= p.maximum - p.minimum, "invalid paired analysis parameters");
const a = spec.units.find(u => u.id === p.primary), b = spec.units.find(u => u.id === p.reference);
invariant(a && b && a.id !== b.id && a.role === "primary" && b.role === "control" && a.replicates.length >= 2 &&
  digest([...a.replicates].sort()) === digest([...b.replicates].sort()), "paired design requires matching independent replications");
const value = data => {
  for (const segment of p.path.slice(1).split("/")) {
    invariant(!/~(?![01])/.test(segment), "invalid JSON pointer");
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    invariant(data && typeof data === "object" && Object.hasOwn(data, key), "measurement missing"); data = data[key];
  }
  invariant(Number.isFinite(data) && data >= p.minimum && data <= p.maximum, "measurement outside preregistered range"); return data;
};
const observations = new Map(result.observations.map(r => [`${r.unit}/${r.replicate}`, r.data]));
const differences = a.replicates.map(rep => value(observations.get(`${a.id}/${rep}`)) - value(observations.get(`${b.id}/${rep}`)));
const n = differences.length, range = p.maximum - p.minimum;
const mean = differences.reduce((sum, d) => sum + d / n, 0);
const radius = 2 * range * Math.sqrt(Math.log(2 / p.alpha) / (2 * n));
const lower = Math.max(-range, mean - radius), upper = Math.min(range, mean + radius);
const known = ["paired-design", "measurement-range", "bounded-effect"];
const required = spec.validation.find(v => v.id === request.validator);
invariant(required && required.checks.every(c => known.includes(c)), "unknown statistical check");
console.log(JSON.stringify({ schema: 1, validator: request.validator, implementationHash: request.implementationHash,
  specHash: digest(spec), resultHash: digest(result), contextHash: digest(context),
  checks: required.checks.map(id => ({ id, verdict: "PASS" })),
  outcome: lower > p.minimumEffect ? "SUPPORTED" : upper < p.minimumEffect ? "REFUTED" : "INCONCLUSIVE",
  measurements: { mean, lower, upper, replications: n, alpha: p.alpha,
    assumption: "Independent predeclared paired replications of bounded measurements" } }));
