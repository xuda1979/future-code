# Evidence-driven parallel research frontiers

Open research needs competing approaches, cheap attempts to disprove assumptions,
and persistent negative findings. More agent conversations alone do not supply
these. The frontier connects the existing scientific oracle contracts, programme
ledger and dynamic task DAG to a bounded parallel search policy.

| Mechanism | Runtime behavior |
| --- | --- |
| Hypothesis portfolio | Rank eligible lines using accepted information and an exploration bonus; recommend an independent batch |
| Falsification gate | Prioritize falsification before replication and exploration; wait for declared outcome conditions |
| Dependency-aware pruning | Invalidate recommendations downstream of contradicted prerequisites, including previously observed intermediates |
| Durable reservations | Reserve a candidate at task admission, before its first remote job; reject duplicate or premature delegated work atomically |
| Strategy change | Pause optional work after the configured count of distinct inconclusive results on a line; continue other lines |
| Bounded context | Evaluate the full configured frontier locally and transmit selected protocol summaries and aggregate diagnostics |

## Enable on a scientific Swarm

Add `frontier` to the existing operator-owned `researchStrategy`. For example:

```json
{
  "schema": 1,
  "maxExperiments": 64,
  "maxSnapshotBytes": 16384,
  "stopOnRefutation": true,
  "frontier": {
    "maxParallel": 4,
    "explorationWeight": 1,
    "maxInconclusivePerLine": 3
  },
  "candidates": [
    {"id": "screen-a", "template": "cheap-a", "line": "approach-a", "purpose": "falsification"},
    {"id": "verify-a", "template": "checker-a", "line": "approach-a", "purpose": "replication",
     "after": [{"candidate": "screen-a", "outcomes": ["INCONCLUSIVE", "SUPPORTED"]}]},
    {"id": "screen-b", "template": "cheap-b", "line": "approach-b", "purpose": "falsification"}
  ]
}
```

Configure the existing independent `supervision.workflowPolicy`, bounded
`supervision.dynamicDAG`, permitted agent job capabilities, and pinned scientific
job templates. Every candidate names one unique template. The frontier supports
up to 256 candidates and 256 current-run experiment slots, with batches of up to
32 distinct lines. `maxParallel` must fit admitted recipe parallelism. Depth,
scope, context, requests, remote-job concurrency and objective ceilings still
apply. This is bounded single-host orchestration, not a distributed fleet quota.

The workflow adviser receives `decision.batch` and can propose those independent
children together, using each candidate's template in the child's `research`
requirements. Worker `spawn_tasks` uses the same admission gate. Both validate
inside the existing SQLite child-admission transaction; the second competing
proposal sees the first reservation. A rejected patch rolls back tasks, graph
changes and reservation projections together. Committed spawn replays reuse the
existing children without re-reserving a search slot.

New scientific `run_job` calls require an admitted task research requirement
when frontier mode is enabled. Reconciliation of an existing job remains allowed.
Initially admitted mandatory tasks keep their original requirements, even when
the search policy would prefer another line. The frontier controls optional
delegation; it cannot cancel mandatory checks or certify results.

## What the allocation score means

Within each purpose, rank lines by

`distinct conclusive protocol/outcome pairs / distinct checked results`

plus `explorationWeight * sqrt(log(total checked results + 2) / (line results + 1))`.
Then prefer lower measured job durations and finally configured order. Select at
most one new candidate per line in a batch; an unresolved assignment occupies
its line. Negative findings earn information credit just as positive findings do.
Repeated copies of the same exact result do not inflate credit. Job duration is
host-observed creation-to-terminal time, not accelerator compute or dollars.

This UCB-inspired score is a compute allocation heuristic, not a calibrated
confidence, semantic information metric, learned policy or full MCTS. Models
cannot supply rewards or feasibility scores. `maxInconclusivePerLine` counts
distinct inconclusive results across the visible accepted observations, not
consecutive conversational turns. It pauses optional recommendations for that
line; it does not prove the approach impossible.

All prerequisite conditions are checked transitively. If a screen is refuted,
an earlier supported intermediate cannot keep a dependent proof branch eligible.
A separately declared alternative conditioned on `REFUTED` can still proceed.
Conflicts cannot satisfy any outcome condition or be resolved through voting.
Missing evidence causes waiting. Refutation of one line does not reject unrelated
lines. Existing programme exact-version invalidation and acceptance-time checks
continue to govern actual imported scientific dependencies.

## Different fields use the same runtime

Use [schema-2 oracle contracts](SCIENTIFIC_EXPERIMENT_FRAMEWORK.md) for new fields.
The core does not interpret equations, proof tactics, assay measurements, molecules
or device layouts. Projects supply state/action encodings through pinned executor
adapters and define validity through separately pinned validators. Valid negative
and inconclusive results use `acceptance: "valid-result"` and may enter the
[programme ledger](research-programmes.md) after independent task acceptance.
With [project knowledge](PROJECT_KNOWLEDGE.md) enabled, these findings also become
retrievable experience cards. Subsequent retraction or conflict downgrades their
trust labels; retrieved advice never bypasses the frontier's exact evidence gate.

For mathematics, make the target statement, allowed assumptions/axioms and proof
artifact identity part of the reviewed protocol. A formal kernel checks a proof
of that exact statement under those assumptions. A CAS result, finite numerical
search or agent's natural-language argument does not automatically become a proof
of a universal conjecture. The frontier introduces no blanket trust in a compiler.
Autonomously generated tools and validators still need the existing immutable
acceptance boundary; a worker cannot install an easier oracle to approve itself.

The opt-in [theory contract](theoretical-research.md) enforces exact deductive
prerequisites, distinguishes exploratory evidence from checked deductions, and
prioritizes shared missing lemmas. Mandatory parent targets retain their budget
reservations while dormant proof slots make room for prerequisite work.

Hypothesis methods and their outcome conditions are currently configured and
finite. Agents can generate exploratory proposals in ordinary bounded tasks, but
this change does not automatically admit new scientific protocols, synthesize
trusted validators or guarantee progress on unsolved problems. Existing cohorts,
claim graphs, evidence receipts and programme imports remain the collaboration
and knowledge mechanisms; this is not a second scheduler or a new transcript store.

## Inspect, recover and evaluate

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts research-strategy --root STATE --run RUN
node --experimental-strip-types src/harness/foundry/swarm/cli.ts research-strategy-rebuild --root STATE --run RUN --allow-exec
node --experimental-strip-types scripts/research-frontier-demo.mjs
```

`research_assignments` is a derived indexed projection of `tasks[].research`.
Triggers maintain it for task admissions and transaction rollback. Existing
stores are backfilled once on migration; the rebuild command reconstructs it
from authoritative task specifications. Status, leases and execution edges stay
in `tasks` and `spawn_edges`. Candidate lookups use `(run, template, task)` rather
than parsing every completed task at each strategy review. Resume preserves
reservations; failed tasks do not silently make their experiment spend free.
Snapshots expose actual job count as `used`, assigned work without a job as
`reserved`, and their sum as `committed`. Oversized contexts fail closed.

The local demo searches the polynomial `n²+n+41` and independently verifies the
exact counterexample `n=40`, value `1681`, divisor `41`. With a screen covering
`0..50`, adaptive selection avoids one follow-up job. With a screen covering only
`0..30`, its result remains INCONCLUSIVE and a larger search proceeds. Both arms
retain the same refuted line. The comparison runner is serial, uses alternating
arm order and identical frozen protocols, and includes neither live LLMs nor
physical devices. It establishes avoided work for these cases, not a general
speedup. Separate runtime tests exercise parallel jobs, competing proposers,
restart, rollback, exact evidence reuse and cross-run negative findings in an
arbitrary schema-2 field. Unknown tokens and dollar costs remain null.
