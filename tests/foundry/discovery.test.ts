import { test } from "node:test";
import assert from "node:assert/strict";
import { digest } from "../../src/harness/foundry/kernel.ts";
import { discoveryContext, retainDiscoveryElites, validateDiscoveryReport, validateDiscoverySpec } from "../../src/harness/foundry/discovery.ts";
import type { DiscoverySpec, DiscoveryTrial } from "../../src/harness/foundry/discovery.ts";

export const spec: DiscoverySpec = {
  schema: 1, name: "general-program-search",
  task: { specification: "Produce a program satisfying the declared behavior.", interface: { format: "opaque-project-json" },
    checks: ["behavior", "invariants"], objective: { metric: "cost", direction: "min" },
    axes: [{ metric: "time", boundaries: [10, 20] }, { metric: "space", boundaries: [10, 20] }] },
  search: { families: 2, rounds: 4, migrationInterval: 2, contextCandidates: 3, contextBytes: 20000,
    candidateBytes: 2048, outputBytes: 16000, parallelism: 2, timeoutMs: 5000 },
  proposer: { argv: ["$RUNTIME", "./tests/foundry/discovery-fixtures/proposer.mjs"] },
  evaluator: { argv: ["$RUNTIME", "./tests/foundry/discovery-fixtures/evaluator.mjs"] }
};
export function trial(family: string, round: number, time: number, space: number, valid = true): DiscoveryTrial {
  const proposal = { candidate: { time, space, valid }, notes: ["A reusable observation."] };
  return { family, round, artifactHash: digest({ family, round, proposal }), parent: null, inspirations: [], proposal,
    report: { schema: 1, protocolHash: digest(spec.task), candidateHash: digest(proposal.candidate),
      checks: spec.task.checks.map(id => ({ id, verdict: valid ? "PASS" : "FAIL" })),
      metrics: { time, space, cost: time * space }, feedback: valid ? "Checked." : "Counterexample found." } };
}
test("discovery keeps per-family per-cell tradeoffs and rejects attractive invalid candidates", () => {
  const trials = [trial("a", 1, 15, 15), trial("a", 2, 12, 12), trial("a", 3, 6, 25),
    trial("b", 1, 19, 19), trial("a", 4, 1, 1, false)];
  const elites = retainDiscoveryElites(spec, trials);
  assert.equal(elites.length, 3);
  assert.deepEqual(elites.map(e => [e.family, e.report.metrics.cost]).sort(), [["a", 144], ["a", 150], ["b", 361]]);
  // Independent numeric expectations: 12*12 and 6*25 occupy different cells;
  // a worse early family survives protection; failed cost=1 never enters.
  assert.equal(elites.some(e => e.report.metrics.cost === 1), false);
});
test("migration is periodic and never replaces a family's parent with a foreign program", () => {
  const families = [{ id: "a", approach: "Algorithm A" }, { id: "b", approach: "Algorithm B" }];
  const trials = [trial("a", 1, 12, 12), trial("b", 1, 6, 6), trial("a", 2, 1, 1, false)];
  const privateContext = discoveryContext(spec, families[0], 2, trials.filter(t => t.round < 2));
  assert.equal(privateContext.alternatives.some(a => a.family === "b"), false);
  const shared = discoveryContext(spec, families[0], 3, trials);
  assert.equal(shared.parent!.family, "a");
  assert.equal(shared.alternatives.some(a => a.family === "b"), true);
  assert.match(shared.previous!.feedback, /Counterexample/);
  assert.equal(shared.parent!.candidateHash, trials[0].report.candidateHash);
});
test("evaluator receipts fail closed on stale candidates, missing checks, metrics and nonfinite values", () => {
  const t = trial("a", 1, 4, 5);
  validateDiscoveryReport(spec, t.proposal.candidate, t.report);
  assert.throws(() => validateDiscoveryReport(spec, { other: true }, t.report), /binding/);
  assert.throws(() => validateDiscoveryReport(spec, t.proposal.candidate, { ...t.report, protocolHash: "0".repeat(64) }), /binding/);
  assert.throws(() => validateDiscoveryReport(spec, t.proposal.candidate, { ...t.report, checks: t.report.checks.slice(1) }), /checks/);
  assert.throws(() => validateDiscoveryReport(spec, t.proposal.candidate, { ...t.report, metrics: { cost: 0 } }), /metric/);
  assert.throws(() => validateDiscoveryReport(spec, t.proposal.candidate, { ...t.report, metrics: { ...t.report.metrics, cost: Infinity } }), /finite/);
  const failed = trial("a", 1, 1, 1, false);
  validateDiscoveryReport(spec, failed.proposal.candidate, { ...failed.report, metrics: {} });
});
test("configuration freezes finite search budgets, generic metrics and cell boundaries", () => {
  validateDiscoverySpec(spec);
  assert.throws(() => validateDiscoverySpec({ ...spec, search: { ...spec.search, rounds: 0 } }), /rounds/);
  assert.throws(() => validateDiscoverySpec({ ...spec, task: { ...spec.task, axes: [{ metric: "time", boundaries: [10, 10] }] } }), /boundaries/);
  const max = { ...spec, task: { ...spec.task, objective: { metric: "cost", direction: "max" as const } } };
  const values = [trial("a", 1, 11, 11), trial("a", 2, 15, 15)];
  for (const value of values) value.report.protocolHash = digest(max.task);
  assert.equal(retainDiscoveryElites(max, values)[0].report.metrics.cost, 225);
});
