# Session memory management

Long sessions can retain unnecessary local data even when model context is bounded.
This change addresses two measured retention paths without changing model prompts,
active agent concurrency, transcript content, or acceptance rules.

## Runtime changes

- **File-content cache:** keep at most 1,000 entries and a 16 MiB conservative
  charge for content, path strings, and entry bookkeeping. Hits refresh LRU order.
  Oversized files return their complete contents without entering the cache or
  ejecting useful small entries. Evicted files are read normally when needed again.
  Size, timestamps, and file identity invalidate stale data; deletion and read
  failures release the old entry. `fileReadCache.getStats()` reports the charge and
  limit. The charge is a retention budget, not measured process RAM.
- **Pipe output progress:** retain 100 recent lines instead of 1,000. Every
  existing progress consumer reads at most 100, and the stdout fallback reads five.
  The same previews remain available. Spilled output remains complete on disk;
  clearing the progress state does not delete the receipt.
- **File output polling:** allow one pending tail read per task. Previously each
  one-second timer tick started another read, even if previous I/O was still
  pending. A slow task no longer accumulates pending callbacks, and other tasks
  continue polling. Unmounted progress ignores late reads; failed reads can retry.

Normal Bash stdout/stderr already go directly to a file descriptor. These pipe
progress savings apply primarily to hooks and other pipe-mode callers, rather
than every Bash command. File-mode inline bounds and receipt paths are unchanged.

## Reproduction and measured results

Baseline: `65828352faa40ca5736d0552e7c0ff71d2894622`, the main-branch revision before
this change. Run under Node >=22.13 on Linux/macOS:

```sh
node scripts/bench-session-memory.mjs \
  --baseline-ref 65828352faa40ca5736d0552e7c0ff71d2894622 \
  --samples 5 --output session-memory.json
```

The benchmark runs the actual source modules in fresh processes, alternates
revision order, uses real files and a deterministic pipe fixture, and compares
output hashes. Only unrelated configuration, logging, and encoding boundaries are
isolated. Explicit GC is used inside measurement workers only. It is not added to
the runtime. Timings below are medians of five samples on Node v24.22.1/Linux x64.

| Scenario / measurement | Baseline | Candidate |
| --- | ---: | ---: |
| 96 distinct 1 MiB files: retained heap increase | 96.08 MiB | 7.07 MiB |
| Files retained after that scan | 96 | 7 |
| Pipe stream of 4,000 distinct ~3 KiB lines: retained heap increase | 3.03 MiB | 0.42 MiB |
| Complete pipe receipt size | 12,058,890 bytes | 12,058,890 bytes |
| File-content reads during those hot hits | 0 | 0 |

The synthetic cases show **92.64% less file-cache retained heap** and **86.07% less
pipe-output retained heap**. All file and pipe output hashes match. The initial
five-run pass gave the same cache reduction and an 86.06% pipe reduction.

Timing observations were noisy, including a change in the direction of the
cached-hit difference. Both passes are retained to avoid selecting a favorable
timing result:

| Timing observation (median of five) | Baseline | Candidate |
| --- | ---: | ---: |
| Initial pass: file scan including hash checks | 359.36 ms | 330.14 ms |
| Final pass: file scan including hash checks | 698.53 ms | 490.37 ms |
| Initial pass: 20,000 cached reads of four hot files | 46.66 ms | 54.01 ms |
| Final pass: 20,000 cached reads of four hot files | 78.43 ms | 39.87 ms |

The initial hot-hit difference was about +0.37 microseconds per operation. Both
passes performed zero additional file-content reads on those hits. Byte-based
eviction can cause extra reads when a working set exceeds the budget. These
microbenchmarks do not establish either a speedup or universally unchanged latency.

Raw samples, source hashes, fixture hashes, hardware, and the measurement contract:
[session-memory-20261112.json](measurements/session-memory-20261112.json), with the
[initial pass](measurements/session-memory-20261112-initial.json) retained separately.
The final pass also authenticates the harness/loader sources and uses a conventional
median for even sample counts; production source hashes are identical in both passes.

These results measure isolated retained JavaScript heap, not total session RSS,
browser memory, child-process memory, end-to-end productivity, or model quality.
They do not identify the largest memory consumer in a user's running sessions.
To establish that, sample the live process tree over time and compare heap,
buffers/native memory, terminal/browser state, and child processes separately.

## Regression checks

```sh
node --experimental-strip-types --test \
  tests/correctness/file-read-cache.test.ts \
  tests/correctness/task-output-memory.test.ts
node scripts/test-correctness.mjs
```

The focused cases exercise complete reads, encodings/CRLF, LRU hits, oversized
files, replacement accounting, invalidation and read errors, unchanged progress
previews, full disk receipts, file-mode inline bounds, slow/failed polling,
independent task progress, and stop/clear cleanup. Both test files are included in
the standard correctness gate. No API credentials or model calls are needed.

Validation for this change: 12 focused cases passed, along with the standard
correctness gate (315 Node cases passed, one skipped; 36 Python cases passed, five
skipped) and all 225 command cases. Four resilience files were also rerun with
`--test-concurrency=1`: all 116 cases passed. The initial simultaneous broad runs
overloaded the environment and produced four resilience failures during deadline overruns; all
four passed in the controlled rerun. Full Foundry/Swarm runs were interrupted and
are not claimed as passed. A full Bun binary build and live-provider/session
profiling were not performed.

Existing sessions adopt these changes after running a build from the PR revision.
This PR does not restart or replace active sessions.
