# Executable research contracts

Long research projects need refutable hypotheses, reproducible experiments and
independent checks. More agents alone do not supply those properties. Foundry's
job path now supports immutable scientific protocols without giving workers the
authority to accept their own results.

## Configure and execute

Add `research: { spec: ResearchSpec }` to an operator-owned job template, permit
that template through the worker profile's `jobs` and `run_job` capabilities, and
set `research: ["template-name"]` on every task that requires its result. Dynamic
children may request authorized template names using the same field. The parent
retains its original required experiments and acceptance conditions.

`ResearchSpec` is the discriminated union in
`src/harness/foundry/research.ts`. All variants require:

| Field | Meaning |
| --- | --- |
| `question`, `hypothesis`, `refutation`, `protocol` | Predeclared scientific question, testable hypothesis, contrary observation and method |
| `assumptions` | Explicit conditions under which the result can be interpreted |
| `identity.code`, `.data`, `.environment` | SHA-256 identities for operator-declared code, input data and environment manifests |
| `input` | Exact frozen JSON passed to `run_job` |
| `acceptance` | `valid-result` accepts a scientifically valid negative/inconclusive result; `supported-hypothesis` also requires support |

Use the existing pinned `research-job-agent.py` endpoint with `resultMaxBytes`
enabled. Its child receives `FUTURE_JOB_INPUT_PATH` and writes one JSON result to
`FUTURE_JOB_RESULT_PATH`. Set `adapter.files` to include the experiment program,
specification, dataset/environment manifests and interpreter-loaded dependencies.
The endpoint's command configuration must also be pinned. These declarations
are an operator trust boundary, not a hermetic sandbox or physical attestation.

Each result starts with `{schema: 1, specHash: digest(spec), identity: spec.identity}`.
Use Foundry's canonical JSON `digest`, not a hash of pretty-printed JSON. The host
independently recomputes the assessment; a worker cannot supply an outcome or
confidence interval. One scientific template/input is submitted at most once per
task/run, including different tool-call IDs and retries. Reuse the durable receipt.
New experiments require new operator-approved protocols/tasks and consume the
existing run/objective job budgets. Remote uncertainty still requires reconciliation.

## Quantum counts

Run the dependency-free CPU example:

```sh
node --experimental-strip-types scripts/quantum-experiment.mjs --demo
```

It evolves a statevector through H and CX gates, samples 4,096 shots for each of
ZZ and XX, and compares a Bell preparation with a separable negative control.
The host supports the Bell witness and refutes the control under the declared
protocol. This is a simulator experiment; no QPU execution is claimed.

`bellExperiment()` constructs a complete specification. Save it as JSON, then
configure the job child as:

```text
node --experimental-strip-types /absolute/scripts/quantum-experiment.mjs --spec /absolute/spec.json
```

Quantum specifications bind backend ID, `simulator`/`hardware`, calibration hash
(required for hardware, null for simulation), bit order `q0-right`, shots, sampling
seed (null for hardware), alpha and exact circuit hashes. Results also carry
backend/bit-order/seed and `circuits: [{id, circuitHash, counts: {"00": 2048, "11": 2048}}]`.
The rightmost character is qubit 0, consistent with
[Qiskit's count bit order](https://docs.quantum.ibm.com/api/qiskit/qiskit.primitives.BitArray).
Provider adapters must normalize classical registers and measurement mappings
to this declared ordering and bind the submitted/transpiled circuit and calibration
manifest. For hardware, implement pinned provider `ensure`/`inspect` adapters
with remote deduplication; never infer a physical run from simulator output.

The host checks every circuit and exact shot total, calculates parity expectations,
and uses conservative two-sided Hoeffding bounds with a union bound across all
declared circuits. Any upper bound below its declared threshold refutes the
joint hypothesis; all lower bounds must exceed their thresholds to support it.
Partial counts, changed circuits/backend, postselection and mixed calibrations
are rejected. Independence/stationarity assumptions must be justified by the
protocol; these bounds do not correct hardware bias, drift or correlated shots.

## Paired experiments and proof obligations

`paired-metric` binds metric bounds/direction, the complete replication seed set,
alpha and a minimum effect. Results contain
`samples: [{seed, baseline, candidate}]` for every predeclared seed. The host
computes a paired mean improvement and a bounded-difference Hoeffding interval.
No best-seed selection or worker-reported score is accepted. The interval concerns
the declared independent replications, not automatic generalization to new tasks.
Dataset splits, leakage controls and training details belong in the pinned
protocol/code/data manifest; the generic validator cannot establish them itself.

`formal-proof` binds a statement hash and allowed axioms. Configure a **separate**
operator-pinned `research.proofChecker` command. The host invokes it with
`{schema: 1, spec, result}` after the experiment; the result contains candidate
`source`. The checker must elaborate the exact expected theorem in the pinned
proof-assistant environment, reject extra/untrusted declarations, and audit its
transitive axioms. It returns exactly:

```text
{schema:1, specHash, candidateHash:digest(source), environmentHash,
 statementHash, verified:true, axioms:[...]}
```

The host verifies these bindings, the allowlist, and rejects `sorryAx` even if
allowlisted. Compiling Lean source alone is insufficient: Lean can elaborate
proofs depending on `sorryAx`; see its
[proof validation reference](https://lean-lang.org/doc/reference/latest/ValidatingProofs/).
This PR supplies the checker boundary and adversarial protocol tests, not a Lean
installation or a verified Riemann-hypothesis solver. A trusted checker is required
for each proof environment; model-authored audit JSON is never consulted.

## Receipts and limits

The final independent verifier requires all task-declared experiments, stores
content-addressed `research_assessments` and emits `research.assessed` events.
Every assessment binds the exact specification, result and terminal job receipt;
replay must reproduce the same assessment. Invalid evidence fails acceptance.
Refuted/inconclusive assessments remain available even when strict hypothesis
acceptance fails. Ordinary code checks, scopes, task budgets and integration
checks remain mandatory. Scientific support is conditional evidence, not proof
of a broad research programme or of an open mathematical conjecture.
