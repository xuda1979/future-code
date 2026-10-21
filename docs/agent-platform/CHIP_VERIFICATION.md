# Chip verification through optional project adapters

Future-Code can execute RTL lint, seeded simulation regressions, cocotb/JUnit and
UVM result checks, single-task SymbiYosys checks, requirement traceability and
functional coverage gates. This implementation uses the existing pinned
`run_check` and independent integration interfaces. It adds no domain switch,
default prompt, dependency or chip-specific acceptance rule to the runtime.
Software, mathematics, ML and scientific experiment configurations keep their
existing behavior.

## Run an actual RTL example

Requires Python >=3.10, a POSIX host and Icarus Verilog (`iverilog`, `vvp`). The
adapter itself uses only the Python standard library. Verilator is optional for
lint; commercial tools and cocotb run through operator-supplied argv steps.

```sh
python3 examples/chip-verification/configure.py --output /tmp/future-chip-good
python3 adapters/chip-verification/verify.py --plan /tmp/future-chip-good/plan.json

python3 examples/chip-verification/configure.py --output /tmp/future-chip-bad --negative-control
python3 adapters/chip-verification/verify.py --plan /tmp/future-chip-bad/plan.json
```

The first command set must return PASS/exit 0. The deliberate off-by-one FIFO
must return FAIL/exit 1. It asserts full at three entries instead of four. Both
use an independent shift-queue scoreboard, synchronous reset, directed overflow
and underflow, pointer wrap, simultaneous push/pop and 500 pseudorandom cycles
for each of seeds 1, 17 and 101. No LLM is used to judge those outcomes.

Add `--verilator /absolute/path/to/verilator` to include a mandatory lint case.
`--iverilog`, `--vvp` and `--ivl-root` support locally extracted toolchains. Every
run creates fresh private case/seed directories, retaining logs, raw results,
waveforms, input/tool hashes, the exact plan and `report.json`. The compact stdout
includes failing seeds and bounded diagnostic text so an agent can repair a
failure using its existing check receipts. CLI exit codes are 0 PASS, 1 FAIL,
2 UNKNOWN; missing tools, incomplete reports, timeouts and source drift cannot
produce PASS. `--validate-only` validates a plan without claiming execution.

## Connect an external-API worker

`configure.py` also writes a normal `swarm.json` and `tasks.json`. Set the external
provider URL/model/key environment name in that generated configuration. Then:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts init --root /tmp/future-chip-store --spec /tmp/future-chip-bad/swarm.json --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts run --root /tmp/future-chip-store --tasks /tmp/future-chip-bad/tasks.json --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts integrate --root /tmp/future-chip-store --run RUN_ID --allow-exec
```

The task permits edits only to the selected RTL file. The testbench, adapter,
tool binaries and plan are pinned and protected. The named `chip` check always
uses the current candidate worktree, including during independent verification.
The generated configuration is a separate example; it does not alter an existing
project's checks. When adding it to an existing project, **append** the chip check
to the worker and integration lists while retaining all existing checks.

Build the final acceptance plan before allowing worker edits. Place it outside
worker scopes, protect testbenches, reference models, formal configurations,
report converters and coverage thresholds, and list their loaded dependencies in
the check's `files`. Pin vendor scripts, cocotb environments, compiler plugins,
include directories and library/environment manifests as appropriate. Hashing
the named executable is provenance for that file, not hermetic toolchain capture.

## Contract and report formats

See `examples/chip-verification/configure.py:make_plan` for a complete executable
plan. A case has an ID, the complete seed set, argv steps with per-step deadlines,
one evidence reader and optional required artifacts. No shell is invoked. Only
`{project}`, `{work}` and `{seed}` substitutions are performed. Executables must
be absolute paths. Global wall time, concurrency, seed count, stdout/log and
artifact limits are bounded. `envAllow` can admit explicit license/environment
variables; loader and reserved variables are rejected. Checks inherit the core's
credential restrictions.

| Evidence format | Acceptance behavior |
| --- | --- |
| `checks-json` | Exact expected boolean checks and the actual seed; nonnegative integer raw bin counts; missing or substituted checks rejected |
| `junit` | Nonempty regression and declared minimum test count; failures/errors fail, skipped tests remain UNKNOWN, inconsistent totals and duplicate tests rejected |
| `uvm` | Expected `testName` must match exactly one UVM `[RNTST]` startup record; exactly one completed summary with explicit ERROR/FATAL totals; any error/fatal event or nonzero total fails even when the wrapper exits zero |
| `sby` | Exact terminal status, identified single-task `.sby` configuration and mode; UNKNOWN/ERROR never pass; BMC depth must match the frozen configuration |
| `exit-code` | Successful invocation supplies **lint** evidence only; it cannot supply simulation or proof evidence |

The minimal `checks-json` output for seed 17 looks like:

```json
{"schema":1,"seed":17,"checks":[{"id":"scoreboard","passed":true}],"bins":{"empty":2,"full":1}}
```

Each requirement names its description, evidence strength and all required
cases. Every declared case must be traced to a requirement, and **every seed and
case must pass**. Case/seed IDs must be unique. A failed seed cannot be hidden
by a passing seed. Requirements for `proof`, `bounded`, `cover`, `simulation`
and `lint` cannot substitute for one another. Single-task SBY `prove` evidence
is conditional on the operator-declared assumptions and reviewed harness; BMC
records only its finite depth and cover records reachability. Multi-task or
vendor-specific formal flows require a reviewed converter/adapter.

Coverage goals list a case, fixed bins and minimum fraction in (0,1]. The adapter
merges hit counts across **all declared seeds of that case**. Any missing bin or
failed/incomplete run makes coverage UNKNOWN with no measured fraction. Complete
zero-hit bins are reported as explicit holes; a measured fraction below the
threshold fails. These are named functional bins, not line/toggle coverage or a
claim of full-chip verification closure. Vendor coverage databases need a pinned
converter into this evidence contract before gating acceptance.

## Industrial workflows and limits

Use task DAGs to separate specification review, reference models, test generation,
assertion/property development, regression execution, failure triage and coverage
closure. Existing read scopes, named checks, bounded child tasks, worktrees,
budgets, evidence receipts and independent final integration govern all stages.
Keep model-authored assertions and new tests exploratory until the immutable
acceptance contract admits them; a generated explanation or coverage target
cannot authorize its own PASS.

For long license-limited regressions, use the existing durable
[`ResearchJobs`/SSH endpoint](STRUCTURED_JOB_EVIDENCE.md) with an operator-owned
argv template invoking this runner, then independently validate its retained raw
evidence. Preserve the remote job identity and reconcile before replacement.
This local runner does not submit remote jobs or replace that deduplication
protocol. Set its deadline below the host/job deadline and keep license limits
within operator-owned concurrency. Commands are trusted executables and must
not detach/daemonize; this is bounded orchestration, not a security sandbox.

This PR executes real digital RTL simulation and lint. JUnit/UVM and SBY readers
have adversarial protocol tests; it does not claim a live proprietary UVM or
formal-solver campaign, CDC/RDC closure, analog verification, physical signoff,
or measured live-LLM chip-engineering productivity. Add the appropriate reviewed
tools, harnesses and acceptance contracts for those jobs. Other domains retain
their original runtime and validation interfaces.

## Validation

```sh
python3 -m unittest discover -s tests/chip-verification -p 'test_*.py' -v
node --experimental-strip-types --test tests/foundry/chip-verification.test.ts
```

The Python suite reports a skip for actual RTL execution if Icarus is absent;
protocol adversaries still run. The dedicated CI job installs Icarus and
Verilator, requires both good and negative-control executions, and uploads raw
evidence. The existing Foundry suite discovers the Node integration regression,
which checks that the independent verifier rejects failing UVM evidence despite
a successful wrapper and a worker's claimed success.

Primary tool references: [Icarus simulation](https://steveicarus.github.io/iverilog/usage/simulation.html),
[Verilator](https://verilator.org/guide/latest/),
[cocotb JUnit output](https://docs.cocotb.org/en/stable/junit.html),
[SymbiYosys configuration](https://yosyshq.readthedocs.io/projects/sby/en/stable/reference.html).
