import { canonical, digest, identifier, invariant } from "./kernel.ts";
import type { Json } from "./types.ts";

export type ResearchOutcome = "SUPPORTED" | "REFUTED" | "INCONCLUSIVE";
interface ResearchBase {
  schema: 1;
  question: string;
  hypothesis: string;
  assumptions: string[];
  /** A predeclared observation that would count against the hypothesis. */
  refutation: string;
  protocol: string;
  identity: { code: string; data: string; environment: string };
  /** Exact operator-approved input. Workers cannot change seeds, shots or methods mid-trial. */
  input: Json;
  acceptance: "valid-result" | "supported-hypothesis";
}
export interface PairedExperiment extends ResearchBase {
  kind: "paired-metric";
  metric: { name: string; minimum: number; maximum: number; direction: "higher" | "lower" };
  seeds: number[];
  alpha: number;
  minimumEffect: number;
}
export interface QuantumExperiment extends ResearchBase {
  kind: "quantum-counts";
  backend: { id: string; mode: "simulator" | "hardware"; calibrationHash: string | null };
  bitOrder: "q0-right";
  shots: number;
  seed: number | null;
  alpha: number;
  circuits: { id: string; circuitHash: string; qubits: number; parityQubits: number[]; minimum: number }[];
}
export interface ProofObligation extends ResearchBase {
  kind: "formal-proof";
  statementHash: string;
  allowedAxioms: string[];
}
export type ResearchSpec = PairedExperiment | QuantumExperiment | ProofObligation;
export interface ResearchAssessment {
  schema: 1;
  specHash: string;
  resultHash: string;
  outcome: ResearchOutcome;
  estimates: { name: string; mean: number; lower: number; upper: number; samples: number }[];
  /** Scientific support is always conditional on this exact protocol and its assumptions. */
  assumptions: string[];
}

export function fields(value: any, required: string[], optional: string[] = []): void {
  invariant(value && typeof value === "object" && !Array.isArray(value), "expected research object");
  invariant(required.every(k => Object.hasOwn(value, k)) &&
    Object.keys(value).every(k => [...required, ...optional].includes(k)), "invalid research fields");
}
const text = (v: unknown) => invariant(typeof v === "string" && v.trim().length > 0 && v.length <= 8192, "invalid research text");
export const hash = (v: unknown) => invariant(typeof v === "string" && /^[a-f0-9]{64}$/.test(v), "invalid research hash");
const finite = (v: unknown) => invariant(typeof v === "number" && Number.isFinite(v), "non-finite research number");
const integer = (v: unknown, max: number) => invariant(Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max, "invalid research integer");
function strings(v: unknown, max: number): asserts v is string[] {
  invariant(Array.isArray(v) && v.length <= max && new Set(v).size === v.length, "invalid research list");
  v.forEach(text);
}
const base = ["schema", "kind", "question", "hypothesis", "assumptions", "refutation", "protocol", "identity", "input", "acceptance"];
export function validateResearchSpec(s: ResearchSpec): void {
  const extra = s?.kind === "paired-metric" ? ["metric", "seeds", "alpha", "minimumEffect"] :
    s?.kind === "quantum-counts" ? ["backend", "bitOrder", "shots", "seed", "alpha", "circuits"] : ["statementHash", "allowedAxioms"];
  fields(s, [...base, ...extra]);
  invariant(s.schema === 1 && ["paired-metric", "quantum-counts", "formal-proof"].includes(s.kind), "unknown research kind");
  [s.question, s.hypothesis, s.refutation, s.protocol].forEach(text); strings(s.assumptions, 64);
  fields(s.identity, ["code", "data", "environment"]); Object.values(s.identity).forEach(hash);
  invariant(["valid-result", "supported-hypothesis"].includes(s.acceptance), "invalid research acceptance");
  invariant(Buffer.byteLength(canonical(s)) <= 65536, "research specification too large");
  if (s.kind === "formal-proof") {
    hash(s.statementHash); strings(s.allowedAxioms, 64); return;
  }
  finite(s.alpha); invariant(s.alpha > 0 && s.alpha < 1, "invalid significance level");
  if (s.kind === "paired-metric") {
    fields(s.metric, ["name", "minimum", "maximum", "direction"]); text(s.metric.name);
    finite(s.metric.minimum); finite(s.metric.maximum); finite(s.minimumEffect);
    invariant(s.metric.minimum < s.metric.maximum && Number.isFinite(2 * (s.metric.maximum - s.metric.minimum)) &&
      ["higher", "lower"].includes(s.metric.direction) && s.minimumEffect >= 0 &&
      s.minimumEffect <= s.metric.maximum - s.metric.minimum, "invalid metric bounds");
    invariant(Array.isArray(s.seeds) && s.seeds.length >= 2 && s.seeds.length <= 10000 &&
      new Set(s.seeds).size === s.seeds.length, "invalid replication seeds");
    s.seeds.forEach(x => integer(x, 2 ** 32 - 1)); return;
  }
  fields(s.backend, ["id", "mode", "calibrationHash"]); text(s.backend.id);
  invariant(["hardware", "simulator"].includes(s.backend.mode), "unknown quantum backend mode");
  if (s.backend.mode === "hardware") hash(s.backend.calibrationHash);
  else invariant(s.backend.calibrationHash === null, "simulator cannot claim hardware calibration");
  invariant(s.bitOrder === "q0-right", "unsupported bit order");
  integer(s.shots, 100000000); invariant(s.shots > 0, "shots must be positive");
  if (s.backend.mode === "hardware") invariant(s.seed === null, "hardware sampling is not seeded");
  else integer(s.seed, 2 ** 32 - 1);
  invariant(Array.isArray(s.circuits) && s.circuits.length > 0 && s.circuits.length <= 64 &&
    new Set(s.circuits.map(c => c.id)).size === s.circuits.length, "invalid circuits");
  for (const c of s.circuits) {
    fields(c, ["id", "circuitHash", "qubits", "parityQubits", "minimum"]); identifier(c.id); hash(c.circuitHash);
    integer(c.qubits, 24); invariant(c.qubits > 0, "invalid qubit count");
    invariant(Array.isArray(c.parityQubits) && c.parityQubits.length > 0 && c.parityQubits.length <= c.qubits &&
      new Set(c.parityQubits).size === c.parityQubits.length, "invalid parity observable");
    c.parityQubits.forEach(q => integer(q, c.qubits - 1));
    finite(c.minimum); invariant(c.minimum >= -1 && c.minimum <= 1, "invalid parity threshold");
  }
}

/** Host recomputes statistics from pinned-adapter observations, never model-authored scores.
 * Hoeffding bounds assume independent predeclared replications / shots. Quantum
 * intervals use a union bound across all declared circuits (family-wise alpha). */
export function assessResearch(s: ResearchSpec, raw: unknown, audit?: unknown): ResearchAssessment {
  validateResearchSpec(s);
  const r = raw as any;
  fields(r, ["schema", "specHash", "identity", ...(s.kind === "paired-metric" ? ["samples"] :
    s.kind === "quantum-counts" ? ["backend", "bitOrder", "seed", "circuits"] : ["source"])]);
  invariant(r.schema === 1 && r.specHash === digest(s) && digest(r.identity) === digest(s.identity), "research provenance mismatch");
  const estimates: ResearchAssessment["estimates"] = [];
  let outcome: ResearchOutcome;
  if (s.kind === "paired-metric") {
    invariant(Array.isArray(r.samples) && r.samples.length === s.seeds.length, "incomplete replications");
    const bySeed = new Map<number, number>();
    for (const row of r.samples) {
      fields(row, ["seed", "baseline", "candidate"]);
      invariant(s.seeds.includes(row.seed) && !bySeed.has(row.seed), "unexpected or duplicate replication seed");
      for (const x of [row.baseline, row.candidate]) {
        finite(x); invariant(x >= s.metric.minimum && x <= s.metric.maximum, "metric outside preregistered range");
      }
      bySeed.set(row.seed, (row.candidate - row.baseline) * (s.metric.direction === "higher" ? 1 : -1));
    }
    const range = s.metric.maximum - s.metric.minimum;
    const mean = s.seeds.reduce((sum, seed) => sum + bySeed.get(seed)! / s.seeds.length, 0);
    const radius = 2 * range * Math.sqrt(Math.log(2 / s.alpha) / (2 * s.seeds.length));
    const lower = Math.max(-range, mean - radius), upper = Math.min(range, mean + radius);
    estimates.push({ name: s.metric.name, mean, lower, upper, samples: s.seeds.length });
    outcome = lower > s.minimumEffect ? "SUPPORTED" : upper < s.minimumEffect ? "REFUTED" : "INCONCLUSIVE";
  } else if (s.kind === "quantum-counts") {
    invariant(digest(r.backend) === digest(s.backend) && r.bitOrder === s.bitOrder && r.seed === s.seed,
      "quantum backend, calibration, seed or bit order mismatch");
    invariant(Array.isArray(r.circuits) && r.circuits.length === s.circuits.length, "incomplete quantum circuits");
    const seen = new Set<string>(); let supported = true, refuted = false;
    for (const row of r.circuits) {
      fields(row, ["id", "circuitHash", "counts"]);
      const c = s.circuits.find(c => c.id === row.id);
      invariant(c && !seen.has(row.id) && row.circuitHash === c.circuitHash, "quantum circuit identity mismatch"); seen.add(row.id);
      invariant(row.counts && typeof row.counts === "object" && !Array.isArray(row.counts) &&
        Object.keys(row.counts).length <= Math.min(s.shots, 2 ** c.qubits), "invalid quantum counts");
      let shots = 0, sum = 0;
      for (const [bits, n] of Object.entries(row.counts)) {
        invariant(new RegExp(`^[01]{${c.qubits}}$`).test(bits), "invalid measurement bitstring"); integer(n, s.shots);
        shots += n as number;
        const parity = c.parityQubits.reduce((p, q) => p ^ Number(bits[bits.length - 1 - q]), 0);
        sum += (parity ? -1 : 1) * (n as number);
      }
      invariant(shots === s.shots, "shot count differs from preregistration");
      const mean = sum / shots, radius = 2 * Math.sqrt(Math.log(2 * s.circuits.length / s.alpha) / (2 * shots));
      const lower = Math.max(-1, mean - radius), upper = Math.min(1, mean + radius);
      estimates.push({ name: c.id, mean, lower, upper, samples: shots });
      supported &&= lower > c.minimum; refuted ||= upper < c.minimum;
    }
    outcome = refuted ? "REFUTED" : supported ? "SUPPORTED" : "INCONCLUSIVE";
  } else {
    text(r.source);
    const a = audit as any;
    fields(a, ["schema", "specHash", "candidateHash", "environmentHash", "statementHash", "verified", "axioms"]);
    invariant(a.schema === 1 && a.specHash === digest(s) && a.candidateHash === digest(r.source) &&
      a.environmentHash === s.identity.environment && a.statementHash === s.statementHash && a.verified === true,
      "independent proof audit binding failed");
    strings(a.axioms, 64);
    invariant(a.axioms.every((x: string) => s.allowedAxioms.includes(x)) && !a.axioms.includes("sorryAx"), "forbidden proof axiom");
    outcome = "SUPPORTED";
  }
  return { schema: 1, specHash: digest(s), resultHash: digest(raw), outcome, estimates, assumptions: s.assumptions };
}
