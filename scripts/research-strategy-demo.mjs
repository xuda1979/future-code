/** Matched local experiment demo; no model API, remote backend or QPU is invoked. */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { pinCommand } from "../src/harness/foundry/commands.ts";
import { compareResearchStrategies } from "../src/harness/foundry/researchEvaluation.ts";
import { bellExperiment } from "./quantum-experiment.mjs";

export function quantumComparisonProtocol() {
  const executor = { argv: [process.execPath, "--experimental-strip-types",
    fileURLToPath(new URL("./quantum-experiment.mjs", import.meta.url)), "--evaluate"],
    files: [fileURLToPath(new URL("../src/harness/foundry/research.ts", import.meta.url)),
      fileURLToPath(new URL("../src/harness/foundry/kernel.ts", import.meta.url))] };
  return { schema: 1, name: "quantum-strategy-smoke", executor, maxArmMs: 10000, maxOutputBytes: 65536,
    cases: [true, false].map(control => {
      const screening = bellExperiment(control), detailed = { ...structuredClone(screening), shots: 16384, seed: 1980 };
      return { id: control ? "separable" : "bell", strategy: { schema: 1, maxExperiments: 2, maxSnapshotBytes: 8192,
        stopOnRefutation: true, candidates: [
          { id: "detailed", template: "detailed", line: "preparation", purpose: "exploration" },
          { id: "screen", template: "screen", line: "preparation", purpose: "falsification" },
        ] }, experiments: { detailed, screen: screening } };
    }) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const protocol = quantumComparisonProtocol();
  const report = await compareResearchStrategies(protocol, pinCommand(protocol.executor, process.cwd()), new AbortController().signal);
  console.log(JSON.stringify(report, null, 2));
}
