# Reusable preparation for parameterized validation

Future-Code remains a project-neutral R&D platform. Optional project adapters
choose domain tools, methods, testbenches, evidence readers and acceptance rules.
The runtime supplies general execution and evidence mechanisms. A useful shared
mechanism is to prepare a deterministic artifact once, then validate many
parameter combinations in isolated directories using that exact artifact.

`src/harness/foundry/prepared_commands.py` is an optional standard-library Python
module for local operator-owned checks. It exposes bounded `run_steps`,
`prepare_stage`, `file_identity` and `prepared_unchanged` functions. It contains
no chip/domain registry, result parser, random-seed policy or scientific verdict
algorithm. Existing TypeScript execution, scheduler and acceptance paths retain
their interfaces and behavior. It is not a new scheduler or an automatic
cross-candidate cache.

| Mechanism | Example uses |
| --- | --- |
| Prepare an identified artifact once per check invocation | Compile an executable, preprocess a frozen table, build a numerical model |
| Reuse that exact artifact across independent parameters | RTL stimulus seeds, software inputs, numerical partitions, evaluation scenarios |
| Preserve private consumer outputs | Simulation waveforms, software logs, numerical residuals |
| Verify the published manifest after consumers finish | Reject changed or missing binaries/data even if every consumer reports success |

The caller freezes commands, inputs, transitive dependencies, environment
capabilities, output limits and a shared deadline. Preparation executes in a fresh
private directory. Only predeclared regular-file outputs within that directory
are cold-copied into a published directory; byte limits and pre/post SHA-256
checks guard capture. Published files retain executable bits and are read-only.
The caller must check `prepared_unchanged` after all consumers and before
acceptance. A failed or incomplete preparation blocks its consumers. This is
bounded execution of trusted, non-daemonizing commands, not an OS sandbox.

Every independent verification invocation builds a **new** preparation and
manifest from its current candidate inputs. Exploratory receipts never replace
independent final checks. There is no reuse across source revisions, tasks or
independent acceptance calls. A project may add a more advanced build cache only
with complete input/toolchain dependency identities and separate validation.

The chip adapter opts into this mechanism through a case's optional `prepare`
object. It compiles once and lets each seed read `{shared}/sim.vvp`; `{work}`
continues to name that seed's private directory. Existing plans without `prepare`
execute exactly their original per-seed step lists. Field-specific formats,
coverage bins and proof interpretation remain under `adapters/chip-verification`.
The generic module also has a numerical/data-partition regression using arbitrary
parameter names, demonstrating that its API does not depend on chip concepts.

The [real RTL comparison](../../examples/chip-verification/benchmark.py) executes
both paths with the same inputs, tool identities, stimulus seeds, checks and
coverage bins. It verifies complete equality of those observations and counts
actual compile invocations. Small CPU wall times are reported separately and
do not establish live-LLM or industrial verification speedups.
