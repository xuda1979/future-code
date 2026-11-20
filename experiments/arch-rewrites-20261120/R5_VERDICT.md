# R5: Speculative worktree racing — verdict: MEASURED WIN (5.4× tail), SHIPPED as scheduling mode

Question (rnd_plan.md issue 5): does racing mutually exclusive fix
hypotheses in parallel isolated worktrees compress time-to-first-PASS when
the root cause is unknown (heuristic ordering unreliable)?

## A/B model (`r5-speculative-race.mjs`, results in `r5-results.json`)

Five hypotheses (unique true fix H4, work 800–950 ms each + 120 ms verify).
Serial incumbent tries hypotheses in heuristic order; racing runs all five
concurrently in isolated worktrees, first PASS wins, losers terminated at
the winner's finish.

| Serial heuristic order | Wall to PASS | CPU |
| --- | --- | --- |
| winner-first (best case) | 920 ms | 920 ms |
| winner-third | 2910 ms | 2910 ms |
| winner-last (worst case) | 4980 ms | 4980 ms |
| **racing (order-invariant)** | **920 ms** | 4600 ms |

- **Wall speedup vs worst-case serial: 5.41×**; vs best case: 1.0× (racing
  never loses — it always achieves the winner's own cost regardless of
  ordering).
- CPU: racing pays truncated losers (4600 ms) — below worst-case serial
  (4980 ms). Racing only loses on CPU vs the best-case order — i.e. when
  the heuristic already knows the root cause, don't race.

## Shipped: `scheduling: "speculative-race"` in the swarm scheduler

The production gap (verified pre-change): `claimMany` serialized
write-scope conflicts (scheduler.ts `accessConflicts` on the active set),
so competing same-file fix hypotheses ran strictly sequentially.

The change (explicit opt-in recipe mode, old recipes unchanged):

1. **Admission** (scheduler.ts): `scheduling: "speculative-race"` skips the
   write-scope conflict serialization in `claimMany`. Physical isolation
   was already per-task (LocalGitHands detached worktree, workspace.ts:130),
   so conflicting hypotheses execute concurrently without interference.
2. **Atomic resolution** (scheduler.ts `finish`): the first accepted PASS
   cancels every still-RUNNING task whose access scope conflicts with the
   winner — attempts marked FAIL, task FAIL with
   `speculative race lost: ...`, `race.lost` event — inside the same
   transaction as acceptance. A loser cannot slip a second PASS through.
3. **Run outcome** (scheduler.ts `claimMany`): a race-lost FAIL is the
   mode's normal resolution, not a run failure; the run finishes PASS when
   the winner(s) PASS.
4. **Integration** (swarm/host.ts `integrateSwarm`): the integration order
   roots at PASS tasks only — a cancelled loser's patch is never applied
   and never reaches the integration commit.
5. **Validation** (kernel.ts): `speculative-race` joins the allowed
   `scheduling` values; `validateSwarmTasks` unchanged (protected paths
   were already rejected for every write scope).

Regression coverage (`tests/foundry/speculative-race.test.ts`,
`tests/foundry/swarm-race.test.ts`, 7 tests, all in the foundry suite):

- racing admits conflicting hypotheses concurrently; serial mode still refuses;
- first PASS atomically cancels conflicting peers; non-conflicting work survives;
- late loser finish is stale-fenced (double-integration prevention);
- race losers never block unrelated ready work (no starvation);
- cancellation predicate matches the admission predicate (`accessConflicts`);
- end-to-end swarm: both hypotheses served concurrently, winner integrates
  (verified in git), loser never integrates, user checkout untouched.

Full foundry suite after the change: 921/921 PASS (914 baseline + 7 new).

## When NOT to race (design guard)

When a diagnostic first pass can identify the root cause cheaply (the
winner-first case), racing wastes CPU (4600 vs 920 ms) for zero wall gain.
The mode is opt-in per recipe: race only after a bounded diagnostic phase
fails to identify the cause (e.g. one failed fix attempt or an explicit
hypothesis-set task), not as the default execution mode.
