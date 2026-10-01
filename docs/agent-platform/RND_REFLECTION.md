# Evidence-Grounded R&D Reflection Loop

Future-Code treats self-reflection as an evidence problem, not a request for an LLM to
write a persuasive postmortem. Before a failed objective is replanned, the host derives
a structured reflection from authoritative execution state and persists it as a
content-addressed artifact.

## What the host measures

The reflection summarizes productivity and failure evidence including:

- verified tasks versus admitted tasks;
- total, failed, deferred, and repeated attempts;
- repeated failure fingerprints;
- model request count, bytes, token measurements, and UNKNOWN outcomes;
- wall-clock time and known execution cost;
- verified progress per attempt/request/hour;
- context pressure against the admitted recipe;
- unresolved remote jobs and open evidence conflicts;
- recovery/replan count and comparison with the previous run.

## Shortcoming detectors

Current deterministic findings include:

- `repeated_failure_loop`
- `provider_outcome_uncertainty`
- `external_effect_uncertainty`
- `evidence_conflict`
- `context_pressure`
- `low_verified_yield`
- `low_request_productivity`
- `attempt_overhead`
- `recovery_churn`
- `replan_without_verified_gain`

Each finding contains measured evidence and a generic improvement directive. No raw
objective text, prompt, model response, or task error text is copied into the reflection.

## Closing the loop

Recovery planning now receives the host reflection in addition to the failed task graph.
An external recovery model must name the measured finding codes its replacement plan
addresses. The host rejects invented finding codes and still independently enforces task
contracts, authority boundaries, strategy novelty, budgets, and verification.

Recovery attempts persist the reflection hash and addressed finding set. Completed R&D
episodes include the reflection history and Outcome Graph reflection nodes, so later
policy learning can evaluate whether a stated intervention actually improved verified
productivity.

## Productivity is explicit

The reflection exposes measured productivity rather than a synthetic self-score:

```text
verified tasks / attempts
verified tasks / model requests
verified tasks / wall-clock hour
known cost / verified task
```

Unknown cost or token data stays `null`; it is never converted to zero. Future policy
learning can define a reward contract over these measurements without relabeling missing
evidence as success.

## Inspect

After at least one reflection has been captured:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts reflection \
  --root .future-code/rnd --objective OBJECTIVE_ID
```

The reflection table is append-only. A restarted recovery reuses the reflection captured
when that recovery attempt began, avoiding retrospective drift from later events.
