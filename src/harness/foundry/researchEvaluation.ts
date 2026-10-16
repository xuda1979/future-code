import { performance } from "node:perf_hooks";
import { digest, identifier, invariant } from "./kernel.ts";
import { checkPins, invoke, pinCommand } from "./commands.ts";
import { fields, type ResearchSpec } from "./research.ts";
import { runResearchValidation, supportsResearchComparison, validateResearchConfiguration,
  type ScientificValidator, type PinnedScientificValidator } from "./researchValidation.ts";
import { selectResearchStrategy, validateResearchStrategy, type ResearchStrategy, type StrategyObservation } from "./researchStrategy.ts";
import type { CommandSpec, PinnedCommand } from "./types.ts";

export interface ResearchComparisonProtocol {
  schema: 1;
  name: string;
  executor: CommandSpec;
  validators?: Record<string, ScientificValidator>;
  maxArmMs: number;
  maxOutputBytes: number;
  cases: { id: string; strategy: ResearchStrategy; experiments: Record<string, ResearchSpec> }[];
}
export function validateResearchComparison(p: ResearchComparisonProtocol): void {
  fields(p, ["schema", "name", "executor", "maxArmMs", "maxOutputBytes", "cases"], ["validators"]); identifier(p.name);
  fields(p.executor, ["argv"], ["envAllow", "files"]);
  invariant(p.schema === 1 && Number.isSafeInteger(p.maxArmMs) && p.maxArmMs > 0 && p.maxArmMs <= 3600000 &&
    Number.isSafeInteger(p.maxOutputBytes) && p.maxOutputBytes >= 1024 && p.maxOutputBytes <= 65536, "unbounded research comparison");
  invariant(Array.isArray(p.cases) && p.cases.length > 0 && p.cases.length <= 16 && new Set(p.cases.map(c => c.id)).size === p.cases.length, "invalid research cases");
  const requiredValidators = new Set<string>();
  for (const c of p.cases) {
    fields(c, ["id", "strategy", "experiments"]); identifier(c.id); validateResearchStrategy(c.strategy);
    const templates = c.strategy.candidates.map(c => c.template);
    fields(c.experiments, templates);
    for (const s of Object.values(c.experiments)) {
      if (s.schema === 2) s.validation.forEach(v => requiredValidators.add(v.id));
      const validators = s.schema === 2 ? Object.fromEntries(s.validation.map(v => [v.id, p.validators?.[v.id]])) : undefined;
      validateResearchConfiguration({ spec: s, ...(validators ? { validators } : {}) }, p.executor);
      invariant(supportsResearchComparison(s), "legacy protocol requires its independent checker path");
    }
  }
  fields(p.validators ?? {}, [...requiredValidators]);
}

/** Matched LOCAL experiment comparison, not live-agent or physical hardware certification.
 * Both arms use the same pinned executor, cases, seeds, frozen specs and ceilings.
 * The executor receives no arm label. Never use this non-durable runner to submit
 * remote side effects; remote evaluations must use reconciled ResearchJobs. */
export async function compareResearchStrategies(p: ResearchComparisonProtocol, executor: PinnedCommand, signal: AbortSignal) {
  validateResearchComparison(p); checkPins(executor);
  invariant(digest(executor) === digest(pinCommand(p.executor, process.cwd())), "comparison executor differs from pinned protocol");
  const validators: Record<string, PinnedScientificValidator> = Object.fromEntries(Object.entries(p.validators ?? {}).map(([id, v]) => [id,
    { ...v, command: pinCommand(v.command, process.cwd()) }]));
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
            const key = digest({ protocol: digest(p), case: c.id, arm, candidate: id });
            const raw: any = await invoke(executor, { schema: spec.schema, spec,
              ...(spec.schema === 2 ? { execution: { key, jobId: key } } : {}) }, p.maxOutputBytes, bounded);
            if (spec.schema === 2) fields(raw, ["result", "artifacts"]); else fields(raw, ["result"], ["audit"]);
            bounded.throwIfAborted();
            record.resultHash = digest(raw.result);
            const selected = spec.schema === 2 ? Object.fromEntries(spec.validation.map(v => [v.id, validators[v.id]])) : {};
            const validation = await runResearchValidation(spec, raw.result, { key, jobId: key, adapterHash: digest(executor),
              artifacts: raw.artifacts ?? {} }, selected, bounded, { legacyTimeoutMs: p.maxArmMs, maxOutputBytes: p.maxOutputBytes,
                onReport: (_id, _implementationHash, _requestHash, report) => (record.validationEvidence ??= []).push(report) });
            const assessment = validation.assessment;
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
    ...(Object.keys(validators).length ? { validatorHashes: Object.fromEntries(Object.entries(validators).map(([id, v]) => [id, digest(v.command)])) } : {}),
    cases: results, totalJobsSaved: results.reduce((n, r) => n + r.jobsSaved, 0),
    allEvidenceValid: results.every(r => Object.values(r.arms).every((a: any) => a.status === "COMPLETE")),
    limitations: ["Static-all is a declared baseline, not every static planner", "Local experiment evidence, not live-LLM productivity or physical hardware performance",
      "Wall time includes process startup; no unmetered token or dollar cost is inferred", "No automatic policy promotion or general superiority claim"] };
}
