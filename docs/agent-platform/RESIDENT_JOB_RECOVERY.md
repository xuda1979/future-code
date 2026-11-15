# Recover long jobs on the machine doing the work

The November 2026 feedback described useful infrastructure but little movement
in the requested evaluation. Its central failure was a composition problem:
validity checks could reject a bad run, but no dependable local control loop
kept a recoverable run alive. Transport recovery, directory-name conventions,
and agent attention became prerequisites for another useful step.

The supplied POSIX endpoint now supports an optional **resident supervision
policy**. It uses the existing stable job key and execution lock. It does not
discover jobs by directory regex, PID-name pattern, HTTP port or browser session.
The recovery loop runs on the execution machine after the client disconnects.

## What changes

| Failure pattern | Runtime behavior |
| --- | --- |
| Trainer exits while the observer is offline | The resident worker reaps the owned process group, resolves a complete checkpoint, and retries an explicitly permitted exit class. |
| New run-directory naming silently bypasses a watcher | Job records and the stable key identify the job. Checkpoint selection reads manifests, not naming conventions. |
| Container reset removes dependencies | A pinned, idempotent project bootstrap runs before each attempt; failure prevents launching. Persist the endpoint, template, bootstrap, spool and checkpoints outside ephemeral container storage. |
| Newer state and older weights disagree | Recovery chooses one published generation with matching component steps, contract and hashes. Incomplete/corrupt newer saves cannot be mixed with older files. |
| A crash repeatedly loses the same work | Retry count and total wall time are bounded. One unchanged failure may be retried; repetition at the same checkpoint stops for diagnosis. No missing-checkpoint cold restart is automatic. |
| Logs/steps grow while the goal metric is flat | Status shows execution sequence separately from the reported current value, baseline delta, historical best, sample count and measurement freshness. |

This improves availability without changing task checks, leakage checks, frozen
evaluations, promotion thresholds or final acceptance. Recovery eligibility and
promotion quality are separate: a complete below-baseline checkpoint can be a
valid continuation source while remaining ineligible for promotion.

## Configure the trusted template

Start from [resident-template.json](../../examples/swarm/supervised/resident-template.json).
All paths, hashes, baseline values, budgets and thresholds are **illustrative**.
Replace them with the actual project contract before enabling supervision.

- `supervision.replaySafe: true` is an operator declaration that attempts and
  bootstrap are safe to repeat under the same logical job identity. Model input
  cannot authorize recovery or supply an executable command.
- `maxAttempts` includes the first attempt (1–32). `retryExitCodes` explicitly
  names nonzero exit codes or negative POSIX signals. OOM and SIGKILL do not
  inherently prove transience; diagnose repeated failures instead of looping.
- `timeoutMs` bounds the entire job, including checkpoint validation, bootstrap,
  all attempts and backoff. It is never reset on retry. Host `maxJobs` counts
  logical submissions; account for this pinned attempt budget when setting
  objective compute limits.
- `pollMs` is the local observation interval. Process exit wakes the keeper
  immediately. `backoffMs` is bounded by the remaining total deadline.
- Optional `stallMs` requires a new completed semantic sequence. Set it above
  the slowest legitimate stage, including slow saves/evaluations. Heartbeats,
  log growth, repeated or regressing sequences cannot extend it. A semantic
  stall stops with diagnostics; it does not blindly kill/relaunch indefinitely.
- Optional `bootstrap.argv` uses an absolute executable and a bounded deadline.
  The project owns pinned dependency restoration and the runtime smoke check;
  the shared runtime does not guess package versions or change a recipe.
- Optional `checkpoint` declares the exact complete component set and a
  contract hash binding code, configuration, inputs and resume semantics.
  The actual checkpoint root is `<root>/<stable-job-key>`, preventing separate
  seeds/inputs from silently inheriting another job's state.
- Optional `goal` declares an advisory measurement name, scoring-contract hash,
  direction, baseline, minimum delta and freshness deadline. It does not certify
  measurements or alter the objective. A fresh unchanged measurement is still
  `UNCHANGED`; a new execution step cannot renew an old measurement's freshness.

Deploy `research-job-agent.py`, `research_job_supervision.py` and
`research_job_checkpoints.py` together. Pin **all three**, the trusted template,
the bootstrap and experiment entrypoint in the adapter's `files` manifest.
Legacy templates without `supervision` keep one-shot behavior and artifact paths.
An ordinary terminal session must deploy/use this endpoint or its native job
scheduler; new guidance alone cannot turn an existing Bash process into a
supervised job. The shared terminal/Swarm guidance now calls for a tiny
launch/save/terminate/resume/measure lifecycle before costly external work.

## Publish and resume complete checkpoints

The trusted experiment receives:

| Environment | Meaning |
| --- | --- |
| `FUTURE_JOB_KEY` | Stable logical job ID, unchanged across attempts |
| `FUTURE_JOB_ATTEMPT` | Current attempt number |
| `FUTURE_JOB_CHECKPOINT_ROOT` | This job's isolated checkpoint namespace |
| `FUTURE_JOB_CHECKPOINT_CONTRACT` | Pinned checkpoint compatibility contract |
| `FUTURE_JOB_RESUME_PATH` | Selected complete bundle directory, absent on a fresh start |
| `FUTURE_JOB_RESUME_STEP` | Selected bundle's completed sequence |
| `FUTURE_JOB_PROGRESS_PATH` | Shared atomic progress/measurement record |
| `FUTURE_JOB_RESULT_PATH` | Current attempt's final structured result, when enabled |

After a completed save, project code calls `publish_bundle` from
`scripts/research_job_checkpoints.py` with a staging source directory, completed
step, contract and declarations such as:

```json
{"weights":{"path":"weights.bin","step":10},"state":{"path":"state.json","step":10}}
```

The helper copies bounded regular files, verifies source stability, hashes and
fsyncs the files/manifest, then atomically publishes a generation. The resolver
requires the exact component set, validates hashes and same-step identities,
and selects the newest valid generation. In-progress saves are invisible;
completed generations are never overwritten or deleted by this helper. Retain
at least the last complete generation while publishing its successor.

The project must save every state needed for its actual lifecycle, including
optimizer/scheduler, random state and input position where applicable, and load
from `FUTURE_JOB_RESUME_PATH`. A generic byte manifest cannot prove an internal
step label truthful or make a non-resumable trainer resumable. Prove a short
uninterrupted versus resumed trajectory before a costly run. Treat published
generations as immutable. Publication/resolution reject changed files during
validation; project code must verify the selected manifest at point of use if
another actor can mutate completed storage afterward.

## Progress and evidence

Write the progress file atomically after real completed work. For example:

```json
{"sequence":17,"metric":{"name":"heldout_score","contract":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","value":0.2,"samples":68}}
```

`sequence` measures execution progress. `metric` is a separately reported goal
measurement. Invalid, mismatched, nonfinite, replayed and stale measurements do
not become improvement. Current regressions remain visible even after a better
historical result. Missing measurements are `UNMEASURED`, not a zero score.

The endpoint exposes live `result.supervision` under the existing job protocol.
`ResearchJobs.list` stores a bounded derived projection, observation timestamp
and cold receipt reference; ordinary status does not reopen large result files.
Transport loss makes job status `UNKNOWN` while the last observation stays
historical. It does not extend the semantic deadline or authorize a replacement.
Reports are labelled `OBSERVATION_NOT_ACCEPTANCE`. Project task/final checks
must independently validate the actual scientific result and scoring contract.

Attempt directories retain separate logs and receipts. The final artifact-read
API uses the last executed attempt's hash-bound artifacts. A malformed final
result cannot trigger an automatic retry or be upgraded to success.

The resident keeper itself is not a reboot-surviving scheduler. If its ownership
lock is lost, the endpoint still reports `UNKNOWN` and never starts a duplicate
job. Use a native service/scheduler with durable storage for host/container
replacement, reconcile surviving external effects, then resume under its
contract. This change does not restart the quantum project or consume its GPUs.

## Reproduce the evidence

```sh
python3 -m unittest discover -s tests/research-jobs -v
node --experimental-strip-types --test tests/foundry/job-availability.test.ts tests/foundry/job-races.test.ts tests/foundry/job-evidence.test.ts
python3 scripts/benchmark-job-availability.py --baseline-revision 8b958ea350692a5ab82422f46a9b7923ba90782b --trials 5
```

The [measured paired report](validation/resident-job-recovery-20261115.json)
compares the original endpoint with resident supervision on the same six-unit
workload, crashing after unit two. No inspection RPC drives either arm after
launch. Baseline jobs terminate failed; resident jobs resume and finish. Recovery
gaps are measured from the workload's crash event to its resumed start.
This is an offline execution/recovery experiment, not evidence of live-LLM
productivity, IBM benchmark improvement, or accelerator recovery latency.
