/** Offline checked deductions: independent lemmas, then exact composition.
 * This measures orchestration/checking only, without an LLM productivity claim. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { canonical, digest, sha256 } from "../src/harness/foundry/kernel.ts";
import { invoke, pinCommand } from "../src/harness/foundry/commands.ts";
import { selectResearchFrontier } from "../src/harness/foundry/researchFrontier.ts";
import { runResearchValidation } from "../src/harness/foundry/researchValidation.ts";
import { theoryGraph, theoryTargetHash } from "../src/harness/foundry/theory.ts";

export function theoreticalResearchExample(count = 8) {
  if (!Number.isInteger(count) || count < 2 || count > 16) throw new Error("Use 2..16 independent example lemmas");
  const path = name => fileURLToPath(new URL(name, import.meta.url));
  const executor = path("../examples/theoretical-research/proof-executor.mjs"), checker = path("../examples/theoretical-research/proof-validator.mjs");
  const command = file => ({ argv: [process.execPath, "--experimental-strip-types", file], files: [path("../src/harness/foundry/kernel.ts")] });
  const assumptions = [canonical("P"), ...Array.from({ length: count }, (_, n) => canonical(["implies", "P", `Q${n}`]))];
  const makeSpec = (statement, premises, axiomIndices, premiseStatements) => ({ schema: 2, kind: "project-defined-deductive-logic",
    question: "Can this exact statement be derived under the allowed assumptions?", hypothesis: statement,
    assumptions, refutation: "A checked countermodel to this exact entailment.", protocol: "Independent natural deduction kernel with explicit lemma imports",
    theory: { schema: 1, statement, premises }, identity: { code: digest([sha256(readFileSync(executor)), sha256(readFileSync(checker))]),
      data: digest({ statement, assumptions }), environment: digest({ node: process.version }) },
    parameters: { axiomIndices, premiseStatements }, input: {}, acceptance: "supported-hypothesis",
    execution: { mode: "computational", backend: "local-proof-constructor", configurationHash: digest("natural-deduction-example-v1") },
    units: [{ id: "argument", role: "primary", replicates: ["certificate"] }],
    artifacts: [{ id: "proof", minimumBytes: 1, maximumBytes: 32768 }],
    validation: [{ id: "kernel", checks: ["kernel-inference", "target-and-axioms", "certificate-binding"] }] });
  const specs = Object.fromEntries(Array.from({ length: count }, (_, n) => [`lemma${n}`, makeSpec(canonical(`Q${n}`), [], [0, n + 1], {})]));
  const terms = Array.from({ length: count }, (_, n) => `Q${n}`);
  const conjunction = terms.slice(1).reduce((left, right) => ["and", left, right], terms[0]);
  specs.theorem = makeSpec(canonical(conjunction), Object.entries(specs).map(([template, spec]) => ({ template, specHash: digest(spec) })),
    [], Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, spec.theory.statement])));
  const strategy = { schema: 1, maxExperiments: count + 1, maxSnapshotBytes: 16384, stopOnRefutation: true,
    frontier: { maxParallel: count, explorationWeight: 1, maxInconclusivePerLine: 3 },
    candidates: Object.keys(specs).map(id => ({ id, template: id, line: id, purpose: "exploration" })) };
  return { specs, strategy, executor: command(executor), validator: { command: command(checker), readOnly: true, timeoutMs: 5000, maxOutputBytes: 32768 } };
}

export async function runTheoryDemo(count = 8) {
  const p = theoreticalResearchExample(count), graph = theoryGraph(p.strategy, p.specs);
  const executor = pinCommand(p.executor, process.cwd()), validator = { ...p.validator, command: pinCommand(p.validator.command, process.cwd()) };
  const observations = [], batches = [], records = [];
  const signal = AbortSignal.timeout(30000);
  while (observations.length < p.strategy.maxExperiments) {
    const batch = selectResearchFrontier(p.strategy, observations, observations.length, { theory: graph }).batch;
    if (!batch.length) break;
    batches.push(batch);
    const results = await Promise.all(batch.map(async id => {
      const spec = p.specs[id], key = digest({ id, spec: digest(spec) });
      const raw = await invoke(executor, { spec, execution: { key, jobId: key } }, 65536, signal);
      const theoryPremises = spec.theory.premises.map(premise => {
        const s = p.specs[premise.template], observation = observations.find(o => o.candidate === premise.template);
        return { ...premise, statement: s.theory.statement, assumptions: s.assumptions, targetHash: theoryTargetHash(s),
          source: { assessmentHash: digest(observation.assessment) } };
      });
      const validated = await runResearchValidation(spec, raw.result, { key, jobId: key, adapterHash: digest(executor), artifacts: raw.artifacts,
        ...(theoryPremises.length ? { theoryPremises } : {}) }, { kernel: validator }, signal,
      { legacyTimeoutMs: 5000, maxOutputBytes: 32768 });
      return { candidate: id, key, assessment: validated.assessment };
    }));
    observations.push(...results); records.push(...results.map(o => ({ candidate: o.candidate, ...o.assessment.theory })));
  }
  return { schema: 1, scope: "OFFLINE_DEDUCTIVE_ORCHESTRATION_WITHOUT_LIVE_LLM", batches, established: records.filter(r => r.status === "ESTABLISHED").length,
    obligations: Object.keys(p.specs).length, theorem: observations.find(o => o.candidate === "theorem")?.assessment.theory ?? null,
    records, tokens: null, costUsd: null };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runTheoryDemo();
  console.log(JSON.stringify(result, null, 2));
  if (result.established !== result.obligations) process.exitCode = 1;
}
