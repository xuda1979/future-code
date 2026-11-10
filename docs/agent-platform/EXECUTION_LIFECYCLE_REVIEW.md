# Execution lifecycle review

This review follows the goal-continuity and compact-continuation changes. It focuses on runtime recovery and the optional self-improvement loop, using current source and deterministic reproductions rather than model-written correctness claims.

| Defect | Resulting behavior | Correction |
| --- | --- | --- |
| Streaming fallback flag remained set | Later fallback chunks repeatedly cleared messages and discarded tools | Consume each fallback event once; collect admitted tools before replacement work |
| Model fallback/error after tool admission replayed or abandoned the attempt | Existing effects could lose their real receipts or be repeated | Preserve calls, receipts and executor; collect outcomes before the next model request |
| Sanitized history did not rebuild the retry request view | The fallback still received stale signature blocks | Rebuild the actual request view, including the fresh objective anchor |
| Tool stream/context failure escaped through a detached promise | Unhandled rejection, missing results, apparent success or a stuck queue | Convert failures into paired error results, retain partial evidence, finish queue bookkeeping |
| Empty tool stream had no matching result | An admitted call silently disappeared | Emit an explicit failure; never invent success |
| Self-improvement used branch switching and forced branch reuse | Dirty foreground work could be incorporated into proposals or replaced | Managed checkout, unique proposal branches, private analysis/change worktrees |
| Build/tests used the proposer's workspace | Ignored exploratory state could contaminate evidence | Verify the committed candidate in a fresh worktree and reject source mutation |
| Candidate could change the checks that certified it | Build/test edits could weaken automatic promotion | Freeze baseline validation inputs; retain such proposals for independent review |
| Child exit/timeout/output errors looked like normal text or empty findings | Failed analysis or partial changes could appear successful | Separate stdout/stderr, enforce byte/deadline budgets, preserve exit status, drain POSIX process groups |
| Background read errors escaped the timer; crash markers survived forever | Optional maintenance could crash foreground work or stop recovering | Catch scheduler errors, reconcile only kernel-confirmed dead owners, record recovery as failure |

## Preserved execution contracts

Concurrent-safe reads still overlap. Exclusive writes remain ordering barriers, and context modifiers finish before the next exclusive tool starts. Bash failures retain sibling cancellation without turning a tool failure into cancellation of the root goal. A collected partial tool result remains visible, with a failure diagnostic explaining that effects may already exist and must be reconciled before retry.

Discarding an executor is now permitted only before tool admission. Cancellation, permissions, explicit caller limits, independent verification and final acceptance are not bypassed. No per-tool model classifier or additional model request was added.

## Self-improvement promotion

Self-improvement remains opt-in. The configured source repository is cloned into managed state rather than selected by the foreground project's directory layout. Read-only analysis and each proposed change use private worktrees. Failed or dirty work is retained for inspection; clean worktrees can be removed while committed proposal branches remain available.

Git failures are checked. A candidate cannot automatically certify edits to existing tests, validation scripts, dependency/build/CI configuration or other frozen verification inputs. New regression test files remain allowed. A fresh detached worktree rebuilds evidence from the committed candidate. Source changes during build or verification invalidate the result.

The trusted test lane runs the repository's five Node gates, rather than running the Node-specific suites through Bun. It stops at the first failed lane. Automatic promotion is limited to a clean managed main checkout still matching the admitted base, with a fast-forward to the exact verified commit. Automatic push remains separately opt-in and uses that commit explicitly.

The ledger is advisory history, not a transactional machine-wide quota scheduler. It tracks every open cycle, preserves live/unknown owners, and closes dead-owner markers as errors so recovery cannot bypass the interval forever. Worktree isolation and checked Git promotion protect checkout state across competing proposals. Private worktrees and process groups are not an OS security sandbox.

## Validation scope

Focused verification runs with:

```sh
node --experimental-strip-types --test tests/correctness/model-fallback-effects.test.ts tests/correctness/streaming-tool-executor.test.ts tests/correctness/self-improve-isolation.test.ts tests/correctness/self-improve-scheduler.test.ts tests/correctness/goal-context.test.ts
```

The executor tests load the production class and real abort propagation, with SDK/UI services and tool generators isolated. Query recovery tests execute the actual production recovery blocks with instrumented streams. Self-improvement tests use real temporary Git repositories, worktrees, subprocesses and candidate commits, with deterministic stand-ins for model output and validation programs. No paid model service, real remote repository push or production user checkout is used.

The regression evidence and all five required gates are recorded in [execution lifecycle validation](validation/execution-lifecycle-20261109.json). Suite totals overlap. These results establish tested recovery/isolation behavior, not live-provider throughput, intelligence, universal correctness or a complete packaged-CLI certification.
