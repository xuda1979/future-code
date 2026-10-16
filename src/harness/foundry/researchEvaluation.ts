import { performance } from "node:perf_hooks";
import { digest, identifier, invariant } from "./kernel.ts";
import { checkPins, invoke, pinCommand } from "./commands.ts";
import { assessResearch, fields, validateResearchSpec, type ResearchSpec } from "./research.ts";
import { selectResearchStrategy, validateResearchStrategy, type ResearchStrategy, type StrategyObservation } from "./researchStrategy.ts";
import type { CommandSpec, PinnedCommand } from "./types.ts";

export interface ResearchComparisonProtocol {
  schema: 1;
  name: string;
  executor: CommandSpec;
  maxArmMs: number;
  maxOutputBytes: number;
  cases: { id: string; strategy: ResearchStrategy; experiments: Record<string, ResearchSpec> }[];
}
export function validateResearchComparison(p: ResearchComparisonProtocol): void {
  fields(p, ["schema", "name", "executor", "maxArmMs", "maxOutputBytes", "cases"]); identifier(p.name);
  fields(p.executor, ["argv"], ["envAllow", "files"]);
  invariant(p.schema === 1 && Number.isSafeInteger(p.maxArmMs) && p.maxArmMs > 0 && p.maxArmMs <= 3600000 &&
    Number.isSafeInteger(p.maxOutputBytes) && p.maxOutputBytes >= 1024 && p.maxOutputBytes <= 65536, "unbounded research comparison");
  invariant(Array.isArray(p.cases) && p.cases.length > 0 && p.cases.length <= 16 && new Set(p.cases.map(c => c.id)).size === p.cases.length, "invalid research cases");
  for (const c of p.cases) {
    fields(c, ["id", "strategy", "experiments"]); identifier(c.id); validateResearchStrategy(c.strategy);
    const templates = c.strategy.candidates.map(c => c.template);
    fields(c.experiments, templates);
    for (const s of Object.values(c.experiments)) {
      validateResearchSpec(s); invariant(s.kind !== "formal-proof", "numerical comparison requires count/metric experiments; formal proofs use the separate independent checker path");
    }
  }
}

/** Matched LOCAL experiment comparison, not a live-agent or QPU certification.
 * Both arms use the same pinned executor, cases, seeds, frozen specs and ceilings.
 * The executor receives no arm label. Never use this non-durable runner to submit
 * remote side effects; remote evaluations must use reconciled ResearchJobs. */
export async function compareResearchStrategies(p: ResearchComparisonProtocol, executor: PinnedCommand, signal: AbortSignal) {
  validateResearchComparison(p); checkPins(executor);
  invariant(digest(executor) === digest(pinCommand(p.executor, process.cwd())), "comparison executor differs from pinned protocol");
  const results: any[] = [];
  for (let i = 0; i < p.cases.length; i++) {
    const c = p.cases[i]; const arms: Record<string, any> = {};
    for (const arm of i % 2 ? ["adaptive", "static-all"] : ["static-all", "adaptive"]) {
      signal.throwIfAborted();
      const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), p.maxArmMs);
      const bounded = AbortSignal.any([signal, deadline.signal]);
      const observations: StrategyObservation[] = [], records: any[] = [];
      const started = performance.now(); let status = "COMPLETE";
      try {
        while (records.length < c.strategy.maxExperiments) {
          const id = arm === "adaptive" ? selectResearchStrategy(c.strategy, observations, records.length).next :
            c.strategy.candidates.find(candidate => !records.some(r => r.candidate === candidate.id))?.id;
          if (!id) break;
          const candidate = c.strategy.candidates.find(candidate => candidate.id === id)!, spec = c.experiments[candidate.template];
          const jobStarted = performance.now();
          const record: any = { candidate: id, line: candidate.line, specHash: digest(spec), status: "INVALID" }; records.push(record);
          try {
            const raw: any = await invoke(executor, { schema: 1, spec }, p.maxOutputBytes, bounded);
            fields(raw, ["result"], ["audit"]); bounded.throwIfAborted();
            const assessment = assessResearch(spec, raw.result, raw.audit);
            Object.assign(record, { status: "VALID", resultHash: digest(raw.result), assessment });
            observations.push({ key: digest({ case: c.id, candidate: id }), candidate: id, assessment });
          } finally { record.durationMs = Math.max(0, performance.now() - jobStarted); }
        }
      } catch {
        signal.throwIfAborted(); status = deadline.signal.aborted ? "TIMED_OUT" : "INVALID_EVIDENCE";
      } finally { clearTimeout(timer); }
      arms[arm] = { status, jobs: records.length, validExperiments: observations.length,
        durationMs: Math.max(0, performance.now() - started), records,
        refutedLines: [...new Set(records.filter(r => r.assessment?.outcome === "REFUTED").map(r => r.line))].sort(),
        tokens: null, costUsd: null };
    }
    results.push({ case: c.id, order: i % 2 ? ["adaptive", "static-all"] : ["static-all", "adaptive"], arms,
      jobsSaved: arms["static-all"].jobs - arms.adaptive.jobs,
      sameRefutedLines: digest(arms["static-all"].refutedLines) === digest(arms.adaptive.refutedLines) });
  }
  return { schema: 1, kind: "MATCHED_LOCAL_EXPERIMENT_COMPARISON", protocolHash: digest(p), executorHash: digest(executor),
    cases: results, totalJobsSaved: results.reduce((n, r) => n + r.jobsSaved, 0),
    allEvidenceValid: results.every(r => Object.values(r.arms).every((a: any) => a.status === "COMPLETE")),
    limitations: ["Static-all is a declared baseline, not every static planner", "Local experiment evidence, not live-LLM productivity or QPU hardware performance",
      "Wall time includes process startup; no unmetered token or dollar cost is inferred", "No automatic policy promotion or general superiority claim"] };
}
