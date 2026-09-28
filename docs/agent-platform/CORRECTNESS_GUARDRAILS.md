# Acceptance and recovery guardrails

Base revision: `895dfbad639be09a111cbbf4fe3ea71ccee7b263`.

## Guarantees introduced by this patch

### Acceptance policy is not an optimization knob

`shouldApply` admits only positive, integral, bounded execution-policy changes:
parallelism (at most 4), context multiplier (at most 8), and existing tool timeouts
(at most 600,000 ms). Empty/no-op proposals and unknown paths are rejected.
`applyProposal` repeats the complete validation before any write. A mixed
proposal is rejected atomically. `approved: true` is not an authorization bypass.

Gate requiredness, SLO thresholds, and command definitions cannot be changed by
this improver. A timeout increase does not relax the promised runtime threshold.
Legacy quarantine/promotion rules remain inspectable as diagnostic proposals;
both automatic and direct application are denied. Gate-policy changes require a
separately reviewed/versioned manifest, not another self-improvement iteration.

An already weakened manifest is not silently repaired by this patch. Before
resuming unattended work, compare existing gate/SLO definitions and improvement
history with the intended acceptance baseline. Restore or replace the manifest
through an explicit review; do not compare results across changed contracts.

### Measurements and health fail closed

A missing, nonnumeric, or nonfinite SLO observation is represented as
`observed: null`, `status: "UNKNOWN"`, `met: false`. Measured zero remains zero.
Health requires at least one required gate, all required gates passing without a
timeout, and valid passing SLO observations. A fabricated pass-rate of 1 cannot
make an empty or wholly advisory run healthy.

### Committed model responses are recovered before diagnostics

The provider-response transaction can complete before the thread checkpoint.
Recovery first checks for a committed reply at the current logical step, derives
the original provider request using the same context projection, and verifies
its request hash. It then consumes/checkpoints the reply before adding recovery
instructions or periodic-check feedback. A final assistant reply is converted to
a worker artifact before diagnostics can turn it into a new model request.

Replay preserves lease fencing, response validation, truncation rejection,
request accounting, thread turn counts, and independent verification. It issues
no new RPC or reservation. A model's final text still does not accept the task.
No database migration or reset is required.

### Queued startup is reconciled without replaying uncertain execution

Both `ensure` and `inspect` reconcile a job still durably `QUEUED`. Startup state
is inspected/updated under `worker.lock`, inside the existing registry lock.
Retries are spaced by five seconds and capped at three persisted launch
attempts. Every runner reacquires the worker lock and publishes `RUNNING` before
invoking the trusted command. A delayed runner cannot execute a terminal job.

When all startup attempts are exhausted and the record remains `QUEUED` without
a worker lock, the endpoint returns `FAILED` with an explicit startup error. The
host can then release the remote-capacity reservation. A transient spawn error
preserves the stable job ID instead of producing an unreconcilable submission.

`RUNNING` without ownership remains `UNKNOWN`. It is never automatically
resubmitted. A lost connection does not establish that a research job stopped.
Corrupt state is preserved for reconciliation, never erased to force progress.

## Regression gate

From the repository root on Linux/macOS/WSL, with Node >=22.13, Python 3, and Git:

```sh
node scripts/test-correctness.mjs
```

The gate runs 24 new TypeScript tests, 8 new Python tests, and the 7 existing
Python remote-job tests. It installs nothing and invokes no real model endpoint
or accelerator. The replay tests exit a real child process immediately before
`model.reply` is checkpointed, reopen the SQLite store, and recover the saved
response. Another test applies a replayed write in an actual Git worktree and
runs independent patch verification. Request tampering, stale fences, and
truncated responses remain negative controls.

Legacy Bun tests that expected automatic gate demotion or SLO relaxation have
been updated to assert rejection and preservation of the original contract.
Run these, then the repository's complete test/build gates, in the deployment
environment:

```sh
bun test tests/harness/improver.test.ts tests/harness/multilang.test.ts
```

The focused gate does not replace the full suite, compiled CLI boot checks,
live-provider canaries, or target remote-compute validation.

## Deliberate scope boundaries

This patch fixes acceptance weakening, missing-measurement success, committed
reply recovery, and abandoned queued startup. It does not implement the following
larger review recommendations:

- automatic candidate-code/data staging and remote experiment attestation;
- autonomous, versioned repair-plan admission after integration failure;
- multi-host scheduling, KV-cache sharing, or learned concurrency control;
- correction of the legacy `progressDensity` denominator or clean-build packaging.

Remote wrappers must still authenticate the exact candidate tree/patch, data
manifest, environment, checkpoint, and evaluation contract before expensive
execution. A successful process exit is not scientific acceptance. An objective
in `NEEDS_ATTENTION` still requires intervention where no admitted repair plan
exists. Do not present this patch as removing those limitations.

## Applying and reverting

Use a clean branch from the base revision and run `git apply --check` before
applying the supplied patch. Run the focused gate before committing. Reverting
with `git apply -R --check` followed by `git apply -R` is appropriate only before
further edits to the affected files; otherwise revert the committed change.
Persistent job records contain additive startup bookkeeping. Removing the patch
does not delete records, experiments, checkpoints, or branches.
