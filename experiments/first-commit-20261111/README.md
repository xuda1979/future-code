# Runtime improvements measured against the first commit

[中文测试报告](REPORT.zh.md) · [评测方法与结论范围](EVALUATION_METHOD.zh.md)

Compared unchanged production code from the actual first commit
`b1f9d186085562947adf682f4c7f65652886ecad` (2026-09-18) with the current-main
snapshot `ac3789210d0d58d30f1f9b141ca6d842297f7f94` (2026-11-10).

**Result: specific context-efficiency and fault-handling improvements are
demonstrated. Complete-agent productivity remains unmeasured.** These experiments
make zero live model calls. They do not establish a token-billing reduction,
HumanEval generation score, a universal speedup, or superiority over Claude.

## Measured results

| Frozen comparison | First commit | Current snapshot |
| --- | ---: | ---: |
| Architecture-review retained request JSON, actual Bash 30K per-tool cap | 121,713 bytes | 35,219 bytes |
| Small review control | 25,689 bytes | 25,689 bytes |
| Five injected-fault contracts, each repeated four times | 0/5 scenario contracts | 5/5 scenario contracts |
| Healthy and ordinary-error tool controls | 4/4 for each control | 4/4 for each control |
| HumanEval supplied canonical programs, healthy replay | 164 executions and 164 receipts | 164 executions and 164 receipts |
| Same programs, one framing exception after index 32 | 33 executions, 32 receipts, exit 1 | 164 executions, 164 receipts, exit 0; one explicit error receipt |

The corrected context reduction is **71.0639%**. Every persisted receipt is
byte-identical to its original, every inline result is retained, and repeat
application preserves the same request view. This proves evidence availability;
it does not demonstrate that an LLM retrieves omitted detail correctly.

The current batch-budget step adds local processing: median 2.741 ms versus
0.045 ms for this large-output workload. Small review processing is 0.922 ms
versus 0.027 ms. Healthy full HumanEval replay medians are 5.067 s and 5.209 s
respectively. These four short repetitions do not establish a general timing
advantage. Raw failure durations are not used as speedup denominators.

## What actually ran

The storage/enforcement code and `StreamingToolExecutor` are imported from the
two pinned checkouts. Production source is unchanged. Identical adapters replace
peripheral UI/analytics and the tool-generator boundary, preserving actual file
I/O, subprocess work, abort handling and executor state transitions. This is a
component comparison under Node, not a run of either complete Bun terminal CLI.

- Context inputs are real `git diff` outputs from 12 named core files, selected
  in a separate contract before comparing request views. One named file has no
  diff and provides an empty-output control. Both arms first apply Bash's actual
  declared 30,000-character per-tool persistence cap. No output lines are
  fabricated or duplicated. An additional 12 real regression-command outputs
  provide below-budget controls; all 12 commands pass.
- First-commit search, ordinary concurrency and optional output offloading are
  preserved. Its aggregate budget defaults off; the current default is on with
  a 32,000-character target. Enabling the old optional flag is also measured:
  121,703 bytes, effectively the same as its default for this post-persistence
  input. The 10-byte difference comes from saved-reference path lengths.
- Faults are deliberately injected before a tool result, after a real write,
  through an empty stream, during context updating, and in schema preflight.
  Acceptance requires paired results, correct error indication, verified
  follow-up content and correct external artifact contents. In the empty-stream
  case the first commit **does finish its follow-up**; it fails because the
  original call has no result receipt. Do not describe all five faults as stalls.
- HumanEval uses all 164 **provided canonical solutions and official tests**,
  with four healthy and four fault repetitions per arm. The exception is injected
  after the program at index 32 has passed its tests. This measures preservation
  of work and continued execution. It is not code generation, an autonomous
  repair trial, or HumanEval pass@1. An independent evaluator also executes and
  passes all 164 supplied canonical programs.
- No artificial sleeps, paid API calls, model answers, GPU work or human rescue
  are included. AB/BA/BA/AB ordering is used. The five deterministic fault types
  are mechanism coverage, not estimates of natural fault frequency. Repeats are
  not independent research tasks.

There are **114 formal execution arms**, plus **17 superseded pilot arms** kept
for audit. `protocol-corrections.json` records why the first 50K-cap context
trial is excluded. The original Node regression-output contract called its
output TAP; Node 24 actually selected its default spec reporter. Raw output is
unchanged. All those control outputs are below 30K, so the cap correction cannot
change their results. JSON byte size may exceed 32K because the target applies
to eligible result characters, not the full serialized request.

## Evidence and reproduction

`summary.json` contains the quantitative results. `evidence-20261111.zip`
contains raw requests, complete receipts, subprocess logs, source fingerprints,
frozen command outputs and the superseded pilot. Its SHA256 is in
`evidence-20261111.sha256`. Extract it in this directory before running
`analyze.py` or the evidence verifier.

The runtime used Node v24.22.1, Python 3.12.14, Linux x64 and an Intel Xeon
Platinum 8573C host. Four repetitions are descriptive. Billing tokens, dollars,
live task quality, human time and complete-agent throughput remain null/unknown.
The available CLI inference canary failed during initialization on a read-only
runtime directory, and no public inference key was available. Full legacy-CLI
build/provider compatibility was not certified.

To rerun with the same source snapshots after checking out this experiment PR:

```sh
git worktree add --detach ../future-code-first b1f9d186085562947adf682f4c7f65652886ecad
git worktree add --detach ../future-code-current ac3789210d0d58d30f1f9b141ca6d842297f7f94
mkdir -p ../future-code-current/experiments
cp -R experiments/first-commit-20261111 ../future-code-current/experiments/
cd ../future-code-current
python3 -m zipfile -e experiments/first-commit-20261111/evidence-20261111.zip experiments/first-commit-20261111
node --experimental-strip-types experiments/first-commit-20261111/run.mjs ../future-code-first
node experiments/first-commit-20261111/run-review-v2.mjs
python3 experiments/first-commit-20261111/analyze.py
python3 experiments/first-commit-20261111/verify_evidence.py
```

The worktree placement lets the runner authenticate the exact pinned candidate
HEAD while this PR adds only experiment files. Fresh timing, paths and command
output vary; original recorded timings need not reproduce exactly.

Focused production regressions:

```sh
node --experimental-strip-types --test tests/correctness/streaming-tool-executor.test.ts tests/correctness/tool-result-budget.test.ts
```

All 16 focused regressions pass. No Foundry/Swarm runtime is modified by this PR.

## Supported management statement

We completed reproducible first-commit comparisons of Future-Code's execution
components. On the frozen architecture-review workload, current code reduces
retained request JSON by 71.06% while preserving full evidence. It meets all
five tested failure-handling contracts, and completes a 164-program execution
replay after a single injected framing exception that terminates the first
commit's replay. Same-model autonomous R&D productivity remains a separate,
unmeasured endpoint.

## Sources

- [Actual first commit](https://github.com/xuda1979/future-code/commit/b1f9d186085562947adf682f4c7f65652886ecad)
- [Compared current snapshot](https://github.com/xuda1979/future-code/commit/ac3789210d0d58d30f1f9b141ca6d842297f7f94)
- [HumanEval upstream](https://github.com/openai/human-eval/tree/b9453e8f1865df0a0057a1383767caa400acfbcf)

HumanEval is a historical, unmaintained dataset used here only as an official-test
execution workload. `data/provenance.json` pins the upstream gzip hash and the
extracted dataset hash; its MIT license is included.
