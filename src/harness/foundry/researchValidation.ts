import * as legacy from "../../../adapters/research/legacy.ts";
import { checkPins, invoke } from "./commands.ts";
import { digest, invariant, positive } from "./kernel.ts";
import { assessResearch, fields, validateExperimentResult, validateResearchSpec,
  validatePlanReport, type ExperimentPlanContext, type ExperimentContext, type ExperimentSpec, type ResearchAssessment, type ResearchSpec } from "./research.ts";
import type { CommandSpec, Json, PinnedCommand } from "./types.ts";

export interface ScientificValidator {
  command: CommandSpec;
  readOnly: true;
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface PinnedScientificValidator extends Omit<ScientificValidator, "command"> { command: PinnedCommand }
export interface ResearchConfiguration {
  spec: ResearchSpec;
  validators?: Record<string, ScientificValidator>;
  /** Schema-1 compatibility only. New protocols use validators. */
  proofChecker?: CommandSpec;
  provides?: string;
}
export const researchValidatorIds = (s: ExperimentSpec): string[] => [...new Set([...s.validation, ...(s.planValidation ?? [])].map(v => v.id))];

export function validateResearchConfiguration(config: ResearchConfiguration, executor?: CommandSpec): void {
  fields(config, ["spec"], ["validators", "proofChecker", "provides"]); validateResearchSpec(config.spec);
  if (config.spec.schema === 1) {
    legacy.validateResearchSpec(config.spec as any);
    invariant(config.validators === undefined && legacy.requiresIndependentAudit(config.spec as any) === !!config.proofChecker,
      "legacy protocol requires its independent audit configuration");
    if (config.proofChecker) fields(config.proofChecker, ["argv"], ["envAllow", "files"]);
    return;
  }
  invariant(config.proofChecker === undefined && config.validators, "schema-2 experiments require independent validators");
  fields(config.validators, researchValidatorIds(config.spec));
  for (const validator of Object.values(config.validators)) {
    fields(validator, ["command", "readOnly", "timeoutMs", "maxOutputBytes"]);
    fields(validator.command, ["argv"], ["envAllow", "files"]);
    invariant(validator.readOnly === true, "scientific validators must declare read-only replay semantics");
    positive(validator.timeoutMs, 3600000, "scientific validator timeout"); positive(validator.maxOutputBytes, 65536, "scientific validator output");
    invariant(!executor || digest(validator.command) !== digest(executor), "scientific validator must be separate from the experiment executor");
  }
}
export const supportsResearchComparison = (s: ResearchSpec): boolean => s.schema === 2 || legacy.supportsLocalComparison(s as any);

/** The runtime supplies commands and context. Neither comes from worker JSON.
 * Cached reports are safe only under the SAME result/context/implementation bindings. */
export async function runResearchValidation(s: ResearchSpec, raw: unknown, context: ExperimentContext,
  validators: Record<string, PinnedScientificValidator>, signal: AbortSignal,
  options: { legacyChecker?: PinnedCommand; legacyTimeoutMs: number; maxOutputBytes: number;
    cached?: { id: string; implementationHash: string; report: unknown }[];
    onReport?: (id: string, implementationHash: string, requestHash: string, report: Json) => void }): Promise<{
      assessment: ResearchAssessment; evidence: Json[]; legacyAudit?: Json;
    }> {
  if (s.schema === 1) {
    let audit: unknown;
    if (legacy.requiresIndependentAudit(s as any)) {
      invariant(options.legacyChecker, "independent legacy checker missing");
      audit = await invoke(options.legacyChecker, { schema: 1, spec: s, result: raw }, options.maxOutputBytes,
        AbortSignal.any([signal, AbortSignal.timeout(options.legacyTimeoutMs)]));
    }
    return { assessment: legacy.assessResearch(s as any, raw, audit), evidence: [], ...(audit ? { legacyAudit: audit as Json } : {}) };
  }
  validateExperimentResult(s, raw, context); fields(validators, researchValidatorIds(s));
  const reports: { id: string; implementationHash: string; report: unknown }[] = [];
  for (const requirement of s.validation) {
    const validator = validators[requirement.id]; checkPins(validator.command);
    const implementationHash = digest(validator.command);
    const cached = options.cached?.find(c => c.id === requirement.id);
    if (options.cached) {
      invariant(cached?.implementationHash === implementationHash, "cached scientific validator implementation changed");
      reports.push(cached); continue;
    }
    const request = { schema: 1, validator: requirement.id, implementationHash, spec: s, result: raw, context };
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), validator.timeoutMs);
    try {
      const report = await invoke(validator.command, request, validator.maxOutputBytes, AbortSignal.any([signal, deadline.signal]));
      signal.throwIfAborted();
      options.onReport?.(requirement.id, implementationHash, digest(request), report as Json);
      reports.push({ id: requirement.id, implementationHash, report });
    } finally { clearTimeout(timer); }
    signal.throwIfAborted();
  }
  return { assessment: assessResearch(s, raw, context, reports), evidence: reports.map(r => r.report as Json) };
}

/** Read-only checks may be rerun after interruption. Persist each complete report
 * before interpreting it so a rejected plan cannot silently acquire a new verdict. */
export async function runPlanValidation(s: ExperimentSpec, context: ExperimentPlanContext,
  validators: Record<string, PinnedScientificValidator>, signal: AbortSignal,
  options: { cached?: { id: string; implementationHash: string; report: unknown }[];
    onReport?: (id: string, implementationHash: string, requestHash: string, report: Json) => void } = {}): Promise<void> {
  validateResearchSpec(s); fields(validators, researchValidatorIds(s));
  for (const requirement of s.planValidation ?? []) {
    signal.throwIfAborted();
    const validator = validators[requirement.id]; checkPins(validator.command);
    const implementationHash = digest(validator.command);
    const request = { schema: 1, phase: "plan", validator: requirement.id, implementationHash, spec: s, context };
    const cached = options.cached?.find(c => c.id === requirement.id);
    let report: unknown;
    if (cached) {
      invariant(cached.implementationHash === implementationHash, "cached plan validator implementation changed");
      report = cached.report;
    } else {
      const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), validator.timeoutMs);
      try {
        report = await invoke(validator.command, request, validator.maxOutputBytes, AbortSignal.any([signal, deadline.signal]));
        signal.throwIfAborted();
        options.onReport?.(requirement.id, implementationHash, digest(request), report as Json);
      } finally { clearTimeout(timer); }
    }
    signal.throwIfAborted(); checkPins(validator.command);
    validatePlanReport(s, context, requirement.id, implementationHash, report);
  }
}
