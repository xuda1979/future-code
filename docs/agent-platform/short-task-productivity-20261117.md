# Short-task productivity investigation — 2026-11-17

Small requests exposed two host-level stalls in current main
`ccd9aabaf060893359599f82417f457d8cb87ed7`. Neither requires a slow model to
reproduce: unused IDE feedback can block a read-only turn, and a shell command
can become backgrounded without waking the foreground agent. This patch removes
those waits and resolves conflicting instructions that encouraged task-list
overhead on simple work.

## Findings and changes

| Trigger | Previous behavior | Change |
| --- | --- | --- |
| Read a file, inspect Git status, or check a diff with a connected IDE and no edited-file baseline | `getNewDiagnostics()` queried the IDE, then discarded every result. Attachments awaited that request. | Return immediately when there is no baseline. No information is lost because the existing filter could not emit a diagnostic. |
| IDE stops responding while an edit captures its baseline or a turn collects diagnostics | Advisory RPC inherited the ordinary MCP tool timeout of 100,000,000 ms (about 27.8 hours), with a signal unrelated to the caller. | A one-second advisory deadline, caller cancellation, and a matching inner MCP timeout bound both foreground waiting and orphan timer lifetime. Actual MCP tools keep their existing timeout. |
| A reset, disconnect, or new query occurs during an IDE request | A late response could populate stale tracking state; the initialized service retained an old IDE connection. | Invalidate outstanding requests on reset/shutdown, discard late results, and refresh the connected client at query start. |
| A registered shell command moves to the background while output polling is unavailable | The existing-task branch changed state without resolving the foreground wait. Manual backgrounding likewise depended on an output callback. | Publish successful background transitions from `ShellCommand`; wake the Bash collector directly, including transitions received between waits. |
| Bash receives the existing `interrupt` signal | The process deliberately stayed alive, but the Bash collector did not transfer it into a background task. | Transfer the same execution through the existing task-registration path once; preserve partial output. When backgrounding is disabled, kill and collect the actual interrupted result. |
| Simple read/edit/check workflow | Main instructions encouraged task-list management generally, while the todo description counted three operations as complex. | Treat a routine read/edit/verify sequence as one small task. Plan for substantive dependencies or an explicit user request. |

The Bash change does not change the UI's decision about which tools can be
interrupted. It handles an `interrupt` signal when that signal reaches this
collector. It does not claim that every incoming message preempts every command.

## Measured results

Five samples per arm, alternating baseline/candidate order, Node 24.22.1 on
Linux x64. Baseline and candidate use identical fixtures and assertions.
The local Git/read/edit operations are real; the IDE transport is controlled.
Raw samples, source hashes and fixture hashes are in
[short-task-latency-20261117.json](validation/short-task-latency-20261117.json).

| Workload | Baseline median | Candidate median | Interpretation |
| --- | ---: | ---: | --- |
| Git status → read settings → diff check, with advisory collection after each operation | 177.7 ms | 18.6 ms | 9.55× for this host path; unnecessary IDE requests fell from 3 to 0. The fixture answers each IDE request after 50 ms. |
| Edit settings and collect a new IDE error | 112.0 ms | 117.7 ms | Same two requests and same diagnostic; no demonstrated speedup. |
| Capture edit baseline from an unresponsive IDE | Still waiting at the 1,500 ms observation limit, 5/5 runs | Released at 1,004.7 ms, 5/5 runs | Advisory timeout, not successful verification or completed-task speedup. |

Separate Bash lifecycle probes use the actual production generator and scripted
process/UI dependencies, with output polling withheld. In all three scenarios
(timeout handoff, manual backgrounding, interrupt), the baseline stayed blocked
through the 250 ms observation window in 5/5 runs. The candidate released the
foreground in 5/5 runs, with median event handling below 1 ms. Each run executed
and registered the command exactly once. These measure handoff responsiveness,
not shell execution time. See
[shell-handoff-20261117.json](validation/shell-handoff-20261117.json).

No human completion times or live-provider agent scores were measured. The
9.55× figure must not be presented as an overall Future-Code productivity gain,
or as a comparison against Codex or a human. Model reasoning, provider latency,
prompt effects, full CLI startup and real IDE integration still need live trials.

## Lessons applied from Codex and OpenAI guidance

The [Codex prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)
recommends direct execution for straightforward tasks and batching independent
reads. Future-Code already supports parallel tools; this patch fixes the
contradictory planning instructions rather than introducing another planner.
Prompt effectiveness itself remains unmeasured here.

OpenAI's [latency guide](https://developers.openai.com/api/docs/guides/latency-optimization)
recommends measuring the whole request path and removing unnecessary sequential
requests. That led to examining awaited IDE feedback and background handoffs,
not only the model stream. Stable prefixes, bounded context and concurrency
already have dedicated implementations and tests in this repository; this patch
does not replace them or lower model reasoning globally.

## Verification and tradeoffs

29 new focused tests exercise production control flow: eight diagnostic service
cases, three inner MCP cases, and eighteen Bash/ShellCommand cases. They cover
healthy feedback, failure/timeout preservation of baselines, cancellation,
stale-result rejection, connection replacement, exactly-once task transfer,
output/exit-code preservation, failed registration, and listener/timer cleanup.
Node fixtures isolate SDK/IDE/UI/process dependencies; they do not claim to be a
compiled Bun application test. Direct `ShellCommand` tests complement the Bash
generator fixture, so the event producer is also executed.

Slow IDE feedback may be unavailable after one second. A timed-out baseline is
not stored as a clean baseline; a failed post-edit read leaves the previous
baseline intact so a later healthy read can report new errors. Repository tests,
permissions, stale-file checks, independent acceptance and verification remain
in force. No tool execution is retried by these changes.

The first concurrent full correctness run hit an existing subprocess test's
400 ms startup deadline before its child-created marker appeared. The unchanged
test passed in isolation. Final gate results, including the serial rerun and
environment-dependent skips, are recorded in
[short-task-validation-20261117.json](validation/short-task-validation-20261117.json).

## Reproduce

```sh
git worktree add --detach ../future-code-baseline ccd9aabaf060893359599f82417f457d8cb87ed7
node --experimental-strip-types scripts/bench-short-task-latency.mjs ../future-code-baseline 5
node --experimental-strip-types scripts/bench-shell-handoff.mjs ../future-code-baseline 5
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```

For live productivity validation, use the existing
`scripts/compare-agent-productivity.mjs` harness with pinned baseline/candidate
binaries, the same provider/model/effort, fresh workspaces, independent checks,
and repeated paired trials. Include a known-file edit, a narrow bug fix, a config
change and local Git delivery. Record time to first useful tool, verified
completion time, request count, tokens, failures and manual interventions.
Collect human timings separately on the same task definitions; do not invent
human estimates or substitute component timings for those measurements.
