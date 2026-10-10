# Execution productivity and recovery

Foundry/Swarm now closes six runtime gaps behind sustained R&D productivity.
The changes use external model APIs and general task/job contracts; they add no
project-specific training, hardware or acceptance logic.

The subsequent [tool batching](TOOL_BATCHING.md) change bounds parallel reads,
coalesces ordered private edits into one replayable snapshot, and preserves
effect boundaries before remote job batches.
The [remote batch recovery](REMOTE_TOOL_BATCHING.md) follow-up extends that
contract to worker fleets, reduces file-operation RPCs, and restores actual
durable patch contents when replacing a worker.

| Direction | Runtime change | Observable result |
|---|---|---|
| Autonomous continuation | Commit-driven notifications, generation checks before waiting, cross-process SQLite `data_version` checks | A newly eligible task or reconciled objective interrupts idle supervision |
| Measurement | Monotonic prepare/execute/verify timings and nested tool/RPC time, provider admission and reply timestamps | Status and reflection identify measured time consumption with coverage counts |
| Context | Exact UTF-8 preview envelopes and a fallback that retires oversized tool previews to owned receipts | Large complete tool batches can fit without losing call/result pairs or full evidence |
| Scheduling/resources | Trigger-maintained request totals, indexed expiration/capacity queries, resource release notifications | Request admission cost does not grow with completed request history; idle workers refill promptly |
| Experiments/recovery | Bounded RPCs even for non-cooperating adapters; terminal reconciliation wakes capacity/result waiters | Unknown remote outcomes remain durable and retain ensure/inspect identity |
| Self-improvement | Actual provider input pressure and measured permit/tool/verifier bottlenecks feed the existing recovery/reflection policy | Strategy advice changes with host evidence; frozen acceptance remains independent |

## Operator behavior

Use `status`, `objective`, `reflection`, or the normal progress observer. Status
reports include accepted **root tasks**, measured/total attempts, phase worker
time, provider admission wait, task activity/progress/check ages and wait reasons.
An accepted child is implementation work, not additional objective throughput.
No model call is made for status, timing or polling.

Exploratory checkpoints default to **on-change** when `checkpointEveryMs` is
configured. Their input key includes the patch, exact verification feedback and
completed remote-job evidence. Set `checkpointCadence: "periodic"` to retain
periodic diagnostics for checks that depend on time or unobserved external state.
Every frozen acceptance and final integration check still runs. This does not
reuse a diagnostic as proof of acceptance.

If normal history retirement cannot fit the latest complete tool exchange,
Swarm shrinks host-owned tool previews to `receipt` references. The model can use
`recall(receipt, offset, length)` to retrieve the exact original output. Mandatory
task instructions, tool definitions and tool arguments must still fit the
admitted envelope; otherwise the task fails visibly with `CONTEXT_OVERFLOW`.
There is no implicit context or budget increase.

Remote RPC deadlines bound the **control request**, not the experiment lifetime.
A timed-out or disconnected request never proves remote termination and never
refunds request budget. Known job IDs use inspect only; ensure retains its stable
deduplication key. Reconciliation wakes the owning continuation and capacity
waiters. Capacity is rechecked transactionally when saving a continuation, so
a release immediately before persistence is not lost.

## Accounting and measurements

`agent_requests` remains the request ledger. `agent_request_totals` is a
rebuildable projection maintained in the same transaction by insert/update/delete
triggers. It includes unknown outcomes, late replies, fallback/control-plane
requests and every objective revision exactly once. An existing ledger with a
missing run-total row blocks admission. A host maintenance program can call
`rebuildRequestAccounting(store)` to reconstruct totals without resetting spend.
The initial upgrade rebuild happens once and can take time on a large database.

Phase sums measure **worker time**, not critical-path wall time. Tools are nested
in execution; remote RPCs are nested in tool time. Parallel operations overlap,
so these numbers must not be added together. Timings cover finished local
episodes. Crashed/unmeasured attempts, unadmitted permit waits and outstanding
provider requests do not acquire fabricated durations. The report exposes
measurement coverage; unknown token/dollar consumption remains unknown.

The host writes one timing record per local attempt and adds no analysis-model
call, speculative route, worker or job to a short task. Reflection remains at
the existing objective recovery/completion boundaries. Commit notifications are
coalesced per transaction. Across processes, idle waits check SQLite's generation
at most every 250 ms instead of rescanning the DAG on each poll.

These changes govern the Foundry and `/swarm` entrypoints. The older terminal
query/`/goal` execution path has its own continuation and context mechanisms;
this change does not turn that path into the Swarm scheduler.

## Reproduce the evidence

```sh
node --experimental-strip-types --test tests/foundry/execution-loop.test.ts tests/foundry/context-envelope.test.ts
node --experimental-strip-types scripts/bench-request-accounting.mjs
node --experimental-strip-types scripts/bench-foundry-productivity.mjs --tasks 1 --repetitions 10 --overhead-only
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```

[Recorded offline evidence](validation/execution-productivity-20261010.json)
contains raw samples, source hashes and the previous main commit used for the
short-task comparison. The SQL experiment compares the former aggregate query
with the new indexed total lookup at 100, 10,000 and 100,000 request rows.
The short-task experiment uses independently checked arithmetic, SQLite and
artifact I/O; it has no live model calls. These are runtime measurements, not
evidence of a productivity multiple over Claude Code, Codex, or live R&D work.
Use the [paired real-project protocol](REAL_PROJECT_EVALUATION.md) for that claim.
