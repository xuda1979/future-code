# Objective focus and context efficiency

The interactive runtime previously used keyword overlap to decide whether a follow-up replaced the root objective. A necessary subtask such as “Fix the flaky HTTP timeout test” could therefore discard a larger research goal, reset its counters and steer subsequent autonomous work toward the wrong endpoint. Polite requests could also be mistaken for read-only questions, and a different `goal.md` could influence the milestone frontier or request review merely by mentioning the active goal.

The host now preserves an unfinished root goal until an explicit user replacement. It initializes the exact goal/status heading itself, avoiding a model/tool round trip just to recreate known metadata. It records follow-up work and corrections as steering, binds report headings and milestones to the root, and reads a fresh goal anchor after compaction for each main-thread model request. Questions remain questions; child, SDK and background requests do not inherit interactive root authority. Earlier steering is retained rather than silently dropped after eight notes. Count/byte capacity errors preserve the last readable state and become visible failures.

Mismatched goal reports are archived before repair. Completion reports still request `REVIEW`, never a machine-certified `PASS`. A newly written identical blocker report is still evaluated. The checkpoint-content hash is separate: rewriting unchanged text does not count as a new checkpoint, and the advisory reminder no longer demands a pivot merely because a file was not edited. Deep reasoning, experiment lifetimes, model selection, thinking budgets, tool permissions, independent verification and final acceptance are not reduced.

## Less repeated context

The steady-state main loop preserves its historical message prefix. It supplies `AUTO_GOAL_EXECUTION_POLICY` once in a stable host-message prefix and appends compact continuation deltas. The policy retains the full decision and blocker guidance, verification requirements, budget/permission boundaries, recovery discipline and protection for useful deep reasoning. Current objective, steering and explicit horizon remain in the fresh tail anchor. Concrete drift/blocker recovery guidance survives compact deltas. Other callers retain full standalone continuation prompts unless they explicitly install the policy and select delta mode.

`compactGoalContinuations` is now an explicit context-retirement utility, not a normal per-request optimizer. PR #93 removed older host reminders while building requests. That made the serialized view smaller, but deleting a reminder before already-processed tool exchanges shifts those exchanges out of an otherwise reusable provider prefix. The correction prevents that rewriting rather than relying only on payload shrinkage.

These mechanisms make no additional model requests and do not cache acceptance evidence. Both the invariant policy message and fresh anchor participate in the context-limit estimate. Neither accumulates in saved history. No-goal and child/SDK requests retain their existing request view. A short active-goal request pays bounded policy/anchor overhead; there is no demonstrated end-to-end speedup. Provider cache reuse remains optional, not a host-owned guarantee.

Run the reproducible offline measurement with:

```sh
node --experimental-strip-types scripts/bench-goal-cache-stability.mjs
```

The checked-in [measurement](validation/goal-cache-stability-20261109.json) compares standalone full reminders with compact deltas, and PR #93's history retirement with the current unchanged-prefix path. Each synthetic cycle contains eight tool pairs. The policy contributes 3,017 bytes once per request, instead of repeating in every historical continuation. All tool results remain present. The following are UTF-8 text/JSON structural measurements, not HTTP bytes, billed tokens, actual cache hits, task throughput, model quality or provider speed.

| Continuations | Full reminder text, bytes | Delta text, bytes | Reduction | Prior-request bytes outside common prefix: PR #93 → current |
| --- | ---: | ---: | ---: | ---: |
| 1 | 2,695 | 133 | 95.06% | 14,198 → 1,030 |
| 8 | 23,877 | 1,064 | 95.54% | 14,530 → 1,030 |
| 32 | 96,547 | 4,279 | 95.57% | 14,556 → 1,030 |
| 128 | 387,293 | 17,172 | 95.57% | 14,582 → 1,030 |

The complete current view is slightly larger than the retired view (344,137 versus 338,079 bytes at 32 cycles), because it preserves every earlier delta instead of deleting history. Its unchanged prefix is longer. Actual latency and cost depend on provider reuse, expiry and thresholds and still require live measurement. The [original PR #93 measurement](validation/goal-focus-context-20261109.json) and `bench-goal-context.mjs` are historical retirement comparisons, not the current steady-state runtime.

## Regression boundary

The focused checks run with:

```sh
node --experimental-strip-types --test tests/commands/goal-autonomy.test.ts tests/commands/goal-focus.test.ts tests/commands/goal-delta.test.ts tests/correctness/goal-context.test.ts tests/correctness/goal-prefix-stability.test.ts
```

The new goal-focus cases reproduce twelve failures on base commit `fd9df8e0c2911533705ed94698aac615ea7f5715`; all pass with the changes. Tests cover host-created goal binding, root/subtask continuity, polite requests, negative constraints, ordinary corrections, explicit replacement, stale reports, milestone binding, preserved archives, identical checkpoint writes, steering retention/capacity, budget preservation, request freshness, pause/review, transcript integrity and child isolation.

The unchanged-prefix regression executes the actual history-projection expression from `query.ts`; it fails on merged PR #93 (`95b5befc1c97c9e12a6bd1facb5047c5f0d5c308`) and passes after the correction. Delta tests separately check fixed-policy presence, unchanged prefixes across root changes, bounded recurring instructions, preserved recovery, finite budgets, completion-to-review, and paused/child authority.

Run the repository's correctness, resilience, Foundry, Swarm and command gates as well. These gates overlap; do not add their totals and describe the sum as unique tests. The offline test and payload results establish only their tested boundaries. They do not prove that an opaque external model will never select an irrelevant action, or certify every intelligence metric. Live short/long tasks, goal pivots, quality outcomes and provider-cache behavior remain necessary for an end-to-end productivity claim.
