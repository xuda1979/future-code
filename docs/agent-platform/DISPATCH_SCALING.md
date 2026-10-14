# Execution review and indexed dispatch

The review of main at `0a130d2` found concrete host costs that grow with swarm
size, and a provider-routing defect that can prevent recovery. Existing
evaluation, debugging, replay and verification mechanisms already cover many
other failure modes. The changes below improve those mechanisms' execution
path without introducing another reasoning agent or model request.

| Finding | Change | Result |
|---|---|---|
| Ready selection joins allocation scores and sorts the eligible set on each refill | Mirror task status and allocation score transactionally into the rebuildable scheduler index; traverse its complete ordering index | Exclude completed tasks and avoid a temporary ordering tree for the normal ready window |
| Each task's allocation refresh scans all ranks to compute `MAX(rank)` | Add an index on `(run, rank DESC)` | Avoid the repeated full-rank scan during run initialization and allocation refresh |
| A workspace with dependencies reads every spawned edge; even a parent-filtered query can choose a run-wide index to satisfy child ordering | Read child families only for the required closure and cover `(run, parent, child)` | Local and remote patch planning avoid unrelated families; a parent with no children gets an indexed empty lookup |
| Fallback HTTP requests use the primary model identifier | Send the configured route's model; meter the actual wire payload and persist a separate logical replay binding | Alternate model IDs work for both supported protocols, including competing responses and crash replay |

`tasks` and `spawn_edges` remain authoritative. A candidate still needs source
status, dependencies, scope, context, budgets and lease admission, followed by
independent task and integration verification. Allocation scores only order
otherwise admissible work. Trigger updates roll back with their source
transaction and work across database connections.

Opening an existing store atomically adds and backfills the two dispatch
projection columns and upgrades the child-family index. Normal scheduler-index
rebuilds restore status and allocation hints from their source tables. A reopened
store recreates missing physical indexes. Frozen contracts, task states, request
counts and accepted evidence retain their identities.

For provider requests, `agent_requests.request` and `bytes` describe the exact
wire payload. A nullable `replay_request` binds a different model ID to the
original logical turn. The journal permits that binding only when the remaining
request fields are identical. The first current reply wins; losing, unknown and
late requests still consume budget. Old rows retain their original replay key.
History projection accounts for the longest encoded model ID in the configured
routes, keeping every route inside the same admitted context envelope.

## Measurement

[Recorded offline evidence](validation/dispatch-index-20261014.json) includes
raw samples, baseline identity, candidate source hashes, query plans and runtime
version. The comparison uses identical task fixtures at 1,000 and 10,000 nodes.
Ready windows contain up to 64 tasks; dependency planning needs two tasks while
the run contains hundreds or thousands of unrelated spawned edges.

| 10,000-task fixture | Baseline | Candidate | Baseline / candidate |
|---|---:|---:|---:|
| Ready window, median | 8.998 ms | 0.174 ms | 51.7 |
| Maximum-rank lookup, median | 0.504 ms | 0.00170 ms | 296.7 |
| Two-task dependency closure, median | 4.981 ms | 0.0283 ms | 176.3 |
| Real run initialization, one sample | 9.156 s | 2.912 s | 3.14 |

The one-task arithmetic comparison accepted one independently checked output in
every repetition of both arms, with no model calls. Its ten-repetition median
changed from 5.219 ms to 5.347 ms, an increase of 0.129 ms. This small local
comparison does not establish a universal short-task speed guarantee.

The SQL fixture's status rows exercise query selection only. They do not certify
accepted artifacts. Run initialization uses the real scheduler; its elapsed time
is one sample per size. Query timings use warmed repeated samples. These results
measure host execution costs, not scientific success, billed tokens or a
live-model productivity multiple.

```sh
git worktree add --detach /tmp/future-code-baseline 0a130d2
node --experimental-strip-types scripts/bench-dispatch-index.mjs \
  --baseline /tmp/future-code-baseline
node --experimental-strip-types scripts/bench-foundry-productivity.mjs \
  --runtime-root /tmp/future-code-baseline --tasks 1 --repetitions 10 --overhead-only
node --experimental-strip-types scripts/bench-foundry-productivity.mjs \
  --tasks 1 --repetitions 10 --overhead-only
```

The dispatch improvement does not imply constant-time claims in every case.
Many delayed or scope-conflicting high-ranked candidates still require traversal.
Whole-run initialization, graph changes and final integration still inspect the
relevant whole graph. Additional indexes also add storage and update work.

## Remaining priorities

| Priority | Recommendation | Evidence to collect |
|---|---|---|
| 1 | Bind each substantial objective to a cheap, decision-relevant measurement, and use existing evaluation cadence and fresh-evidence job preflights before expensive work | Time to first discriminating result, premature job submissions, failed or inconclusive measurements |
| 2 | Measure paired baseline/candidate projects before promoting new strategy or orchestration defaults; retain failed trials | Time to independently accepted output, quality gates, actual requests/tokens/cost, human interventions |
| 3 | Close the runtime boundary between terminal `/goal` guidance and Foundry/Swarm's enforced named-check/job policies | Equivalent admission and replay tests for the terminal entrypoint; measured short-task overhead |
| 4 | Use phase timings to decide whether the next bottleneck is provider wait, tools, verification or remote compute; enable explicitly independent verifier parallelism where applicable | Critical-path wall time and phase coverage, rather than summing overlapping worker durations |

The host cannot determine whether an operator's chosen measurement is
scientifically decisive. That remains an objective/evaluator design problem.
The changes here govern Foundry/Swarm, including local and worker-fleet patch
planning; they do not automatically add those controls to the older terminal
query path. They contain no knowledge of a particular R&D project.

## Validation

Regression tests cover equivalent scheduling order and pagination, delays,
rollback, a second database handle, index rebuild, existing-store migration,
nested child closure, query plans, both provider protocols, competing replies,
exact request accounting, replay input drift and alternate-model context limits.

```sh
node --experimental-strip-types --test tests/foundry/dispatch-index.test.ts \
  tests/foundry/dependency-closure.test.ts tests/foundry/provider-recovery.test.ts
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```

Use the [paired real-project protocol](REAL_PROJECT_EVALUATION.md) for claims
about sustained R&D productivity.
