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
