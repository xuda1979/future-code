# Domain-specific quality contracts

## Software

Use a failing regression case before fixing a known defect. Protect acceptance inputs
and policies from worker writes. Configure project-appropriate syntax/lint, unit,
integration and security gates with explicit argv and bounded timeouts. The worker cannot
invent new shell commands or weaken protected tests. Staged edits are integrated only
after configured final gates rerun on the latest combined project tree.

A check that executes zero tests is not useful evidence. The example `unit` gate explicitly
fails when unittest discovery finds zero tests. Real projects should assert nonempty
suites, meaningful test selection and measurable behavioral acceptance. Passing `echo`,
an empty test command or an arbitrary model's statement cannot establish correctness.
Protect test configuration too, and run tests under an external sandbox: imported model-
generated code has the gate process's OS capabilities.

## ML / AI development operations

Use the `ml` profile and explicitly configure preflight, tiny lifecycle, canary, frozen
holdout evaluation and guardrail gates appropriate to the project. Prefer an inexpensive
fixture before any long job. A task must not launch real training unless that command,
resource budget, dataset path and checkpoint policy were approved by the operator.

The final workspace must contain `experiment.json`. Its validator requires exactly the
implemented schema: versioned experiment identity, SHA-256 identifiers for code/model/
configuration/data, seed, runtime metadata, disjoint unique train/evaluation sample IDs,
a primary metric contract with baseline/direction/minimum improvement, finite measured
values, reconciled sample count, guardrails and hashed local evidence files. See
`examples/experiment.json` and `quality.validate_experiment` for exact field names.

The validator checks internal consistency and recorded evidence hashes. It **does not
prove that an LLM-generated metric was truly measured**, that external datasets match
claimed hashes, that splits are semantically uncontaminated, or that a result is
statistically significant. Use an independently implemented executable evaluation gate
that reads the actual artifact and held-out data. Never promote solely from training loss,
weight changes, isolated anecdotes or a self-awarded model score.

Store long experiment logs/checkpoints outside disposable source snapshots in an approved
artifact location and reference their authenticated manifests. The runtime is not a job
scheduler for distributed NPU/GPU training and does not validate Ascend/CANN compatibility.
No accelerator hardware or full model training was exercised here. Remote job cancellation,
resume, nonfinite-loss alarms and dataset-lineage integration are responsibilities of the
configured training tools until a dedicated adapter is implemented and tested.

## Research

The `research` profile requires `research_evidence.json` with claims labelled `observed`,
`inference` or `unknown`, source descriptions, hash-verified local evidence files and
explicit limitations. See `examples/research_evidence.json` and the validator for exact
field names. Add reproducible analysis/reference-verification gates for the actual field.

A source string or file hash is not proof that the source is authoritative, supports the
claim or reflects an actual experiment. Research assertions, mathematical proofs and
novelty need domain review and appropriate verifiers. This release performs no automatic
web literature retrieval, proof-assistant integration, quantum simulator evaluation or
clinical/financial validation. Domain profile instructions are useful constraints, not
a claim of universal expert performance.

## Reviewer and uncertainty

Tasks can require a separate configured model endpoint for advisory review. A negative
review feeds concrete findings back for correction. A positive review still cannot replace
executable gates. The endpoint needs a distinct name for reporting but can share a provider;
there is no unsupported assertion of statistical independence or independent authorship.

Keep unknowns and failed guardrails visible. A missing metric remains UNKNOWN; incompatible
or invalid evidence fails closed. The status tables are generated from runtime records,
not by the worker. A task's free-text summary remains explicitly model-reported.
