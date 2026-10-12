# Bounded tool batches

Foundry/Swarm groups compatible **adjacent** calls within one assistant turn.
The model still proposes calls. The host admits each call, charges the original
tool budget, owns receipts, and independently verifies the final patch.

| Calls | Default local worktree behavior | Boundary |
|---|---|---|
| `read_file`, `list_files` | Up to four concurrent reads; identical name/arguments share one execution within the unchanged read batch | Every call retains its own result ID, owned receipt and budget charge |
| `write_file`, `edit_file`, `delete_file` | Execute in caller order, then produce one canonical scoped snapshot for the group | Results and patch publish together in one durable thread checkpoint |
| `run_job` | Up to eight concurrent control RPCs within an adjacent job group | Template concurrency, stable remote identity, reconciliation and objective ceilings still apply |
| Checks, spawning, claims, findings, progress and recall | Execute as individual boundaries | Later calls cannot move ahead of these effects |

For example, `read A, read B, write A, edit A, check, job X, job Y` has a read
group, an ordered write group, an explicit check boundary, then a job group.
The remote jobs cannot start before the preceding writes and check. Independent
experiments should be proposed together; dependent experiments require the
preceding result before the model chooses their inputs.

## Recovery and backend contract

Before execution, the host persists the batch's charged call IDs and intents.
If a write group is cancelled, crashes, or encounters a fatal interruption,
its unpublished private workspace is discarded. Restart restores the preceding
durable patch and replays outstanding calls in order, without charging them
again. Ordinary tool errors remain per-call results; partial edits are included
in the group's scope-checked snapshot. Every final check still runs in a newly
reconstructed independent worktree.

Local worktree initialization is shared by concurrent first readers. They wait
for dependency patches and the saved patch to finish applying before reading.
All launched operations drain before the workspace is disposed, including on
host callback failure. Individual tool activity remains visible, and batch
events record execution count, elapsed time, receipt IDs and the patch hash.
Batch elapsed time includes admission/checkpoint overhead. Nested tool timings
still represent worker time and can overlap.

`Hands.batchPolicy` is an optional **host implementation capability**:
`{ reads: 4, writes: true }`. A backend advertising reads must make concurrent
file/list operations safe on a stable workspace. A backend advertising writes
must reconstruct the preceding durable snapshot and replay an interrupted group
without leaking external effects. Missing capabilities retain serial I/O and
one snapshot per edit. The fleet's optional `Hands.batch` transaction replays
the entire admitted group, including its snapshot, when switching workers.
Remote host groups are bounded to 32 calls. See
[remote batch recovery](REMOTE_TOOL_BATCHING.md).
No model flag can enable these capabilities.

There is no cross-turn read cache: a later read must observe intervening edits.
Replay revalidates current scope/capability admission. Legacy remote pending IDs
survive intervening read/write boundaries until their results are committed.
Budget exhaustion rejects a fresh oversized group before any effect.

## Measurement

Run the same checked workload against two source snapshots:

```sh
node --experimental-strip-types scripts/bench-tool-batching.mjs --runtime-root /path/to/baseline --repetitions 10
node --experimental-strip-types scripts/bench-tool-batching.mjs --repetitions 10
```

The script uses real Git worktrees and independent scope/behavior checks.
Provider replies are scripted; the read workload injects an explicit 40 ms
service delay. It records source hashes, raw end-to-end samples, original call
IDs, snapshots, actual read executions and two mock provider requests per task.
Use baseline/candidate/candidate/baseline order and compare the short task too.
These are host workload measurements; live research completion time, token
cost and verified objective yield require a separate live-provider comparison.

Scope: Foundry/Swarm and its command entrypoint. The terminal query and `/goal`
runtime have their own tool execution paths.
