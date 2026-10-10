# Remote file batches and recovery

The worker fleet batches adjacent file operations within an assistant turn.
The coordinator admits and charges every original call, preserves caller result
order and owned receipts, and independently verifies the resulting patch.
Identical admitted reads share execution only within an unchanged read group.
Checks, jobs, delegation, claims and progress remain separate effect boundaries.

## Protocol and compatibility

The supplied Python worker advertises `result.capabilities.workspaceBatch: 1`
in a successful schema-1 `prepare` reply. The host then sends schema-1 `batch`
requests containing `workspace`, `kind` (`read` or `workspace-write`) and `calls`.
A reply contains `result.results` as ordered `{callId, result}` rows; write
replies also contain the exact scoped `patch` text. Reads use at most four
threads. Writes execute in order and snapshot once per RPC, including ordinary
per-call errors. Mixed effects and batches above 32 calls are rejected before
execution. Workspace operations hold an exclusive file lock; concurrency is
confined to the batch's read-only operations.
For a single file edit, the new protocol also combines execution and snapshot
in one RPC; the host retains the same admission, budget and acceptance boundary.

Each host group contains at most 32 calls. RPC chunks also account for the
configured `maxRpcBytes`, per-tool output ceiling and JSON escaping. Chunking
does not create separate thread checkpoints: a failed later chunk replays the
entire host group. The adapter's aggregate reply byte ceiling remains enforced.

An old worker omitting this capability receives the existing `tool` and
`snapshot` operations serially. The host still commits one result/patch pair per
write group and replays all its edits together on failover. There is no model
flag or additional model request for batching. Worker code, adapter and trusted
templates remain pinned operator configuration.

## Recovery boundary

The thread journal records charged IDs and admitted intents before execution.
The remote backend retains the preceding durable patch throughout the group.
If preparation, any batch/chunk RPC or its snapshot fails, the host excludes
that worker for this attempt, releases its capacity lease and selects a remaining
healthy worker. It reconstructs the pinned base, accepted dependency patches
and the **patch text** resolved from the saved artifact hash, then replays every
admitted call in order. A failed worker is excluded for the rest of that task
attempt; later attempts still obey the recipe's retry limits and durable worker
health.

Every replacement uses a fresh workspace generation, including a coordinator
restart under the same fence. It cannot inherit unpublished mutations or race
late operations in the abandoned tree. Disposal drains host operations and only
releases the workspace lease it owns. Failed remote trees may remain for operator
inspection/cleanup; cancellation never proves a remote process has terminated.

No partial tool results escape a failed write group. After all operations and
the final snapshot succeed, receipts and patch hash publish together in the
normal thread checkpoint. Cancellation, exhaustion of the fleet or deferred
capacity leave the pending IDs and previous patch intact. Resume revalidates
admission and does not charge those calls again. Cancellation does not mark a
worker unhealthy. A standalone mutating tool still resumes its pending call if
its subsequent snapshot reply is lost.

These replay rules apply only to scoped private file tools. External jobs retain
their own stable identity and reconciliation protocol. The coordinator always
reconstructs an independent local worktree and reruns every pinned acceptance
check; worker success and diagnostic checks cannot certify PASS.

## Measurement

The shared benchmark can exercise real worker adapters against two source roots:

```sh
node --experimental-strip-types scripts/bench-tool-batching.mjs --backend remote --runtime-root /path/to/baseline --repetitions 5 --rpc-delay-ms 40
node --experimental-strip-types scripts/bench-tool-batching.mjs --backend remote --repetitions 5 --rpc-delay-ms 40
```

Use baseline/candidate/candidate/baseline order, retain the short task and repeat
with `--rpc-delay-ms 0` to separate adapter/process overhead from the explicitly
simulated transport latency. Git worktrees, Python worker operations, durable
journals and independent scope/behavior checks are real. Provider replies are
scripted, with two mock requests per task and no live LLM calls. The report
includes raw samples, source hashes, RPC counts, read executions and snapshots.
Live R&D yield, tokens and dollar cost still require the
[paired real-project evaluation](REAL_PROJECT_EVALUATION.md).

[Recorded final evidence](validation/remote-tool-batching-20261010.json) compares
main `476e198` with this implementation in ABBA order. Each arm has ten samples
per case at 40 ms simulated RPC delay and six at 0 ms. All 96 final trials
passed independent verification and used two scripted provider requests.

| Simulated RPC delay | Workload | Baseline p50 | Candidate p50 | Total RPCs |
|---|---|---|---|---|
| 40 ms | One file write | 602 ms | 478 ms | 4 → 3 |
| 40 ms | Twelve ordered file writes | 3,156 ms | 505 ms | 26 → 3 |
| 40 ms | Eight file reads plus two repeats and a write | 1,674 ms | 623 ms | 14 → 4 |
| 0 ms | One file write | 428 ms | 330 ms | 4 → 3 |
| 0 ms | Twelve ordered file writes | 2,042 ms | 358 ms | 26 → 3 |
| 0 ms | Eight file reads plus two repeats and a write | 1,161 ms | 405 ms | 14 → 4 |

RPC totals include prepare and dispose. The twelve-write case reduces snapshots
from twelve to one; the read case reduces executions from ten to eight. This
includes process startup, journals and independent verification, rather than
only worker service time. The workers run locally through the real adapter;
40 ms is injected per RPC and is not a measured network RTT.

[Preliminary samples](validation/remote-tool-batching-preliminary-20261010.json)
are retained with their original source hashes. The initial bulk-only design
regressed short-task timing. The final design also coalesces a single edit and
its snapshot; no preliminary samples are silently excluded from the record.
