# Proposed confirmatory study of evidence-service utility

Status: **draft protocol, not preregistered, not run** (2026-10-20).
This document proposes new work; it does not retrofit prospective status onto
the v5-v9 records. Freeze the corpus, queries, code revisions, exclusions,
analysis script and stopping rule in a new immutable record before collecting
the confirmation cohort. Retain the pilot separately.

## Research question and estimand

For a fixed, actually needed diagnostic service, does the tree index reduce
total service work relative to an indexed ledger after charging compilation,
ingestion, updates, migration, query aggregation and encoding? Equally, can
the study establish a reproducible operating region where the ledger is
preferable? Both outcomes answer the question.

The primary endpoint is total service wall time for an entire retained
trajectory under a frozen consumer request sequence. The secondary endpoints
are query response latency after query issuance, peak resident memory,
serialized persistent state and separate update/delivery bytes. Checker
execution is common work and is reported separately. Candidate-start arrival
may be reported as another explicitly labeled endpoint. Do not insert checker
time into a post-check query-response denominator.

Identical canonical answers using the same codec must have identical wire
bytes. Under that protocol, wire equality is a conformance check. A separate
delta-delivery hypothesis requires independently specified client caches,
state initialization/invalidation, recovery and all update/control traffic.
Do not change the service or codec after seeing which arm wins.

## Sampling and independence

1. Select held-out repositories and time windows from a declared project
   sampling frame before inspecting cost outcomes. Include variation in suite
   size, checker mix and completion locality. Avoid using the existing twelve
   candidates as confirmation cases.
2. Use actual source changes and recorded consumer requests when possible.
   Queries should be observed independently of HACT's favorable layout
   properties. If demand is scripted, label it a sensitivity experiment and
   do not claim that it represents observed production demand.
3. Freeze eligibility and exclusions, including unsupported checkers,
   incomplete traces and environmental failures. Retain a selection flow and
   the reason for every excluded trajectory.
4. Run a separate pilot to estimate variation and choose the number of
   independent projects/trajectories needed to detect a practically meaningful
   total-cost difference. Choose that threshold from the deployment budget,
   before confirmation. No fixed number of repeated requests substitutes for
   independent trajectories. If the attainable sample is too small, report a
   descriptive study rather than an underpowered superiority test.

## Matched execution and controls

- Compare independently maintained indexed-ledger and HACT implementations
  against a third archived-record oracle. Require exact semantic equality,
  bounded complete pages and correct reconstruction on every retained query.
  A mismatch is a correctness failure; do not drop it to improve performance.
- Hold registry, checker, source snapshot, execution schedule, query sequence,
  answer schema, compression and cache budget constant. Include root-only,
  original-order balanced, frequency-order balanced and pairwise-order
  balanced controls. An optional full-wave method must use the same proposal
  and validation budgets. Compare tree shape at the same order separately.
- Split training, validation and held-out trajectories by repository/time as
  declared before fitting. Fit no selector on confirmation costs. Report the
  incumbent whenever validation retains it.
- Include fresh, intermediate and complete epochs; sparse and dense queries;
  cold/warm caches; conflicts; migration and recovery. Preserve the actual
  observed demand mix in the primary endpoint. Synthetic stress mixes remain
  separate sensitivity analyses.
- Randomize paired arm order within host/session blocks. Use repeated process
  runs, recording host/runtime/CPU/thread settings and load. Choose repetition
  counts and host blocks from the pilot. Distinguish process repeats from
  project replication. Include two hosts if making a cross-host claim.
- Measure actual critical-path execution. Record setup once per trajectory,
  account for updates and migrations, and avoid allocating all setup to the
  first convenient query family. Keep wire traffic, stored bytes and RAM in
  separate columns. WAN claims require matched physical remote transfers;
  elapsed CPU measurements plus bytes/goodput remain modeled arrivals.

## Analysis and stopping rule

Commit a fixed confirmation cohort size and exclusions after the pilot, then
run it to completion without optional stopping on a favorable result. Analyze
paired total-cost differences with clustering at the independent project or
trajectory level, according to the sampling frame. Use the same inference
unit for intervals and tests; cold/warm rows and layout replays are repeated
measurements. Preserve per-project results and unfavorable cases.

Predeclare the single primary comparison and practical effect threshold.
Report effect estimates and uncertainty, not only a p-value. Secondary query
families are descriptive unless multiplicity handling is specified in advance.
Fit a benefit-versus-demand or break-even model on pilot/training data only;
test its predictions on the confirmation cohort. Report where the model fails.

Publish raw trace identities/digests, sampling decisions, independent reference
answers, per-stage measurements, environment records and the exact analysis
script with the paper. Any deviations from the frozen protocol require dated
explanations and separate exploratory results.

## Claims this study still would not establish

An offline fixed-query replay does not show that agents solve more tasks,
use fewer provider tokens or choose better actions. Those claims require a
separate live-agent study with matched models, prompts, task budgets and
randomization. Neither local gate soundness nor equal oracle answers certifies
test adequacy, remote attestation or distributed atomic deployment.
