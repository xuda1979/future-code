# V11 controlled service protocol

Frozen before collecting new service timings, 2026-10-21. The collector and
layout fitting have completed. Their outcome does not select queries or arms.
The method is in `experiments_v11/service_study.py`; the input list is
`results/v11/public_compiler/SERVICE_CASES.json`.

Use both held-out upstream executions (3 and 4) for every project. Three
whole-trajectory timing repeats randomize the four complete-arm orders using
seed 20261021. Compare the indexed ledger, the maintained-counter ledger,
the original compact HACT layout and the frozen primary cap32-selected HACT
layout. No cap64 outcome selects the primary service layout.

Every successive at-most-eight-completion wave is ingested. Query the initial,
middle and final snapshots using all seven queries returned by
`service_baselines.frozen_queries()`, each cold then warm. A replay request
beyond the current epoch returns the same explicit refusal in each arm.
All requests are defined independently of cost or layout outcomes. This is a
controlled consumer, not observed production demand.

Time construction plus every ingest plus each full query operation, including
encoding and decoding. Common immutable-snapshot preparation and independent
raw-record reference computation remain outside service timers. The complete
canonical answers and wire bytes must match for each request across all arms;
the tree's root counts must also match raw records. Stop on any mismatch.

Before performance collection, admit at most 2048 declared checks per service
trajectory. The current prototype serializes complete state on every ingest;
the 26,948-check Packaging case therefore also exceeds this bounded campaign's
service admission. Keep both full input traces and layout, record UNKNOWN,
and do not substitute a subset, zero cost or a successful tie. This is a dated
resource preflight amendment after observing registry size and before observing
service costs, not an outcome-based exclusion. It prevents a repeated
quadratic serialization campaign from consuming the research budget.
The five admitted project cases remain a descriptive sample. Per-arm deadline
is 180 seconds; a timeout is UNKNOWN and retained.

Report per-case medians across timing repeats, per-project summaries over the
two recorded executions, and all raw stage costs. Do not use query rows or
timing repeats as independent projects. Report serialized state, logical
update bytes and answer traffic separately. No physical transport, resident
RAM, provider tokens, model inference or agent solve rate is measured.
