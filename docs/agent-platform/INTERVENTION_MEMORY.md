# Intervention Effectiveness Memory

Future-Code closes the reflection loop with empirical intervention memory.

A host reflection identifies a measured shortcoming. Recovery proposes a changed execution
strategy. Once the replacement run also has a host reflection, Future-Code compares the
two runs and records the intervention's measured effect.

## Structural intervention classes

The host derives reusable strategy classes from the before/after task graphs, including:

- reduce/increase task count
- reduce/increase parallel roots
- reduce/increase dependency edges or graph depth
- reduce/increase context budget
- reduce/increase estimated duration budget
- narrow/widen read or write scope
- change agent mix
- semantic plan change when structural shape is unchanged

The stable intervention identity is based on this class set so observations can aggregate
across projects with different concrete task counts and graph sizes. Concrete before/after
measurements remain in the evidence artifact.

## Outcome measurement

When source and target reflections are both available, Future-Code compares:

- verified task fraction
- verified progress per attempt
- verified progress per model request
- terminal run status
- wall-clock time
- known cost

The empirical outcome is one of:

- `IMPROVED`
- `NO_CLEAR_GAIN`
- `REGRESSED`
- `UNKNOWN`

Each immutable row binds source and target reflection hashes, finding code,
intervention classes, domain, and comparison evidence hash.

## Memory supplied to recovery

Before a new recovery request, Future-Code aggregates historical outcomes in the same
evidence domain for the currently measured finding codes.

The planner receives sample counts and improved/neutral/regressed/unknown counts.
Fewer than three observations remain `OBSERVED`; three or more become `SUPPORTED`.

`SUPPORTED` still means observational evidence, not causal proof. The recovery prompt
explicitly warns the model not to blindly repeat a historically successful intervention
when the current evidence differs.

## Learning loop

```text
measured shortcoming
  -> intervention
  -> next verified execution
  -> measured effect
  -> intervention memory
  -> future recovery context
```

This is the substrate for later offline policy evaluation and learned recovery policies
without inventing a synthetic reward or treating missing measurements as success.

## Contextual policy

`contextualPolicy.ts` now stores the host-measured pre-intervention context
alongside each effect. It binds domain, verifier, environment, model-profile
identity, graph scale, context pressure, verified fraction, repeated failures,
provider uncertainty, unresolved jobs and recipe parallelism. No raw project
prose, credentials or model confidence are policy features.

The recovery planner receives two distinct views:

- Existing domain-wide outcome summaries: weak observational background.
- Exact context-stratum recommendations: `CONSIDER`, `AVOID` or `ABSTAIN`, with
  sample counts and 95% Wilson intervals for improvement and regression rates.

Repeated source/target transition snapshots count once. Unknown outcomes cannot
increase support; sparse or uncertain results trigger abstention. Interventions
that reduce acceptance surface cannot become positive recommendations. Contexts
with different verifier, environment or model identity never pool into one
contextual recommendation.

The source reflection is the exact immutable hash recorded when the planner
acted. Later requests/reflections cannot contaminate that pre-treatment baseline.
Only terminal target runs enter the learned observation set. Historical legacy
rows lacking a recorded context remain domain summaries; they are not backfilled
with invented context or silently promoted to contextual evidence.

These statistics are advisory observational policy learning. They do not learn
model weights, provide causal identification, guarantee productivity or authorize
an otherwise invalid recovery plan. The host continues to enforce frozen scopes,
checks, budgets, strategy novelty and objective completion.
