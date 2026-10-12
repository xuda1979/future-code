# Durable diagnostic memory and early trajectory pruning

Long external-model R&D sessions can retire a failed compiler/test exchange and
then repeat it without changing the source. Swarm now preserves bounded **host
observations**, alongside the existing optional agent-authored progress note.
The change is domain-neutral: named checks, scoped Git patches, owned receipts
and the existing objective supervisor are the only project interfaces.

## Three memory tiers

| Tier | Contents | Bound and lifetime |
|---|---|---|
| Provider context | Latest failure descriptors, excerpt, fixture/result receipts, source hash and whether the recorded input is current | At most four descriptors; included in the single retirement notice only when history is retired |
| Thread checkpoint | Host-measured failure identities and unchanged-input repeat counts | At most eight descriptors in the existing lease-fenced session store; survives process restart |
| Cold evidence | Exact invocation, before/after patch receipts and observed result | Immutable thread-owned regression-fixture receipts in the existing artifact store |

Private tool batches retain the complete attempted call sequence and admission
flags in a `batchCallsReceipt`. Their source snapshots describe the **batch
boundary**, not an invented per-call snapshot. Identical observations reuse the
same fixture. New failures are saved in the same thread checkpoint as their
result/patch; a crash may leave an unused receipt but cannot publish a phantom
result. Independent verifier feedback also produces host failure descriptors.

Fixtures are `OBSERVATION_NOT_ACCEPTANCE`. They are reproducible inputs for
diagnosis and future test proposals, not executable generated tests, assertions
of the desired behavior, or additional acceptance authority. A worker can expand
its owned fixture with the existing `recall` tool; the referenced invocation,
patches and result are also owned receipts. No cross-task recall is granted.

Retirement keeps immutable task/dependency contracts and complete tool pairs.
Under a tight encoded UTF-8 budget it first removes the agent note, then reduces
host diagnostics to the latest descriptor, then falls back to the journal
pointer. It never adds context budget. Repeated retirement replaces the notice
and preserves its memory even when removing the previous notice makes the
remaining messages fit. Stale failure descriptors explicitly report
`current: false`; their excerpts cannot establish a current failure or PASS.

## Optional early exit

An operator may enable a limit **per deterministic named check**. Example
configuration fragment:

```json
{
  "checks": {
    "typecheck": {
      "argv": ["node", "scripts/typecheck.mjs"],
      "replaySafe": true,
      "maxUnchangedFailures": 3
    }
  }
}
```

The limit is pinned with the configuration and must be an integer from 2 to 16.
Its presence is an operator assertion that the check is deterministic on the
pinned source and completed job/verifier evidence. `replaySafe` alone does not
imply determinism. Omit the limit for network probes, time-dependent tests,
flaky experiments and unobserved external inputs.

Pruning requires the same admitted check invocation, exact nonzero result,
canonical source patch, verifier feedback, completed-job and verified-child receipts. A check
that changes the patch is ineligible. Changed source/evidence, changed output,
unknown outcomes and success reset the relevant repeat count. Ordinary tool
errors and timeouts are remembered but cannot trigger this check policy.

The driver finishes all remaining calls in the complete tool turn, including
queued repairs, before evaluating the limit. Both explicit checks and automatic
early-feedback checkpoints contribute observations. Before another model
reservation, the host saves one `trajectory.pruned` event and ends the failed
trajectory with `STAGNANT_DIAGNOSTIC`, preserving its fixture and work.
Reopening that trajectory makes no further provider request.

This is a **failed task trajectory**, not completed work. The objective supervisor
can propose a materially different plan through its existing recovery boundary.
The reflection reports `stagnant_diagnostic_pruned`; recovery receives a bounded
same-objective diagnostic digest (one descriptor per failed task, at most 8 KiB
in aggregate) alongside existing intervention memory/policy. Replacement workers
do not inherit private receipt access. Without a safe recovery plan, normal
objective attention/budget behavior applies. Full independent per-task and
combined-tree integration acceptance remain mandatory.

Successful short tasks add no model call, diagnostic check, fixture or new
database. The successful-tool path returns before diagnostic hashing when no
failure memory exists. Pruning is disabled unless the operator sets the limit.

## Evaluation of the proposed architecture areas

| Proposal | Assessment and implementation boundary |
|---|---|
| Parallel speculative AST trajectories | Existing child tasks already use independent worktrees. Overlapping speculative write authority, winner selection and automatic AST merging need a separate scheduler/effect contract; this change adds early pruning without inventing that authority. |
| Early checkpoint pruning | Implemented for repeated identical deterministic failures at a complete tool boundary. It does not interrupt a pending check or model stream. |
| Token-level grammar-constrained decoding | External APIs own decoding. Existing finite-schema admission remains mandatory; provider-specific constrained decoding needs an explicit supported API capability. |
| Pipelined compiler diagnostics | Completed named-check diagnostics feed durable memory, retirement and recovery. Incremental diagnostic streaming before a complete patch needs an independently versioned bridge/cancellation protocol. |
| Dependency-aware semantic retirement | Pinned contracts and affected failure inputs/receipts are retained. General transitive AST/call-site retention is deferred; dynamic imports, generated inputs and external effects cannot be inferred soundly from syntax alone. |
| Hierarchical session memory | Uses the existing persistent session/artifact store and existing progress/intervention mechanisms, adding host observations and bounded recovery projection. No second scheduler or unbounded transcript copy. |
| Failure-to-fixture synthesis | Observed tool/check/verifier failures produce exact receipt-based regression inputs, including ordered batch context. Automatic executable test generation cannot infer the correct behavior from an exception alone and is not enabled. |
| Dynamic reasoning budgets | Existing admitted task/context and objective budgets stay authoritative. No provider reasoning budget is changed using an unvalidated diff-complexity score. |

## Verification

`tests/foundry/diagnostic-memory.test.ts` covers operator-policy admission, receipt
ownership, journal reopen, bounded UTF-8 memory, staleness, source/evidence/output
changes, unknown outcomes, successful repair, tool-batch fixtures, automatic
checkpoints, objective replanning, encoded provider context, and a lost
`model.reply` checkpoint with exact durable replay.

The scripted unchanged-failure test compares a 20-turn loop with the same loop
and a limit of 2: **20 -> 2 model requests and 20 -> 2 check executions**, with
both unchanged candidates rejected. This is an offline regression fixture,
not evidence of a 10x live-model or end-to-end R&D productivity gain. A separate
test reaches accepted objective completion through a changed recovery plan.
Use the [paired real-project protocol](REAL_PROJECT_EVALUATION.md) to measure
verified time-to-goal, cost and quality on actual R&D work.

```sh
node --experimental-strip-types --test tests/foundry/diagnostic-memory.test.ts
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```
