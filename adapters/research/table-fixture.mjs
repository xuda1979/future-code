/** OFFLINE FIXTURE adapter for exercising the protocol, not a physical experiment.
 * Replace this executor with a project-owned simulator/instrument/provider adapter. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { digest, invariant, sha256 } from "../../src/harness/foundry/kernel.ts";

const codeIdentity = () => digest({ runner: sha256(readFileSync(fileURLToPath(import.meta.url))),
  validator: sha256(readFileSync(fileURLToPath(new URL("./paired-table-validator.mjs", import.meta.url)))) });
const environmentIdentity = () => digest({ runtime: process.version, adapter: "offline-table-fixture-v1" });
export function tableFixtureSpec(kind = "arbitrary-project", path = "/reading", negative = false) {
  const replicates = Array.from({ length: 32 }, (_, i) => `rep${i}`);
  const data = value => path === "/reading" ? { reading: value } : { nested: { signal: value } };
  const observations = replicates.flatMap(replicate => [
    { unit: "candidate", replicate, data: data(negative ? 0 : 0.9) },
    { unit: "baseline", replicate, data: data(0.1) },
  ]);
  return { schema: 2, kind, question: "Does the declared measurement improve under the paired design?",
    hypothesis: "Mean paired improvement exceeds 0.1.", assumptions: ["Offline fixture only", "Independent bounded replications required for scientific interpretation"],
    refutation: "The upper confidence bound is below the minimum effect.", protocol: "Frozen paired-table adapter protocol",
    identity: { code: codeIdentity(), data: digest(observations), environment: environmentIdentity() },
    input: { observations }, acceptance: "valid-result", parameters: { analysis: { primary: "candidate", reference: "baseline",
      path, minimum: 0, maximum: 1, alpha: 0.05, minimumEffect: 0.1 } },
    execution: { mode: "simulation", backend: "offline-table-fixture", configurationHash: digest({ kind, path, negative }) },
    units: [{ id: "candidate", role: "primary", replicates }, { id: "baseline", role: "control", replicates }],
    artifacts: [{ id: "raw-data", minimumBytes: 1, maximumBytes: 65536 }],
    validation: [{ id: "analysis", checks: ["paired-design", "measurement-range", "bounded-effect"] }] };
}
export function fixtureResult(spec, execution) {
  invariant(spec.schema === 2 && spec.execution.mode === "simulation" && spec.execution.backend === "offline-table-fixture" &&
    spec.identity.code === codeIdentity() && spec.identity.environment === environmentIdentity() &&
    spec.identity.data === digest(spec.input.observations), "fixture adapter identity/mode/input mismatch");
  return { schema: 2, specHash: digest(spec), identity: spec.identity,
    execution: { ...spec.execution, ...execution }, observations: spec.input.observations };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--evaluate")) {
    const request = JSON.parse(readFileSync(0, "utf8"));
    const result = fixtureResult(request.spec, request.execution), data = Buffer.from(JSON.stringify(result.observations));
    console.log(JSON.stringify({ result, artifacts: { "raw-data": { sha256: sha256(data), bytes: data.length } } }));
  } else {
    const index = process.argv.indexOf("--spec"); invariant(index >= 0, "pinned --spec required");
    const spec = JSON.parse(readFileSync(process.argv[index + 1], "utf8"));
    invariant(digest(JSON.parse(readFileSync(process.env.FUTURE_JOB_INPUT_PATH, "utf8"))) === digest(spec.input), "frozen input changed");
    const key = process.env.FUTURE_JOB_KEY, result = fixtureResult(spec, { key, jobId: key });
    writeFileSync(join(process.env.FUTURE_JOB_ARTIFACT_DIR, "raw-data"), JSON.stringify(result.observations));
    writeFileSync(process.env.FUTURE_JOB_RESULT_PATH, JSON.stringify(result));
  }
}
