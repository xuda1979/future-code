/** CPU statevector example, not a QPU provider. No network or third-party packages.
 * Job mode: node --experimental-strip-types scripts/quantum-experiment.mjs --spec /absolute/spec.json
 * Standalone: node --experimental-strip-types scripts/quantum-experiment.mjs --demo */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { digest, invariant, sha256 } from "../src/harness/foundry/kernel.ts";
import { assessResearch, validateResearchSpec } from "../src/harness/foundry/research.ts";

export function bellExperiment(control = false) {
  const preparation = control ? [] : [["h", 0], ["cx", 0, 1]];
  const circuits = [
    { id: "ZZ", qubits: 2, gates: preparation },
    { id: "XX", qubits: 2, gates: [...preparation, ["h", 0], ["h", 1]] },
  ];
  const spec = {
    schema: 1, kind: "quantum-counts", question: "Does the preparation produce correlated ZZ and XX measurements?",
    hypothesis: "Both parity expectations exceed 0.7.",
    assumptions: ["Independent simulator samples", "Correct pinned statevector implementation"],
    refutation: "Either parity upper confidence bound is below 0.7.",
    protocol: "Bell-state ZZ/XX parity witness; fixed circuits and shots; family-wise Hoeffding intervals.",
    identity: { code: sha256(readFileSync(fileURLToPath(import.meta.url))), data: digest(circuits),
      environment: digest({ runtime: process.version, backend: "future-cpu-statevector-v1" }) },
    input: { circuits }, acceptance: "valid-result",
    backend: { id: "future-cpu-statevector-v1", mode: "simulator", calibrationHash: null },
    bitOrder: "q0-right", shots: 4096, seed: 1979, alpha: 0.01,
    circuits: circuits.map(c => ({ id: c.id, circuitHash: digest({ qubits: c.qubits, gates: c.gates }),
      qubits: c.qubits, parityQubits: [0, 1], minimum: 0.7 })),
  };
  return spec;
}

/** Small real-valued statevector interpreter; H, X and CX are sufficient for this demo.
 * A provider adapter may use the same result schema with provider-normalized bit order. */
export function simulateQuantum(spec) {
  validateResearchSpec(spec); invariant(spec.kind === "quantum-counts" && spec.backend.mode === "simulator" &&
    spec.backend.id === "future-cpu-statevector-v1", "CPU simulator backend required");
  invariant(spec.identity.code === sha256(readFileSync(fileURLToPath(import.meta.url))) &&
    spec.identity.environment === digest({ runtime: process.version, backend: spec.backend.id }) &&
    spec.identity.data === digest(spec.input.circuits), "simulator implementation/environment/input drift");
  let state = spec.seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 2 ** 32; };
  const circuits = spec.input.circuits.map(c => {
    const declared = spec.circuits.find(d => d.id === c.id);
    invariant(declared && declared.circuitHash === digest({ qubits: c.qubits, gates: c.gates }) &&
      declared.qubits === c.qubits && c.qubits <= 12, "circuit differs from preregistration or exceeds demo limit");
    const amplitudes = new Float64Array(2 ** c.qubits); amplitudes[0] = 1;
    for (const gate of c.gates) {
      const [op, q, target] = gate;
      invariant(Number.isInteger(q) && q >= 0 && q < c.qubits, "invalid gate qubit");
      if (op === "h" || op === "x") {
        invariant(gate.length === 2, "invalid single-qubit gate");
        for (let i = 0; i < amplitudes.length; i++) if (!(i & (1 << q))) {
          const j = i | (1 << q), a = amplitudes[i], b = amplitudes[j];
          amplitudes[i] = op === "h" ? (a + b) / Math.SQRT2 : b;
          amplitudes[j] = op === "h" ? (a - b) / Math.SQRT2 : a;
        }
      } else {
        invariant(op === "cx" && gate.length === 3 && Number.isInteger(target) && target >= 0 &&
          target < c.qubits && target !== q, "unsupported or invalid gate");
        for (let i = 0; i < amplitudes.length; i++) if ((i & (1 << q)) && !(i & (1 << target))) {
          const j = i | (1 << target); [amplitudes[i], amplitudes[j]] = [amplitudes[j], amplitudes[i]];
        }
      }
    }
    let total = 0;
    const cdf = Array.from(amplitudes, a => total += a * a);
    invariant(Math.abs(total - 1) < 1e-10, "statevector normalization failed");
    const counts = {};
    for (let shot = 0; shot < spec.shots; shot++) {
      const r = random(); let index = cdf.findIndex(p => r < p);
      if (index < 0) index = cdf.length - 1;
      const bits = index.toString(2).padStart(c.qubits, "0"); counts[bits] = (counts[bits] ?? 0) + 1;
    }
    return { id: c.id, circuitHash: declared.circuitHash, counts };
  });
  return { schema: 1, specHash: digest(spec), identity: spec.identity, backend: spec.backend,
    bitOrder: spec.bitOrder, seed: spec.seed, circuits };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--demo")) {
    for (const control of [false, true]) {
      const spec = bellExperiment(control), result = simulateQuantum(spec);
      console.log(JSON.stringify({ control, specHash: digest(spec), assessment: assessResearch(spec, result) }));
    }
  } else {
    const index = process.argv.indexOf("--spec"); invariant(index >= 0 && process.argv[index + 1], "--spec required");
    const spec = JSON.parse(readFileSync(process.argv[index + 1], "utf8"));
    invariant(digest(JSON.parse(readFileSync(process.env.FUTURE_JOB_INPUT_PATH, "utf8"))) === digest(spec.input), "job input drift");
    writeFileSync(process.env.FUTURE_JOB_RESULT_PATH, JSON.stringify(simulateQuantum(spec)));
  }
}
