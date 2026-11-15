# Tool collection latency and optional display work

This change removes two tool-collection defects and a blocking optional-summary
wait. It does not change model selection, thinking effort, permission checks,
tool authority, budgets, or independent acceptance.

## Reproduced defects

1. **An exclusive tool could freeze the event loop.** An unknown tool is given a
   completed error result immediately. If an earlier exclusive tool is still
   running, that result cannot yet be delivered. The collector nevertheless
   counted it as ready and repeatedly skipped its asynchronous wait. The loop
   then prevented tool completion, timers, and operator cancellation from running.
   Readiness now respects the same exclusive barrier as result delivery.
2. **Progress accumulated callbacks on unfinished siblings.** Each progress wake
   raced every running tool's completion promise again. Those promise observers
   remained attached until the slow sibling finished. The collector now uses its
   existing progress/completion notification; rejection also wakes the collector
   and remains a failure. Progress and actual receipts are preserved.
3. **Optional labels could block actual work.** With
   `FUTURE_CODE_EMIT_TOOL_USE_SUMMARIES=1`, the query awaited the previous batch's
   display-summary request after the next model response. A slow or hung label
   could delay tool collection, completion, and recovery. The query now takes a
   label only if it is ready, cancels late display work, and rejects late output.
   This setting remains **off by default**.

The display request has a separate cancellation signal and one slot per query.
If a provider ignores cancellation, that slot stays occupied until it settles;
ordinary work continues without launching more optional requests. Recovery
transitions retire labels they no longer own. Query return, throw, or generator
closure disposes the display task. These labels never establish tool success or
satisfy acceptance.

## Controlled comparison

Baseline: `d1a574b9369e49659ce4bb306e07d009bfde50af` (the current main when the
work began). Five samples per arm, alternating arm order, Node v24.22.1 on Linux.
The benchmark ran on CPUs 4–5 while regression groups used separate CPU sets.
The timed component excludes child-process startup and source loading.

| Component workload | Baseline | Candidate |
| --- | ---: | ---: |
| Healthy two-tool batch, median | 1.95 ms | 2.09 ms |
| Exclusive tool plus unknown-tool result | 5/5 timed out at 3 s | 5/5 finished; median 32.22 ms |
| Operator cancellation at the same barrier | 5/5 timed out at 3 s | 5/5 finished; median 32.34 ms |
| 500 progress updates plus an unfinished sibling: added completion observers | 502 | 0 |
| Same progress workload, median | 22.58 ms | 19.62 ms |
| One optional label with a simulated 250 ms service delay: consume time | 250.53 ms | 1.33 ms |
| Twelve optional labels with simulated 75 ms service delays: total consume time | 915.03 ms | 1.79 ms |

The blocking/cancellation fixtures use a 30 ms completion/cancellation trigger.
The baseline starves that trigger; it is terminated by the parent process's
3-second watchdog. The tools are deterministic test services executing through
the real `StreamingToolExecutor`, not real shell commands. The label probes run
the actual query consume block with a deterministic label service; they do not
run the full query pipeline.

Healthy short batches do not show a demonstrated speedup (the observed
difference is 0.14 ms). Small timing differences are noisy. The stronger results
are elimination of the reproduced freeze, prompt cancellation, and the bounded
completion-observer count. Actual result and progress hashes match across both
arms for healthy/progress cases. The expected unknown-tool and interruption
errors remain errors, and each admitted write executes only once.

These measurements use **zero live model requests**. They do not establish a
general percentage improvement in short-task latency, long-task productivity,
training speed, or provider response time. The optional-label gain applies only
when that feature is enabled. A genuinely slow provider response or experiment
still requires separate profiling.

[All samples and measured source hashes](validation/tool-collection-20261115.json)
and [validation record](validation/tool-collection-validation-20261115.json).

## Reproduce and verify

```sh
git worktree add --detach ../future-code-baseline d1a574b9369e49659ce4bb306e07d009bfde50af
node --experimental-strip-types scripts/bench-tool-collection.mjs \
  --baseline ../future-code-baseline --samples 5

node --experimental-strip-types --test \
  tests/correctness/streaming-tool-executor.test.ts \
  tests/correctness/opportunistic-task.test.ts
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```

The 21 focused tests include tool failures, missing receipts, concurrency and
exclusive ordering, context updates, cancellation, no replay of effects, fatal
diagnostic failures, optional-request failures, ignored abort, disposal, recovery
ownership, and the production query's generation/consumption gates. They are in
the standard offline correctness gate. The freeze cases run in a child process
because an in-process timeout cannot interrupt an event-loop busy loop.

All four changed runtime modules compile with Bun 1.4.4. A Bun smoke check also
confirmed disposal on normal return, throw, and asynchronous-generator closure;
each cancels optional work without aborting the parent. Compilation is also
registered in CI. A complete CLI binary build/install and deployment into
existing user sessions were not performed locally. Running binaries need a
rebuilt version and restart/resume to use the source changes. Rollback is a
revert; no state migration is introduced.
