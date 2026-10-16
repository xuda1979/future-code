import { canonical, digest, identifier, invariant } from "./kernel.ts";
import type { Json } from "./types.ts";

export type ResearchOutcome = "SUPPORTED" | "REFUTED" | "INCONCLUSIVE";
interface ResearchBase {
  question: string;
  hypothesis: string;
  assumptions: string[];
  refutation: string;
  protocol: string;
  identity: { code: string; data: string; environment: string };
  input: Json;
  acceptance: "valid-result" | "supported-hypothesis";
}
/** Existing stores remain readable through a compatibility adapter. The core
 * neither interprets these extension fields nor enumerates scientific domains. */
export interface LegacyResearchSpec extends ResearchBase { schema: 1; kind: string; [key: string]: any }
export interface ExperimentSpec extends ResearchBase {
  schema: 2;
  kind: string;
  /** Frozen opaque method parameters, interpreted only by configured validators. */
  parameters: Json;
  execution: { mode: "computational" | "simulation" | "physical"; backend: string; configurationHash: string };
  units: { id: string; role: "primary" | "control" | "reference"; replicates: string[] }[];
  artifacts: { id: string; minimumBytes: number; maximumBytes: number }[];
  validation: { id: string; checks: string[] }[];
  /** Optional, frozen checks required before any experiment submission. */
  planValidation?: { id: string; checks: string[] }[];
}
export type ResearchSpec = ExperimentSpec | LegacyResearchSpec;
export interface ExperimentContext {
  key: string;
  jobId: string;
  adapterHash: string;
  artifacts: Json;
}
export interface ExperimentPlanContext { key: string; adapterHash: string; inputHash: string }
export interface PlanValidatorReport {
  schema: 1; phase: "plan"; validator: string; implementationHash: string;
  specHash: string; contextHash: string;
  checks: { id: string; verdict: "PASS" | "FAIL" | "UNKNOWN"; detail?: string }[];
}
export interface ValidatorReport {
  schema: 1;
  validator: string;
  implementationHash: string;
  specHash: string;
  resultHash: string;
  contextHash: string;
  checks: { id: string; verdict: "PASS" | "FAIL" | "UNKNOWN"; detail?: string }[];
  outcome: ResearchOutcome;
  measurements?: Json;
}
export interface ResearchAssessment {
  schema: 1;
  specHash: string;
  resultHash: string;
  outcome: ResearchOutcome;
  estimates: { name: string; mean: number; lower: number; upper: number; samples: number }[];
  assumptions: string[];
  contextHash?: string;
  conflicted?: boolean;
  validation?: { id: string; implementationHash: string; reportHash: string }[];
}
export function fields(value: any, required: string[], optional: string[] = []): void {
  invariant(value && typeof value === "object" && !Array.isArray(value), "expected research object");
  invariant(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), "invalid research fields");
}
const text = (v: unknown, max = 8192) => invariant(typeof v === "string" && v.trim().length > 0 && v.length <= max, "invalid research text");
export const hash = (v: unknown) => invariant(typeof v === "string" && /^[a-f0-9]{64}$/.test(v), "invalid research hash");
function ids(v: unknown, max: number): asserts v is string[] {
  invariant(Array.isArray(v) && v.length > 0 && v.length <= max && new Set(v).size === v.length, "invalid research identifiers");
  v.forEach(identifier);
}
const base = ["schema", "kind", "question", "hypothesis", "assumptions", "refutation", "protocol", "identity", "input", "acceptance"];
export function validateResearchSpec(s: ResearchSpec): void {
  invariant(s && (s.schema === 1 || s.schema === 2), "unknown research schema");
  if (s.schema === 2) fields(s, [...base, "parameters", "execution", "units", "artifacts", "validation"], ["planValidation"]);
  else invariant(base.every(k => Object.hasOwn(s, k)), "incomplete legacy research specification");
  identifier(s.kind); [s.question, s.hypothesis, s.refutation, s.protocol].forEach(x => text(x));
  invariant(Array.isArray(s.assumptions) && s.assumptions.length <= 64 && new Set(s.assumptions).size === s.assumptions.length, "invalid assumptions");
  s.assumptions.forEach(x => text(x));
  fields(s.identity, ["code", "data", "environment"]); Object.values(s.identity).forEach(hash);
  invariant(["valid-result", "supported-hypothesis"].includes(s.acceptance), "invalid research acceptance");
  invariant(Buffer.byteLength(canonical(s)) <= 65536, "research specification too large");
  if (s.schema === 1) return;
  fields(s.execution, ["mode", "backend", "configurationHash"]);
  invariant(["computational", "simulation", "physical"].includes(s.execution.mode), "invalid execution mode");
  text(s.execution.backend, 512); hash(s.execution.configurationHash);
  invariant(Array.isArray(s.units) && s.units.length > 0 && s.units.length <= 128 && new Set(s.units.map(u => u.id)).size === s.units.length, "invalid experimental units");
  let count = 0;
  for (const unit of s.units) {
    fields(unit, ["id", "role", "replicates"]); identifier(unit.id); ids(unit.replicates, 1024);
    invariant(["primary", "control", "reference"].includes(unit.role), "invalid unit role"); count += unit.replicates.length;
  }
  invariant(count <= 10000, "experiment replication ceiling exceeded");
  invariant(Array.isArray(s.artifacts) && s.artifacts.length > 0 && s.artifacts.length <= 32 && new Set(s.artifacts.map(a => a.id)).size === s.artifacts.length, "invalid required artifacts");
  for (const a of s.artifacts) {
    fields(a, ["id", "minimumBytes", "maximumBytes"]); identifier(a.id);
    invariant(Number.isSafeInteger(a.minimumBytes) && Number.isSafeInteger(a.maximumBytes) && a.minimumBytes >= 0 &&
      a.maximumBytes > 0 && a.minimumBytes <= a.maximumBytes && a.maximumBytes <= 2 ** 40, "invalid artifact byte limits");
  }
  for (const requirements of [s.validation, ...(s.planValidation === undefined ? [] : [s.planValidation])]) {
    invariant(Array.isArray(requirements) && requirements.length > 0 && requirements.length <= 8 && new Set(requirements.map(v => v.id)).size === requirements.length, "invalid experiment validators");
    for (const v of requirements) { fields(v, ["id", "checks"]); identifier(v.id); ids(v.checks, 64); }
  }
}

/** Universal completeness/provenance checks. Scientific semantics belong to the
 * independently pinned validators, never to a model or the scheduler. */
export function validateExperimentResult(s: ExperimentSpec, raw: unknown, context: ExperimentContext): void {
  validateResearchSpec(s);
  fields(context, ["key", "jobId", "adapterHash", "artifacts"]); hash(context.key); hash(context.adapterHash); text(context.jobId, 1024);
  const r = raw as any; fields(r, ["schema", "specHash", "identity", "execution", "observations"]);
  canonical(r); canonical(context);
  invariant(r.schema === 2 && r.specHash === digest(s) && digest(r.identity) === digest(s.identity), "experiment provenance mismatch");
  fields(r.execution, ["mode", "backend", "configurationHash", "key", "jobId"]);
  const { key, jobId, ...manifest } = r.execution;
  invariant(key === context.key && jobId === context.jobId && digest(manifest) === digest(s.execution), "experiment execution binding mismatch");
  invariant(Array.isArray(r.observations) && r.observations.length <= 10000, "invalid experiment observations");
  const expected = new Set(s.units.flatMap(u => u.replicates.map(rep => `${u.id}/${rep}`)));
  invariant(r.observations.length === expected.size, "incomplete experiment replications");
  for (const row of r.observations) {
    fields(row, ["unit", "replicate", "data"]);
    invariant(typeof row.unit === "string" && typeof row.replicate === "string" && expected.delete(`${row.unit}/${row.replicate}`), "duplicate or undeclared experiment observation");
  }
  invariant(context.artifacts && typeof context.artifacts === "object" && !Array.isArray(context.artifacts), "missing trusted artifact manifest");
  for (const a of s.artifacts) {
    const meta = (context.artifacts as any)[a.id];
    invariant(Object.hasOwn(context.artifacts, a.id) && meta && Number.isSafeInteger(meta.bytes) &&
      meta.bytes >= a.minimumBytes && meta.bytes <= a.maximumBytes && meta.truncated !== true, "missing, truncated or out-of-bounds evidence artifact");
    hash(meta.sha256);
  }
}

export function assessResearch(s: ExperimentSpec, raw: unknown, context: ExperimentContext,
  reports: { id: string; implementationHash: string; report: unknown }[]): ResearchAssessment {
  validateExperimentResult(s, raw, context);
  invariant(reports.length === s.validation.length && new Set(reports.map(r => r.id)).size === reports.length, "incomplete independent validation");
  const outcomes = new Set<ResearchOutcome>(), validation: NonNullable<ResearchAssessment["validation"]> = [];
  for (const result of reports) {
    hash(result.implementationHash);
    const required = s.validation.find(v => v.id === result.id); invariant(required, "undeclared experiment validator");
    const report = result.report as ValidatorReport;
    fields(report, ["schema", "validator", "implementationHash", "specHash", "resultHash", "contextHash", "checks", "outcome"], ["measurements"]);
    invariant(Buffer.byteLength(canonical(report)) <= 65536, "validator report too large");
    invariant(report.schema === 1 && report.validator === result.id && report.implementationHash === result.implementationHash &&
      report.specHash === digest(s) && report.resultHash === digest(raw) && report.contextHash === digest(context), "independent validator binding mismatch");
    invariant(Array.isArray(report.checks) && report.checks.length === required.checks.length && new Set(report.checks.map(c => c.id)).size === report.checks.length, "incomplete validator checks");
    for (const check of report.checks) {
      fields(check, ["id", "verdict"], ["detail"]);
      invariant(required.checks.includes(check.id) && check.verdict === "PASS", "scientific check failed or unknown");
      if (check.detail !== undefined) text(check.detail, 2048);
    }
    invariant(["SUPPORTED", "REFUTED", "INCONCLUSIVE"].includes(report.outcome), "invalid scientific outcome"); outcomes.add(report.outcome);
    validation.push({ id: result.id, implementationHash: result.implementationHash, reportHash: digest(report) });
  }
  const conflicted = outcomes.has("SUPPORTED") && outcomes.has("REFUTED");
  const outcome: ResearchOutcome = conflicted ? "INCONCLUSIVE" : outcomes.has("REFUTED") ? "REFUTED" :
    outcomes.size === 1 && outcomes.has("SUPPORTED") ? "SUPPORTED" : "INCONCLUSIVE";
  return { schema: 1, specHash: digest(s), resultHash: digest(raw), outcome, estimates: [], assumptions: s.assumptions,
    contextHash: digest(context), conflicted, validation: validation.sort((a, b) => a.id.localeCompare(b.id)) };
}

/** A plan receipt permits submission only; it is never evidence of an outcome. */
export function validatePlanReport(s: ExperimentSpec, context: ExperimentPlanContext, id: string,
  implementationHash: string, raw: unknown): void {
  validateResearchSpec(s); fields(context, ["key", "adapterHash", "inputHash"]); Object.values(context).forEach(hash);
  invariant(context.inputHash === digest(s.input), "plan input differs from frozen protocol"); hash(implementationHash);
  const required = s.planValidation?.find(v => v.id === id); invariant(required, "undeclared plan validator");
  const r = raw as PlanValidatorReport;
  fields(r, ["schema", "phase", "validator", "implementationHash", "specHash", "contextHash", "checks"]);
  invariant(Buffer.byteLength(canonical(r)) <= 65536, "plan report too large");
  invariant(r.schema === 1 && r.phase === "plan" && r.validator === id && r.implementationHash === implementationHash &&
    r.specHash === digest(s) && r.contextHash === digest(context), "plan validator binding mismatch");
  invariant(Array.isArray(r.checks) && r.checks.length === required.checks.length &&
    new Set(r.checks.map(c => c.id)).size === r.checks.length, "incomplete plan checks");
  for (const check of r.checks) {
    fields(check, ["id", "verdict"], ["detail"]);
    invariant(required.checks.includes(check.id) && check.verdict === "PASS", "plan check failed or unknown");
    if (check.detail !== undefined) text(check.detail, 2048);
  }
}
