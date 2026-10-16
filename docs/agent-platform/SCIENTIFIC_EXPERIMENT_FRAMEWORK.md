# Domain-neutral scientific experiment framework

Future-Code manages reproducible execution and independent evidence checking.
Projects supply their scientific methods through configured adapters. Adding a
field, instrument, simulator, data layout or validation method requires no change
to the core's domain list: there is no such list in the schema-2 experiment path.

| Component | Responsibility |
| --- | --- |
| Agent | Propose work and interpret bounded observations; cannot approve itself or edit frozen protocols |
| Runtime | Enforce exact inputs, declared replications, execution identity, artifact completeness, command pins, budgets, leases and replay |
| Execution adapter | Launch/reconcile the actual computation or instrument job and normalize observations with truthful provenance |
| Scientific validator | Independently inspect evidence and implement the project's scientific/statistical checks |
| Evidence/programme store | Retain receipts and validator reports, preserve contradictions and invalidate dependent findings |

## 1. Freeze the protocol

The preferred `ExperimentSpec` is defined in `src/harness/foundry/research.ts`:

| Field | Contract |
| --- | --- |
| `schema: 2`, `kind` | Version and project-defined identifier; `kind` does not select a built-in scientific algorithm |
| `question`, `hypothesis`, `refutation`, `protocol`, `assumptions` | Explicit research question, expected/contrary evidence, method and interpretation limits |
| `identity: {code,data,environment}` | SHA-256 identities of reviewed manifests |
| `input` | Exact JSON permitted in `run_job`; changing it requires a newly approved protocol/task |
| `parameters` | Opaque JSON interpreted by the configured scientific validators |
| `execution: {mode,backend,configurationHash}` | Declared `computational`, `simulation` or `physical` execution and pinned configuration manifest |
| `units: [{id,role,replicates}]` | All expected observations, with generic `primary`, `control` or `reference` roles and explicit replication IDs |
| `artifacts: [{id,minimumBytes,maximumBytes}]` | Required complete raw-evidence files and bounds |
| `validation: [{id,checks}]` | Required validators and exact required check IDs |
| `acceptance` | `valid-result` retains valid negative/inconclusive results; `supported-hypothesis` additionally requires support |

Parameters may describe circuits, imaging, numerical solvers or any other method.
The runtime never interprets those descriptions. Control selection, randomization,
blinding, sampling independence, units, leakage, multiplicity and uncertainty
methods must be established by the project's protocol and validators. Merely
declaring a control or a replication does not establish its scientific suitability.

## 2. Configure independent validators

Add `research: {spec, validators}` to the existing job template. For each ID in
`spec.validation`, configure exactly one `ScientificValidator`:

```json
{
  "command": {
    "argv": ["/usr/bin/python3", "/opt/project/validate.py"],
    "files": ["/opt/project/validate.py", "/opt/project/validation-environment.json"]
  },
  "readOnly": true,
  "timeoutMs": 2000,
  "maxOutputBytes": 16384
}
```

The command and its declared dependencies are pinned independently from the
experiment executor and protected against worker edits. An identical execution
command cannot serve as its own validator. `readOnly` declares reproducible,
side-effect-free validation; these are trusted executables, not an OS sandbox.
Allowlist only necessary environment variables; model credentials are rejected.
The sum of validator deadlines must fit the existing tool-stage budget, and
individual outputs must fit the coordinator's output cap. Checks cannot be
removed, renamed or replaced by a worker result.

Require the template on the task using `research: ["template-name"]`, and grant
the worker only its existing named-job/tool capabilities. Existing dynamic DAG,
scope, integration and objective-budget constraints continue to apply.

## 3. Execute and normalize observations

Use the durable `ensure`/`inspect` job path. The result envelope is:

```text
{schema:2, specHash:digest(spec), identity:spec.identity,
 execution:{...spec.execution, key:actualSubmissionKey, jobId:actualJobId},
 observations:[{unit, replicate, data}, ...]}
```

Every declared unit/replicate pair must appear exactly once. Missing controls,
missing/duplicate replications, undeclared units, non-finite values, changed
execution mode/backend/configuration, mismatched identities or another job's
result fail before scientific validation. `data` is opaque JSON; a `passed`
field inside data has no host authority. An outcome at the envelope's top level
is not permitted.

Execution adapters must establish actual code/data/environment identity and
provider/instrument provenance. The core verifies their bindings; a matching
label alone cannot prove that physical hardware ran. A simulator adapter must
not attest physical execution. Physical/remote side effects must use the durable
reconciled job path, including after disconnection or ambiguous completion.

## 4. Preserve raw evidence

The standard POSIX endpoint accepts a pinned `artifacts` mapping in its executable
template, for example `{"raw-data":{"maxBytes":65536}}`. The child writes the
flat filename `raw-data` below `FUTURE_JOB_ARTIFACT_DIR`. This setting belongs to
the endpoint template, not the coordinator's job-template object.

After execution, the endpoint captures a cold snapshot, streams its
SHA-256 and records its exact size. Missing, oversized, symlinked, nonregular or
changing declared outputs make execution fail. Capture is anchored to the
original output directory descriptor, so replacing that directory cannot redirect
the read. Names and total retention are bounded; the standard endpoint allows
up to 32 named files and 256 MiB in aggregate per job. Custom storage/provider
adapters can implement the same receipt/read protocol for larger evidence.

`read_job_artifact` accepts names from the exact terminal manifest, remains scoped
to the originating task's owned receipt, and returns bounded base64 pages.
The standard endpoint rechecks the complete captured file's hash and length
before returning a page. The scientific protocol also rejects a required artifact
that is absent, out of bounds or marked truncated. Large raw files stay outside
the model context. See [structured job evidence](STRUCTURED_JOB_EVIDENCE.md).

## 5. Validate independently

Each pinned validator receives JSON on stdin:

```text
{schema:1, validator:id, implementationHash:digest(pinnedCommand),
 spec, result, context:{key,jobId,adapterHash,artifacts}}
```

The context's artifact manifest comes from the trusted terminal receipt. Validators
must resolve raw files through their configured storage/provider interface when
their method needs those bytes, and check their hashes before interpretation.
The generic runtime's metadata checks do not replace those scientific checks.

Return exactly one JSON object:

```text
{schema:1, validator:id, implementationHash, specHash:digest(spec),
 resultHash:digest(result), contextHash:digest(context),
 checks:[{id,verdict:"PASS"|"FAIL"|"UNKNOWN",detail?}, ...],
 outcome:"SUPPORTED"|"REFUTED"|"INCONCLUSIVE", measurements?}
```

All declared checks must be present exactly once and PASS. A timeout, malformed
reply, mismatched binding, FAIL or UNKNOWN fails scientific acceptance. Finite JSON
reports remain content-addressed observations under
`research.validation.observed`, including rejected reports; they are not promoted
to programme knowledge. Raw execution receipts remain available for diagnosis.

All validators must support the hypothesis to produce support. Support versus
refutation produces `INCONCLUSIVE` plus an explicit conflict flag regardless of
how many validators agree. Conflicted findings are blocked from later task
context and strategy continuation; resolving them requires new checked evidence.
There is no majority-vote shortcut. Valid refutations and inconclusive observations
remain useful under `valid-result` acceptance.

Completed reports are reusable only for the same specification, result, execution
context and pinned implementation. Replay checks every pin and every hash again,
then rechecks the cached reports' complete required-check bindings. It does not
resubmit an experiment or invoke a validator again merely because a task retries.

## Examples, comparisons and compatibility

```sh
node --experimental-strip-types scripts/scientific-experiment-demo.mjs
node --experimental-strip-types scripts/quantum-experiment.mjs --demo
```

The first exercises the new generic protocol, independent paired-table validator
and matched local runner with two arbitrary project labels/data layouts. It uses
explicit offline fixtures and demonstrates supported/inconclusive outcomes; it
does not claim biological or physical experimental results. The reusable
paired-table statistical method lives in `adapters/research/`, outside the core.
An actual deployment replaces the fixture executor with a reviewed project
simulator, instrument or provider adapter and supplies appropriate validators.

The existing quantum CPU demo still executes real statevector evolution through
the optional schema-1 compatibility adapter. Its scientific algorithms and proof
audit rules now live in `adapters/research/legacy.ts`. Schema-1 configurations,
receipts and assessment formats remain supported; command/file pin drift still
fails closed. New fields and methods should use schema 2, not extend that legacy
adapter. Updating an immutable configuration requires a new reviewed store;
retain its pinned code/environment when resuming old experiments.

The local comparison protocol accepts a `validators` mapping alongside its
executor and cases. Schema-2 executors receive `{schema:2,spec,execution:{key,jobId}}`
and return `{result,artifacts}`; validators run in separate bounded subprocesses.
Reports retain validator implementation hashes and outputs, including failed
checks. Matched arms keep identical frozen methods/budgets and separate execution
identities. Physical/remote submissions belong in `ResearchJobs`, not the
synchronous local comparison runner. The framework enforces an evidence contract;
field-specific scientific validity remains the responsibility of the reviewed
protocol, actual execution adapter and independent validators.
