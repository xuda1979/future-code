import { canonical, digest, identifier, invariant } from "./kernel.ts";
import { fields, hash, type ExperimentSpec, type ResearchOutcome, type ValidatorReport } from "./research.ts";

/** Operator-owned workload and evidence requirements, frozen with the spec.
 * Group identity, provenance, exposure isolation and verdict semantics belong
 * to the pinned project validator. No task/domain taxonomy lives in the host. */
export interface GeneralizationContract {
  schema: 1;
  validator: string;
  candidateHash: string;
  /** All inputs used to fit, select, tune or otherwise adapt the candidate. */
  exposureHash: string;
  /** Includes scorer, prompts, decoding and execution/runtime conditions. */
  scoringHash: string;
  maxDevelopmentGap: number;
  suites: { id: string; role: "development" | "heldout" | "external"; manifestHash: string;
    minimumGroups: number; minimumSources: number; minimumSuccessRate: number;
    slices: { id: string; minimumGroups: number }[] }[];
}
export interface GeneralizationEvidence {
  candidateHash: string; exposureHash: string; scoringHash: string;
  suites: { id: string; manifestHash: string; disjointFromExposure: "PASS" | "FAIL" | "UNKNOWN";
    /** One conservative binary verdict per independent family, not per variant.
     * Stable IDs must be shared across manifests for overlapping families. */
    groups: { id: string; source: string; slices: string[]; verdict: "PASS" | "FAIL" | "UNKNOWN" }[] }[];
}
interface Diagnostic { code: string; suite?: string; slice?: string }
interface Counts { groups: number; passed: number; unknown: number; rate: number | null; lower: number; upper: number }
export interface GeneralizationAssessment {
  contractHash: string; evidenceHash: string | null; outcome: ResearchOutcome;
  confidence: "WILSON_95_MARGINAL_INDEPENDENT_GROUPS";
  suites: (Counts & { id: string; sources: number; slices: (Counts & { id: string })[] })[];
  diagnostics: Diagnostic[];
  nextExperiments: string[];
}

export function validateGeneralizationContract(s: ExperimentSpec): void {
  const p = s.generalization; if (p === undefined) return;
  fields(p, ["schema", "validator", "candidateHash", "exposureHash", "scoringHash", "maxDevelopmentGap", "suites"]);
  identifier(p.validator); [p.candidateHash, p.exposureHash, p.scoringHash].forEach(hash);
  invariant(p.schema === 1 && s.validation.some(v => v.id === p.validator), "generalization requires a configured result validator");
  invariant(Number.isFinite(p.maxDevelopmentGap) && p.maxDevelopmentGap >= 0 && p.maxDevelopmentGap <= 1,
    "invalid generalization gap");
  invariant(Array.isArray(p.suites) && p.suites.length >= 2 && p.suites.length <= 8 &&
    p.suites.filter(r => r.role === "development").length === 1 && p.suites.some(r => r.role === "external") &&
    new Set(p.suites.map(r => r.id)).size === p.suites.length &&
    new Set(p.suites.map(r => r.manifestHash)).size === p.suites.length, "generalization requires distinct development and external suites");
  for (const r of p.suites) {
    fields(r, ["id", "role", "manifestHash", "minimumGroups", "minimumSources", "minimumSuccessRate", "slices"]);
    identifier(r.id); hash(r.manifestHash);
    invariant(["development", "heldout", "external"].includes(r.role) &&
      Number.isSafeInteger(r.minimumGroups) && r.minimumGroups > 0 && r.minimumGroups <= 1024 &&
      Number.isSafeInteger(r.minimumSources) && r.minimumSources > 0 && r.minimumSources <= r.minimumGroups &&
      Number.isFinite(r.minimumSuccessRate) && r.minimumSuccessRate >= 0 && r.minimumSuccessRate <= 1,
      "invalid generalization suite requirements");
    invariant(Array.isArray(r.slices) && r.slices.length > 0 && r.slices.length <= 16 &&
      new Set(r.slices.map(c => c.id)).size === r.slices.length, "invalid generalization coverage slices");
    for (const c of r.slices) {
      fields(c, ["id", "minimumGroups"]); identifier(c.id);
      invariant(Number.isSafeInteger(c.minimumGroups) && c.minimumGroups > 0 && c.minimumGroups <= 1024,
        "invalid generalization slice requirements");
    }
  }
}

/** Marginal Wilson intervals, conditional on genuinely independent groups.
 * These are diagnostics, not a simultaneous or sequential-testing guarantee. */
function counts(groups: GeneralizationEvidence["suites"][number]["groups"]): Counts {
  const n = groups.length, passed = groups.filter(g => g.verdict === "PASS").length;
  const unknown = groups.filter(g => g.verdict === "UNKNOWN").length;
  if (!n) return { groups: 0, passed: 0, unknown: 0, rate: null, lower: 0, upper: 1 };
  const z2 = 1.959963984540054 ** 2, rate = passed / n, denominator = 1 + z2 / n;
  const center = (rate + z2 / (2 * n)) / denominator;
  const radius = Math.sqrt(z2 * (rate * (1 - rate) / n + z2 / (4 * n * n))) / denominator;
  return { groups: n, passed, unknown, rate, lower: passed === 0 ? 0 : Math.max(0, center - radius),
    upper: passed === n ? 1 : Math.min(1, center + radius) };
}

/** Only call after authenticating the designated validator's full report.
 * Insufficient/negative science is a durable assessment. Malformed, stale or
 * contaminated evidence is rejected rather than recast as a measured failure. */
export function assessGeneralization(s: ExperimentSpec, reports: ValidatorReport[]): GeneralizationAssessment | undefined {
  validateGeneralizationContract(s); const p = s.generalization;
  for (const r of reports) invariant(r.generalization === undefined || p?.validator === r.validator,
    "undeclared generalization evidence");
  if (!p) return undefined;
  const evidence = reports.find(r => r.validator === p.validator)?.generalization;
  const diagnostics: Diagnostic[] = [], suites: GeneralizationAssessment["suites"] = [];
  let refuted = false;
  const add = (code: string, suite?: string, slice?: string) => diagnostics.push({ code, ...(suite ? { suite } : {}), ...(slice ? { slice } : {}) });
  if (evidence === undefined) add("MISSING_EVALUATION");
  else {
    fields(evidence, ["candidateHash", "exposureHash", "scoringHash", "suites"]);
    invariant(evidence.candidateHash === p.candidateHash && evidence.exposureHash === p.exposureHash &&
      evidence.scoringHash === p.scoringHash, "generalization candidate/exposure/scoring identity mismatch");
    invariant(Array.isArray(evidence.suites) && evidence.suites.length <= p.suites.length &&
      new Set(evidence.suites.map(r => r.id)).size === evidence.suites.length, "invalid generalization suites");
    const seen = new Set<string>(); let total = 0;
    for (const r of evidence.suites) {
      fields(r, ["id", "manifestHash", "disjointFromExposure", "groups"]);
      const required = p.suites.find(c => c.id === r.id);
      invariant(required && r.manifestHash === required.manifestHash, "generalization suite manifest mismatch");
      invariant(["PASS", "FAIL", "UNKNOWN"].includes(r.disjointFromExposure), "invalid exposure isolation evidence");
      invariant(required.role === "development" || r.disjointFromExposure !== "FAIL", "generalization exposure contamination");
      invariant(Array.isArray(r.groups) && r.groups.length <= 1024 && (total += r.groups.length) <= 2048,
        "generalization group ceiling exceeded");
      for (const g of r.groups) {
        fields(g, ["id", "source", "slices", "verdict"]); hash(g.id); identifier(g.source);
        invariant(!seen.has(g.id), "duplicate or cross-suite generalization group"); seen.add(g.id);
        invariant(["PASS", "FAIL", "UNKNOWN"].includes(g.verdict) && Array.isArray(g.slices) &&
          g.slices.length <= required.slices.length && new Set(g.slices).size === g.slices.length &&
          g.slices.every(id => required.slices.some(c => c.id === id)), "invalid generalization group verdict/coverage");
      }
    }
    const devId = p.suites.find(r => r.role === "development")!.id;
    const devSources = new Set(evidence.suites.find(r => r.id === devId)?.groups.map(g => g.source) ?? []);
    for (const required of p.suites) {
      const r = evidence.suites.find(r => r.id === required.id);
      if (!r) { add("MISSING_SUITE", required.id); continue; }
      if (required.role !== "development" && r.disjointFromExposure !== "PASS") add("EXPOSURE_ISOLATION_UNKNOWN", r.id);
      const summary = { id: r.id, ...counts(r.groups), sources: new Set(r.groups.map(g => g.source)).size,
        slices: required.slices.map(c => ({ id: c.id, ...counts(r.groups.filter(g => g.slices.includes(c.id))) })) };
      suites.push(summary);
      if (summary.groups < required.minimumGroups) add("INSUFFICIENT_GROUPS", r.id);
      if (summary.sources < required.minimumSources) add("INSUFFICIENT_SOURCES", r.id);
      if (required.role === "external" && r.groups.some(g => devSources.has(g.source))) add("EXTERNAL_SOURCE_REUSE", r.id);
      const performance = (c: Counts, slice?: string) => {
        // Unknown observations never certify or refute a performance claim.
        if (c.unknown) { add("UNMEASURED_GROUPS", r.id, slice); return; }
        if (c.upper < required.minimumSuccessRate) { refuted = true; add("PERFORMANCE_BELOW_TARGET", r.id, slice); }
        else if (c.lower < required.minimumSuccessRate) add("PERFORMANCE_UNCERTAIN", r.id, slice);
      };
      performance(summary);
      for (const c of required.slices) {
        const measured = summary.slices.find(x => x.id === c.id)!;
        if (measured.groups < c.minimumGroups) add("INSUFFICIENT_SLICE_GROUPS", r.id, c.id);
        performance(measured, c.id);
      }
    }
    const development = suites.find(r => r.id === devId);
    if (development && !development.unknown) for (const r of suites.filter(r => r.id !== devId && !r.unknown)) {
      if (development.lower - r.upper > p.maxDevelopmentGap) { refuted = true; add("DISTRIBUTION_GAP", r.id); }
      else if (development.rate !== null && r.rate !== null && development.rate - r.rate > p.maxDevelopmentGap)
        add("POSSIBLE_DISTRIBUTION_GAP", r.id);
    }
  }
  return { contractHash: digest(p), evidenceHash: evidence === undefined ? null : digest(evidence),
    outcome: refuted ? "REFUTED" : diagnostics.length ? "INCONCLUSIVE" : "SUPPORTED",
    confidence: "WILSON_95_MARGINAL_INDEPENDENT_GROUPS", suites, diagnostics,
    nextExperiments: diagnostics.length ? [
      "Audit candidate, execution, scorer, exposure and family/source identities before interpreting a gap.",
      "Collect fresh independent groups and missing workload slices; keep exposed evaluation families out of final evaluation.",
      "Use budget-matched experiments to separate workload coverage from optimization effort; compare on a fresh frozen evaluation. Do not infer the cause or spend more compute from the gap alone.",
    ] : [] };
}

/** Keep actionable feedback intact inside the verifier's 4096-character cap.
 * The full assessment remains in its owned content-addressed receipt. */
export function generalizationFeedback(a: GeneralizationAssessment) {
  const severity = (d: Diagnostic) => ["PERFORMANCE_BELOW_TARGET", "DISTRIBUTION_GAP"].includes(d.code) ? 0 : 1;
  const ordered = a.diagnostics.map((d, i) => ({ d, i })).sort((a, b) => severity(a.d) - severity(b.d) || a.i - b.i);
  const summary = { outcome: a.outcome, diagnostics: ordered.slice(0, 12).map(x => x.d),
    diagnosticsOmitted: Math.max(0, ordered.length - 12), nextExperiments: a.nextExperiments };
  while (Buffer.byteLength(canonical(summary)) > 3072 && summary.diagnostics.length) {
    summary.diagnostics.pop(); summary.diagnosticsOmitted++;
  }
  return summary;
}
