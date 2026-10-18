import { digest, identifier, invariant } from "./kernel.ts";
import { fields, hash, type ExperimentContext, type ExperimentSpec, type ResearchOutcome,
  type ResearchSpec, type ValidatorReport } from "./research.ts";
import type { ResearchStrategy } from "./researchStrategy.ts";
import type { Json } from "./types.ts";

/** Project-owned statements and oracle semantics. No logic, tactic, equation or
 * scientific field is built into the runtime. Premises bind complete protocols. */
export interface TheoryContract {
  schema: 1;
  statement: string;
  premises: { template: string; specHash: string }[];
}
export interface TheoryEvidence {
  targetHash: string;
  kind: "deduction" | "counterexample" | "bounded-check" | "heuristic";
  artifact: string;
  artifactHash: string;
  openObligations: string[];
}
export interface TheoryAssessment {
  targetHash: string;
  status: "ESTABLISHED" | "REFUTED" | "OPEN" | "CONFLICTED";
  certificates: { validator: string; kind: TheoryEvidence["kind"]; artifactHash: string }[];
}
export interface TheoryNode { specHash: string; targetHash: string; premises: string[] }
export type TheoryGraph = Record<string, TheoryNode>;
export interface CheckedTheoryPremise {
  template: string; specHash: string; targetHash: string; statement: string; assumptions: string[]; source: Json;
}
export const theoryTargetHash = (s: ExperimentSpec): string => digest({ statement: s.theory!.statement, assumptions: s.assumptions });

export function validateTheoryContract(s: ExperimentSpec): void {
  if (s.theory === undefined) return;
  fields(s.theory, ["schema", "statement", "premises"]);
  invariant(s.theory.schema === 1 && typeof s.theory.statement === "string" && s.theory.statement.trim().length > 0 &&
    Buffer.byteLength(s.theory.statement) <= 8192, "invalid theoretical statement");
  const premises = s.theory.premises;
  invariant(Array.isArray(premises) && premises.length <= 32 && new Set(premises.map(p => p.template)).size === premises.length,
    "invalid theoretical premises");
  for (const p of premises) { fields(p, ["template", "specHash"]); identifier(p.template); hash(p.specHash); }
}

/** Bind conclusive deductions/refutations to exact targets and complete trusted
 * artifacts. The independently pinned oracle remains responsible for semantics,
 * including axiom audits and proving that every obligation was discharged. */
export function validateTheoryEvidence(s: ExperimentSpec, r: ValidatorReport, context: ExperimentContext): void {
  if (!s.theory) { invariant(r.theory === undefined, "theory evidence requires a frozen theory contract"); return; }
  const t = r.theory;
  fields(t, ["targetHash", "kind", "artifact", "artifactHash", "openObligations"]);
  invariant(t!.targetHash === theoryTargetHash(s), "theoretical target or assumptions changed");
  invariant(["deduction", "counterexample", "bounded-check", "heuristic"].includes(t!.kind), "unknown theoretical evidence kind");
  identifier(t!.artifact); hash(t!.artifactHash);
  const artifact = (context.artifacts as any)[t!.artifact];
  invariant(s.artifacts.some(a => a.id === t!.artifact) && artifact?.sha256 === t!.artifactHash &&
    artifact.bytes > 0 && artifact.truncated !== true, "theory certificate is not a complete required artifact");
  invariant(Array.isArray(t!.openObligations) && t!.openObligations.length <= 32 &&
    new Set(t!.openObligations).size === t!.openObligations.length &&
    t!.openObligations.every(o => typeof o === "string" && o.trim().length > 0 && Buffer.byteLength(o) <= 2048),
    "invalid open proof obligations");
  invariant(r.outcome === "INCONCLUSIVE" || t!.openObligations.length === 0, "conclusive theory result has open obligations");
  invariant(r.outcome !== "SUPPORTED" || t!.kind === "deduction", "support of a theoretical statement requires a checked deduction");
  invariant(r.outcome !== "REFUTED" || t!.kind === "counterexample", "theoretical refutation requires a checked counterexample");
}

export function validateTheoryContext(s: ExperimentSpec, context: ExperimentContext): void {
  const expected = s.theory?.premises ?? [];
  const premises = context.theoryPremises ?? [];
  invariant(s.theory || context.theoryPremises === undefined, "theoretical premises require a frozen theory contract");
  invariant(Array.isArray(premises) && premises.length === expected.length && new Set(premises.map(p => p.template)).size === premises.length,
    "incomplete checked theoretical premises");
  for (const p of premises) {
    fields(p, ["template", "specHash", "targetHash", "statement", "assumptions", "source"]);
    invariant(expected.some(e => e.template === p.template && e.specHash === p.specHash), "checked theoretical premise changed");
    invariant(typeof p.statement === "string" && p.statement.trim().length > 0 && Buffer.byteLength(p.statement) <= 8192 &&
      Array.isArray(p.assumptions) && p.assumptions.length <= 64 && p.assumptions.every(a => s.assumptions.includes(a)) &&
      p.targetHash === digest({ statement: p.statement, assumptions: p.assumptions }), "checked theoretical premise target changed");
    validatePremiseSource(p.source);
  }
}

function validatePremiseSource(source: Json): void {
  invariant(source && typeof source === "object" && !Array.isArray(source), "missing theoretical premise source");
  hash((source as any).assessmentHash);
}

export function assessTheory(s: ExperimentSpec, reports: ValidatorReport[], outcome: ResearchOutcome, conflicted: boolean): TheoryAssessment {
  return { targetHash: theoryTargetHash(s), status: conflicted ? "CONFLICTED" : outcome === "SUPPORTED" ? "ESTABLISHED" :
    outcome === "REFUTED" ? "REFUTED" : "OPEN", certificates: reports.map(r => ({ validator: r.validator,
      kind: r.theory!.kind, artifactHash: r.theory!.artifactHash })).sort((a, b) => a.validator.localeCompare(b.validator)) };
}

export function validateTheoryTemplates(specs: Record<string, ResearchSpec>): void {
  const seen = new Set<string>(), visiting = new Set<string>();
  const visit = (name: string) => {
    invariant(!visiting.has(name), "cyclic theoretical premises"); if (seen.has(name)) return;
    const s = specs[name]; invariant(s, "unknown theoretical template");
    visiting.add(name);
    if (s.schema === 2 && s.theory) {
      validateTheoryContract(s);
      for (const p of s.theory.premises) {
        const premise = specs[p.template];
        invariant(premise?.schema === 2 && premise.theory && digest(premise) === p.specHash,
          "theoretical premise must bind an exact configured theory protocol");
        invariant(premise.assumptions.every(a => s.assumptions.includes(a)), "theoretical premise widens allowed assumptions");
        visit(p.template);
      }
    }
    visiting.delete(name); seen.add(name);
  };
  Object.keys(specs).forEach(visit);
}

/** Derive proof dependencies from frozen protocols, not from model scores or a
 * second task DAG. Check the combined outcome/proof graph for deadlocks. */
export function theoryGraph(strategy: ResearchStrategy, specs: Record<string, ResearchSpec>): TheoryGraph {
  validateTheoryTemplates(specs);
  const byTemplate = new Map(strategy.candidates.map(c => [c.template, c.id])), graph: TheoryGraph = {};
  for (const c of strategy.candidates) {
    const s = specs[c.template];
    if (s?.schema !== 2 || !s.theory) continue;
    invariant(strategy.frontier, "theoretical research strategy requires a parallel frontier");
    graph[c.id] = { specHash: digest(s), targetHash: theoryTargetHash(s), premises: s.theory.premises.map(p => {
      const id = byTemplate.get(p.template); invariant(id, "theoretical premise is missing from research frontier"); return id;
    }) };
  }
  validateTheoryGraph(strategy, graph);
  return graph;
}

export function validateTheoryGraph(strategy: ResearchStrategy, graph: TheoryGraph): void {
  const candidates = new Map(strategy.candidates.map(c => [c.id, c])), seen = new Set<string>(), visiting = new Set<string>();
  for (const [id, node] of Object.entries(graph)) {
    invariant(candidates.has(id), "unknown theoretical frontier candidate");
    fields(node, ["specHash", "targetHash", "premises"]); hash(node.specHash); hash(node.targetHash);
    invariant(Array.isArray(node.premises) && node.premises.length <= 32 && new Set(node.premises).size === node.premises.length &&
      node.premises.every(p => Object.hasOwn(graph, p)), "unknown or duplicate theoretical frontier premise");
  }
  const visit = (id: string) => {
    invariant(!visiting.has(id), "cyclic combined research dependencies"); if (seen.has(id)) return;
    visiting.add(id);
    for (const dep of [...(graph[id]?.premises ?? []), ...(candidates.get(id)?.after ?? []).map(a => a.candidate)]) visit(dep);
    visiting.delete(id); seen.add(id);
  };
  strategy.candidates.forEach(c => visit(c.id));
}
