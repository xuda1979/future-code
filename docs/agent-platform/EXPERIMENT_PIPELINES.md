# Reuse experiments and promote candidates from measured results

Long R&D loops lose compute when a fresh model call repeats an unchanged
experiment or promotes every idea directly to an expensive run. Ordinary
`run_job` identities previously included the tool-call ID; a context reset
followed by a new ID could therefore launch the same input again. Local
`preflightChecks` can validate source but cannot express a threshold on a
previous remote experiment's structured metrics.

The optional `experiment` policy adds identical-input reuse and a chain of
measured promotion gates to existing job templates. There are no model names,
datasets, training algorithms, quantum libraries, or scientific rules in the
runtime. Projects supply adapters, metrics, identity fields and thresholds.
Mathematical search, compiler benchmarks, numerical simulations and model
training can use the same mechanism.

## Configure a cheap stage before an expensive stage

Merge this fragment into two **complete existing job templates**. Adapter,
polling, capacity and budget fields are still required:

```json
{
  "jobs": {
    "pilot": {
      "experiment": { "reuseIdentical": true }
    },
    "full": {
      "experiment": {
        "reuseIdentical": true,
        "promotion": {
          "from": "pilot",
          "matchInput": ["candidateHash", "datasetHash", "evaluationHash", "seed"],
          "metric": ["data", "metrics", "score"],
          "direction": "max",
          "threshold": 0.8
        }
      }
    }
  }
}
```

`matchInput` names top-level input fields; every named field must be present
and non-null. Use immutable content hashes for candidate/checkpoint, data and
evaluation protocol, and an explicit seed or replicate ID. Extra fields may
specify stage-specific resources or fidelity. Reuse binds **all** input fields,
not just this matching projection. The sample threshold is illustrative;
select it from the project's baseline, uncertainty and compute budget.

`metric` is a path relative to the predecessor's `run_job.result`. The built-in
structured-result endpoint places output under `result.data`, hence
`["data", "metrics", "score"]`. An adapter returning `result.metrics` would use
`["metrics", "score"]`. `max` requires `>= threshold`; `min` requires
`<= threshold`. Only finite numbers qualify.

Every submitting profile must have both stage capabilities. Cycles, missing
stages and malformed policies fail before initialization. Configure another
gated template for longer pipelines, for example `pilot -> medium -> full`.
Batch independent candidates at each ready stage. Propose dependent stages
after their predecessor completes; requesting a full stage without a completed
predecessor is rejected before any full-stage intent or adapter call.

## Exact reuse and durable recovery

| Situation | Behavior |
|---|---|
| New call ID, same task/run, source and complete input | Reuse the job identity; completed results need no adapter call or new job budget. |
| Duplicate calls in one controller batch | Share the pending RPC and retain every tool/result pair. The adapter still enforces cross-process `ensure(key)` idempotency. |
| Patch, dependency artifacts, base, input, adapter or template changes | A new call receives a different identity. |
| Intentional replication or retry | Change an explicit seed, replicate or attempt field. Cached failed/cancelled results are also retained. |
| Existing call after an edit, crash or missing prerequisite | Reconcile its original identity. A durable call alias preserves its admitted source fingerprint. |
| New expensive job | Require the latest matching predecessor to be successful, reconciled, and above/below the metric threshold. Failed, running, unknown, missing or nonnumeric results cannot promote. |
| Newer matching predecessor fails or is running | An older passing metric cannot authorize promotion. |
| Different task, run or objective replan | No result sharing or borrowed promotion authority. |

The source fingerprint includes the pinned base, verified dependency artifact
hashes and durable patch hash. It invalidates reuse after edits; it does not
transfer source remotely or prove which code an adapter ran. The trusted adapter
must stage and verify the exact candidate/checkpoint and data referenced by its
input. Mutable remote paths, changing services and unseeded randomness are
unsuitable for identical-input reuse. Omit this policy when identical inputs
intentionally request fresh observations.

Promotion runs inside the existing job-intent transaction, before budget or
capacity is consumed. Indexed input projections avoid full history scans.
`job.intent` links a `promotionReceipt` containing exact result/reconciliation
hashes, source/identity/policy hashes, metric and threshold. `job.reused` exposes
reuse without inventing saved GPU-hours, costs or live productivity measurements.

The worker receives permitted pipeline policies in its normal initial context.
No extra reviewer request or operator interview is needed. Existing local
preflights, leases, capacities, objective budgets, polling, and independent
task/integration checks remain enforced. Metrics authorize compute allocation
only. Scientific `research` templates retain their separate frozen protocol and
assessment workflow and cannot also declare this policy.

## Verification and measurement

```sh
node --experimental-strip-types --test tests/foundry/experiment-pipeline.test.ts
node --experimental-strip-types scripts/bench-experiment-pipeline.mjs
```

Regression coverage includes concurrent duplicates, restarts, source changes,
replication, minimum/maximum metrics, stale/negative results, receipt integrity,
stage identity and task/run isolation. A scripted worker confirms successful
experiment metrics cannot make broken source pass independent verification.
The benchmark uses the real local job endpoint and independent checks with a
fixed computational workload. It does not measure live LLMs, model training,
or quantum-gpt research progress.
