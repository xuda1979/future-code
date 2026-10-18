/** Real bounded integer searches with a separate exact checker, no LLM API.
 * The comparison runner is serial; this demo measures avoided jobs, not swarm speed. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { digest, sha256 } from "../src/harness/foundry/kernel.ts";
import { pinCommand } from "../src/harness/foundry/commands.ts";
import { compareResearchStrategies } from "../src/harness/foundry/researchEvaluation.ts";
const path = name => fileURLToPath(new URL(name, import.meta.url));
export function mathematicalFrontierProtocol() {
  const executor = path("../examples/research-frontier/math-executor.mjs"), validator = path("../examples/research-frontier/math-validator.mjs");
  const kernel = path("../src/harness/foundry/kernel.ts");
  const command = file => ({ argv: [process.execPath, "--experimental-strip-types", file], files: [kernel] });
  const spec = maximumN => {
    const parameters = { coefficients: [41, 1, 1], maximumN };
    return { schema: 2, kind: "project-defined-mathematics", question: "Is n²+n+41 prime for every nonnegative integer n?",
      hypothesis: "Every value is prime.", assumptions: ["Exact integer arithmetic", "This checker searches a bounded interval"],
      refutation: "One exact composite value refutes the universal claim.", protocol: "Bounded counterexample search with independent factor verification",
      identity: { code: digest([sha256(readFileSync(executor)), sha256(readFileSync(validator))]), data: digest(parameters),
        environment: digest({ node: process.version }) }, input: parameters, parameters, acceptance: "valid-result",
      execution: { mode: "computational", backend: "local-integer-search", configurationHash: digest(parameters) },
      units: [{ id: "search", role: "primary", replicates: ["bounded"] }],
      artifacts: [{ id: "evidence", minimumBytes: 1, maximumBytes: 16384 }],
      validation: [{ id: "arithmetic", checks: ["exact-counterexample", "search-completeness"] }] };
  };
  return { schema: 1, name: "bounded-mathematical-frontier", executor: command(executor),
    validators: { arithmetic: { command: command(validator), readOnly: true, timeoutMs: 2000, maxOutputBytes: 16384 } },
    maxArmMs: 10000, maxOutputBytes: 16384, cases: [50, 30].map((bound, i) => ({ id: `screen-${bound}`,
      strategy: { schema: 1, maxExperiments: 2, maxSnapshotBytes: 8192, stopOnRefutation: true,
        frontier: { maxParallel: 2, explorationWeight: 1, maxInconclusivePerLine: 2 }, candidates: [
          { id: "screen", template: "screen", line: "prime-values", purpose: "falsification" },
          { id: "extend", template: "extend", line: "prime-values", purpose: "exploration",
            after: [{ candidate: "screen", outcomes: ["INCONCLUSIVE"] }] } ] },
      experiments: { screen: spec(bound), extend: spec(i ? 50 : 500) } })) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p = mathematicalFrontierProtocol();
  const report = await compareResearchStrategies(p, pinCommand(p.executor, process.cwd()), new AbortController().signal);
  console.log(JSON.stringify(report, null, 2));
  if (!report.allEvidenceValid) process.exitCode = 1;
}
