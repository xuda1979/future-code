/** Exercises arbitrary project labels/data layouts through the SAME core protocol. */
import { fileURLToPath } from "node:url";
import { tableFixtureSpec } from "../adapters/research/table-fixture.mjs";
import { pinCommand } from "../src/harness/foundry/commands.ts";
import { compareResearchStrategies } from "../src/harness/foundry/researchEvaluation.ts";
const file = path => fileURLToPath(new URL(path, import.meta.url));
const executor = { argv: [process.execPath, "--experimental-strip-types", file("../adapters/research/table-fixture.mjs"), "--evaluate"],
  files: [file("../adapters/research/paired-table-validator.mjs"), file("../src/harness/foundry/kernel.ts")] };
const analysis = { command: { argv: [process.execPath, "--experimental-strip-types", file("../adapters/research/paired-table-validator.mjs")],
  files: [file("../src/harness/foundry/kernel.ts"), file("../src/harness/foundry/research.ts")] }, readOnly: true, timeoutMs: 3000, maxOutputBytes: 16384 };
const cases = [tableFixtureSpec("project-a"), tableFixtureSpec("project-b", "/nested/signal", true)].map((spec, i) => ({
  id: `case${i}`, strategy: { schema: 1, maxExperiments: 1, maxSnapshotBytes: 4096, stopOnRefutation: true,
    candidates: [{ id: "trial", template: "trial", line: "hypothesis", purpose: "falsification" }] }, experiments: { trial: { ...spec, planValidation: [{ id: "analysis", checks: ["analysis-parameters", "paired-design"] }] } } }));
const protocol = { schema: 1, name: "domain-neutral-fixture-demo", executor, validators: { analysis }, maxArmMs: 10000, maxOutputBytes: 65536, cases };
const report = await compareResearchStrategies(protocol, pinCommand(executor, process.cwd()), new AbortController().signal);
console.log(JSON.stringify(report, null, 2));
