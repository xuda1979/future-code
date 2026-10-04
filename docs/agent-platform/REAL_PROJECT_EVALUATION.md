# Real-project productivity evaluation

The evaluation runner executes real repository edits with independent task and
integration checks. It separates live external-API experiments from offline
response replay. Both paths retain machine-readable provenance and failed trials.

## Matched experiment

`scripts/evaluate-real-project.mjs` accepts baseline and candidate SwarmSpec files,
one frozen Task[] graph, an output root and repetition count. Only the operating
recipe may differ between specs; models, prompts, tools, budgets, verifier
commands, protection scopes and source input remain identical. Specify a commit
hash as `baseRef` and run against a committed, clean project.

```sh
node --experimental-strip-types scripts/evaluate-real-project.mjs \
  --baseline-spec BASELINE.json --candidate-spec CANDIDATE.json \
  --tasks TASKS.json --repetitions 3 --root .future-code/project-trials \
  --mode live --out .future-code/project-report.json --allow-exec
```

Every arm gets a fresh store and isolated task worktrees. Execution order alternates
baseline/candidate and candidate/baseline. Pinned source/check identities must
match across arms. The runner records intermediate trial reports so a process
interruption does not erase earlier observations. A fresh root is required for
a new experiment. It neither merges nor pushes the integrated branches.

The stock runner compares recipes on the current runtime. Comparing runtime
revisions additionally requires separate checkouts with the same manifest and
checks, and a predeclared cross-version analysis. No old-runtime speedup is
implied by a recipe comparison.

## Measurements

| Field | Meaning |
|---|---|
| `verifiedObjectives` | One only after all tasks and final integration pass |
| `verifiedTasks` | Verified tasks in the original frozen graph; spawned work adds no numerator |
| `wallClockMs` | Initialization, task execution, local verification and integration |
| `modelRequests` | Actual configured API requests in live mode; zero in replay |
| `replayedRequests` | Simulated request count, reported separately |
| `providerTokens` | Adapter-observed provider usage in live mode, or null |
| `unknownRequests` | Requests with missing provider token measurement |
| `costUsd` | Trusted host meter when available; null for missing live billing |
| `verifiedTasksPerModelRequest` | Null when there were no real requests |
| `verifiedTasksPerUsd` | Null without positive, complete dollar measurement |
| `artifactManifest`, `reportHash` | Accepted artifact/proof references and trial report integrity |

The current external-API adapter does not implement invoice-backed dollar
metering. Live dollar efficiency consequently remains unknown. Replay has no
paid calls and actual model cost zero; that zero cannot form a dollars-efficiency
ratio. Recorded/synthetic provider usage cannot establish live token efficiency.

A failed quality gate yields `QUALITY_GATE_FAILED`; no speedup is admitted from
faster incorrect work. Fewer than three live repetitions yield
`INSUFFICIENT_REPETITIONS`. Even `OBSERVED_TIME_GAIN` is an observation on one fixed
project, not a causal effect or a general comparison with Claude/Codex.

## Included real-source regression

The offline demonstration fixes an actual `inlineReceipt` input-validation defect
in Future-Code revision `aa7f326c0895cdf6782910d0e73645872d724d11`. A frozen independent
checker first proves that the unmodified input fails the regression. Six trials
then run the recorded edit through Swarm tools, pinned task checks and final
integration against the real repository source.

```sh
node --experimental-strip-types scripts/demo-real-project-evaluation.mjs \
  .future-code/real-project-demo
```

The pinned input commit must exist locally; fetch that history if using a
shallow checkout without it. An optional third argument selects another input
revision, which must still reproduce the frozen regression before trials start.

The result is explicitly `OFFLINE_BOUNDARY_ONLY`, with `observedSpeedup: null`
and `modelRequests: 0`. One task cannot benefit from extra workers; the example
verifies acceptance and instrumentation. Use independent, representative tasks
and an actual configured external model for a productivity comparison.

## Research protocol

Freeze acceptance and input revisions before examining outcomes. Include
regressions and expensive failed attempts. Report each repetition and missing
measurements. Expand from one project to held-out projects, remote experiments
and full objectives before making general productivity claims. Recovery plans
that change task granularity must be evaluated by frozen objective outcomes,
not by counting a larger number of easier subtasks.
