# Low-latency, conservative early feedback

## Design

The external-model Swarm runtime now starts preparing the pinned local task
worktree **concurrently** with a fresh model request. Previously, the first
file tool or final snapshot always waited for this preparation *after* the
model returned. The worktree is required in both cases, so prewarming does not
predict tool arguments, grant model authority, or speculate writes. Its
initialization remains idempotent on the same `LocalGitHands` instance.
The driver drains the model and prewarm promises before worktree cleanup even
if either fails. Remote-worker backends do not advertise prewarm and retain
the previous path. Replay of durable model replies does not issue another
provider call.

An optional, operator-pinned `diagnosticPaths` field on an existing named check
is a file/directory-prefix **impact declaration**, for example:

```json
{
  "supervision": { "reportEveryMs": 30000, "checkpointEveryMs": 60000,
    "checkpointCadence": "on-change" },
  "checks": {
    "unit": {
      "argv": ["node", "scripts/test-unit.mjs"],
      "replaySafe": true,
      "diagnosticPaths": ["src", "tests/unit"]
    }
  }
}
```

When `unit` is the first check permitted to a supervised agent, an automatic
exploratory checkpoint may be *omitted* if the authoritative Git path delta
relative to that task's accepted dependency tree contains only unrelated
paths. Paths come from NUL-delimited Git output, not diff header parsing or
model-generated assertions. Sliced checkpoints emit a durable
`checkpoint.sliced` event with the checkpoint input key and a path-set hash,
and do **not** consume a tool call or produce a fake success receipt.

Conservative fallbacks **run** the checkpoint: absent/invalid impact metadata,
unknown changed paths, empty delta, periodic cadence, prior verifier feedback,
remote job evidence, or a backend that cannot report authoritative changed
paths. Explicit model `run_check` calls, the complete independent per-task
acceptance suite, and the final combined-tree integration suite **always run**.
A failed check is never cached as success; tool/replay limits remain intact.
This is operator-maintained **path-level diagnostic slicing**, **not** AST
reachability, transitive soundness, or a substitute for full verification.

Completed checkpoint failures also feed [durable diagnostic memory and optional
early trajectory pruning](DURABLE_DIAGNOSTICS.md). A per-check
`maxUnchangedFailures` limit applies only to operator-declared deterministic
diagnostics; pending operations, unknown outcomes and mandatory acceptance
retain their existing contracts.

## Choosing impact paths

Only set `diagnosticPaths` when a project maintainer can bound its relevant
dependencies. Include shared libraries, build config, generated inputs, and
test infrastructure that can affect the check. For dynamic imports, global
configuration, external services, or uncertain edges, omit the field and
keep the full checkpoint. Directory prefixes are anchored (a prefix `src`
matches `src/a.ts` but not `src2/a.ts`). New files and deletions are
included in Git's canonical task delta. Paths are checked and pinned before
work starts. Other workers and project check scripts are unchanged.

## Verification and expected impact

`tests/foundry/early-feedback.test.ts` covers invalid path declarations,
conservative slicing and all no-skip conditions, real Git inventory,
independent acceptance after a candidate whose exploratory check could be
sliced, and model/worktree overlap. The existing correctness, resilience,
Foundry, Swarm, and command suites remain the regression gate.

The expected benefit is lower **time to first useful tool** on cold local
worktrees, and fewer irrelevant recurring diagnostic checks when operators
provide reliable impact paths. This PR does **not** claim an observed speedup
on live R&D projects. Measure requests, worktree-preparation latency, skipped
vs executed checks, verification failures, and verified time-to-goal against
the same frozen acceptance suite before enabling these optimizations broadly.

## Other proposals

Model responses are currently non-streaming, so prefetching partially streamed
tool arguments requires a separate protocol/parser and cancellation contract.
Tasks already have durable child delegation, independent worktrees and remote
job continuations; racing overlapping speculative write branches and automatic
AST three-way merges require correctness/reconciliation tests before admission.
The UI-side LSP subsystem exists but is not a pinned cross-worktree language
daemon. A general AST call graph is incomplete for reflection, generated code,
build flags and external effects, so it must not silently remove mandatory tests.
Acceptance criteria remain authored by the task owner and verified by pinned
host checks; an LLM-synthesized assertion cannot enlarge or weaken that
immutable contract.
