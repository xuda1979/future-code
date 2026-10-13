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

When `unit` is the selected `checkpointCheck` (or the first permitted check by default), an automatic
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

## Evaluation before costly work

Supervised workers also evaluate after four model turns without the selected
check, when an enabled write-turn policy has a measurement due, or when completed external jobs, accepted children, or verifier feedback
provide new evidence. These triggers run at a complete tool boundary before the
next model request; they do not wait for `checkpointEveryMs`. They retain the
existing input deduplication and conservative path slicing. A current explicit
`run_check` can satisfy the selected evaluation, including a failing baseline.
An unrelated check or premise micro-probe does not reset its evaluation clock.
Failures remain diagnostics, never acceptance or proof that a goal is impossible.

Automatic evaluations and the [evidence-first decision policy](EVIDENCE_FIRST_DECISIONS.md)
share the task's measurement ledger. `checkpointCheck` may name an acceptance
check or a separately permitted `diagnostics` capability. With no explicit
selection, the first declared decision measurement is preferred, then the first
acceptance check. An overdue write review selects its own declared measurement
so an unrelated checkpoint cannot keep the worker blocked. Failed measurements
can reopen the repair path while successful job prerequisites remain distinct.
Diagnostic path slicing does not suppress a measurement due under the write
policy; its admission gate requires an actual observation.

Choose a cheap, decision-relevant check rather than an expensive full suite:

```json
{
  "agents": {
    "researcher": {
      "checks": ["full_regression"],
      "diagnostics": ["quick_evaluation"],
      "checkpointCheck": "quick_evaluation"
    }
  },
  "supervision": {
    "reportEveryMs": 30000,
    "checkpointEveryMs": 60000,
    "checkpointEveryTurns": 4,
    "checkpointAfterEvidence": true,
    "checkpointCadence": "on-change"
  },
  "jobs": {
    "expensive_experiment": {
      "preflightChecks": ["quick_evaluation"]
    }
  }
}
```

This is a configuration fragment: retain each profile's provider/tools, each
check's pinned command, each job's adapter/reconciliation limits, and all other
required specification fields. Every submitting profile must have `run_check`
authority for the listed `preflightChecks`. No job is classified as expensive
by its name or the model's opinion; the operator selects this gate per template.

Before a **new** `run_job` intent, the gate requires zero-exit, non-source-mutating
observations for every listed check, bound to the thread's exact source patch,
verifier feedback, completed job receipt, and child-result receipt. Missing,
failed, timed-out, unknown, or stale observations return `JOB_PREFLIGHT_REQUIRED`
before any adapter invocation or external intent. Agent summaries and saved
progress cannot satisfy this gate. Adjacent independent job calls are admitted
against one source/evidence boundary and can still launch concurrently. A later
dependent experiment needs re-evaluation after the earlier result. Existing
submitted identities always retain ensure/inspect reconciliation, even if check
evidence becomes unavailable; they are never replaced to bypass the gate.

The gate certifies only the predicates implemented by its pinned checks. It does
not automatically validate arbitrary `job.input`, a remote dataset, or a remote
checkpoint. Check commands and task dependencies must validate the relevant
artifact/input identities. If observations depend on changing unobserved external
state, use periodic checkpoints and choose the project's required freshness
policy rather than assuming source-only deduplication measures that state.

Submission uses the existing transactional `jobPreflight` gate and its owned
preflight receipt. It shares the exact observation used by automatic evaluations;
there is no second submission gate or independently writable evidence ledger.

Check observations persist with the corresponding result checkpoint and survive
restart. `checkpoint.checked` / `checkpoint.sliced` records include the check and
trigger reason (`measurement-due`, `turn-budget`, `new-evidence`, or `interval`). Actual checks use
the existing tool-call, deadline, output, diagnostic, and objective boundaries.
Unchanged inputs do not acquire repeated automatic measurements under the
default cadence. Short two-request tasks with no new evidence need no additional
check or provider request. Final independent checks always run.

Ordinary CLI task instructions, `/goal` creation/resume/continuation, Swarm
workers, and recovery planning now share the same decision discipline: identify
the uncertainty that can change the next action, obtain the cheapest applicable
measurement, diagnose/repair/re-evaluate, then scale costly work. When there is no
evaluable artifact, first build the smallest one. The CLI guidance is a model
instruction; the deterministic turn/evidence triggers and job gate govern
Foundry/Swarm, not arbitrary terminal shell commands.

These changes address delayed measurement, not a demonstrated general ability
to anticipate every important issue. `evaluation-cadence.test.ts` and
`job-preflight.test.ts` reproduce the old delayed-check behavior and cover input
staleness, failed baselines, independent final verification, batch submission,
checkpoint replay, and remote reconciliation. Live-model R&D gains require a
matched task/acceptance comparison; offline regressions cannot establish them.

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
