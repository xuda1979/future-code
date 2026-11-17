# Task productivity: useful read results and bounded local reads

This change removes two host-induced sources of wasted task work. A failed read-only shell command no longer destroys its independent peers' useful results. Local file reads no longer depend indefinitely on an auxiliary token-count endpoint. The measured improvements concern these specific paths; this is not a claim that Future-Code now matches GPT-6.1 Sol Max across coding or research tasks.

The baseline is main at `e2344798ea34cc3f06fed54679b44b084d94f512`, including the previously merged transport and goal-lifecycle fixes. Both arms use the same worker, fixtures, installed SDK and independent artifact checks. Model calls and billed tokens are zero. Holding the worker fixed isolates host behavior without confounding connected-model ability.

## What was learned from Codex

The public [Codex prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide) recommends batching independent reads and choosing effective tools. [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) explains why tool/inference rounds and accumulated context affect agent cost. These are public harness principles, not documentation of Sol Max's private implementation.

| Principle | Reproduced Future-Code problem | Implemented adaptation |
| --- | --- | --- |
| Gather independent evidence together | Any returned Bash error aborted useful concurrent reads, including commands already classified concurrency-safe | Retain errors and drain the safe batch. Cancel the next exclusive operation and its suffix |
| Avoid remote work for a local operation when a sufficient local bound exists | A 20 KB JSON read crossed the rough-estimate threshold and requested API token counting | Use a conservative UTF-8 **content** byte bound when within the file budget |
| Keep useful work progressing through recoverable service failures | FileRead token counting inherited the inference client's default 600,000 ms timeout and one retry, including potentially stalled initialization | Give this auxiliary operation one second overall; abort counting, keep the token guard, and recover using smaller ranges |

No prompt instruction substitutes for the host controls. The patch adds no model call, permission dialog, goal lifetime limit, reasoning-effort reduction or acceptance bypass.

## Runtime behavior

`StreamingToolExecutor` distinguishes an ordinary returned error from a concurrency-safe Bash command from an exclusive Bash or framework/collection failure. Independent safe peers retain their actual paired receipts. A queued write after the failed read batch is suppressed, along with its suffix. Framework uncertainty still fails immediately. Operator cancellation and effect reconciliation remain enforced.

`FileReadTool` uses `countFileReadTokens` for text and notebook content and passes the caller's abort signal. Content whose UTF-8 byte count fits the per-file token budget needs no counter request. Larger content can use a provider count within one second, including initialization. Unavailable, invalid or late counts use the conservative bound; when that bound exceeds the budget, the existing error class requests a smaller range. This is stricter than the old rough fallback and avoids treating an uncertain count as permission to emit a large result. Late resolutions/rejections are observed and cannot change the chosen result.

The byte bound concerns text content under the supported byte-based encodings. It is not an exact tokenizer result or a bound on total message framing, line-number wrappers or the whole conversation. Whole-request context accounting remains separate.

Signals reach the Messages SDK and Bedrock CountTokens transport. Initialization that finishes after cancellation cannot start counting. Bounded Bedrock counts using inference-profile IDs conservatively skip the existing uncancellable profile-metadata lookup and use smaller ranges when necessary. Ordinary counter callers preserve the prior profile-resolution behavior. This can cost whole-file convenience on that path; no Bedrock end-to-end speed claim is made.

## Paired task experiments

The [contract](../../experiments/task-productivity-20261117/contract.json) fixes scenarios, five repetitions per arm, alternating arm order, acceptance checks and a 2.5-second counter-task observation window. Each trial has a fresh process and workspace. Required bytes come from real files and `cat` subprocesses. Shell-result arrival order and counter behavior are controlled to reproduce the defects. These are selected deterministic regression tasks, not random samples from a coding benchmark.

The read experiment contains four affected repair fixtures: configuration, code, eight-module code, and repair followed by a real local commit/push. Twenty affected trials per arm produce identical independently checked artifact bytes.

| Measure across the affected repair fixtures | Baseline | Candidate |
| --- | ---: | ---: |
| Independently completed repairs | 20/20 | 20/20 |
| Worker action rounds | 80 | 60 |
| Extra read-recovery rounds | 20 | 0 |
| Useful reads cancelled by the host | 65 | 0 |
| Actual tool executions, including cancelled attempts | 190 | 125 |

This is a **25% reduction in worker rounds** and a **34.2% reduction in executed tool attempts** on those fixtures. It does not measure a reduction in live model calls, thinking tokens or paid cost. Five healthy repair trials per arm preserve the same three rounds and artifacts. Fifteen guardrail trials per arm preserve prerequisite, framework-error and operator-cancellation stops with zero forbidden mutations. Those guardrail passes are not counted as repaired tasks. The Git fixture checks a preserved pre-commit hook, one repair commit, a clean worktree and matching bytes on a local bare remote.

The counter experiment uses the exact production validator declarations and production token-count service with the actual installed `@anthropic-ai/sdk` 0.116.0 behind the repository's `@future/sdk` alias. Only unrelated client initialization services are isolated. The endpoint is a real loopback HTTP server with controlled response counts or a stalled response. The full unrelated CLI dependency graph is not loaded. Every completed repair is checked in another process.

| Primary counter cohort: five trials per arm | Baseline | Candidate |
| --- | --- | --- |
| Stalled counter | 0 timely repairs; 5 right-censored at 2.5 s | 5/5 timely repairs; median 1.226 s, including smaller-range recovery and artifact checking |
| Bounded JSON configuration repair | 5/5 repairs; 5 counter requests | 5/5 repairs; 0 counter requests |
| Healthy counter for a larger file | 5/5 repairs; 5 counter requests | 5/5 repairs; 5 counter requests |
| Unavailable counter | 5/5 repairs using the prior rough fallback | 5/5 repairs using 35 validated smaller ranges in total |
| Explicit over-budget count | 5/5 rejection controls; zero repairs/mutations | 5/5 rejection controls; zero repairs/mutations |

No completion time or speedup ratio is assigned to a censored baseline. The observation limit is an experiment boundary, not an installed task/goal cap. Socket closure is observed **before experiment cleanup**, so cleanup cannot masquerade as production cancellation.

Timing is descriptive and mixed. In the primary read cohort, code repair took median 488.16 ms before and 650.14 ms after despite saving a worker round; the eight-module fixture took 873.07 → 508.97 ms. In the final strict counter cohort, bounded JSON took 252.36 → 150.33 ms and the unavailable-counter case took 493.46 → 498.60 ms. Small local measurements are sensitive to process scheduling and do not establish a universal wall-time improvement or statistical significance. The strongest causal evidence is retained receipts, operation counts, actual transport cancellation and independently accepted artifacts.

## Independent verification and retained unfavorable evidence

A separate verifier reproduced both original read-result failures, checked the actual production diff, reran the task experiments, independently recomputed aggregate counts, authenticated inputs and challenged the artifact checkers with corrupted outputs. Checker controls reject wrong arithmetic, altered preserved bytes, missing modules, lost configuration fields, forbidden mutations, invalid module counts and unknown scenarios. Numeric audit controls reject altered aggregates and a falsely repaired over-budget control.

Independent review also found an experiment-observer defect: a synchronous artifact checker could delay a timer callback and let a late completion be labeled timely. One initial independent candidate trial completed in **2,555.44 ms**, outside the unchanged 2,500 ms window. That cohort is **4/5 timely**, not 5/5. Its exact raw record, the original primary cohort and the old observer script are retained. The corrected observer uses monotonic completion time after checking; it records a late timestamp and check separately, classifies it outside the window, and writes failed cohort records rather than dropping them. A blocking-event-loop regression proves the fix. Production source did not change in this correction; the final primary counter cohort was measured again with the strict observer.

The independent strict-observer repeat also has **4/5 timely candidate repairs versus 0/5 baseline**. Its fifth candidate artifact passed at **2,734.07 ms** and is correctly recorded outside the window. Consequently the predeclared independent **5/5 within 2.5 seconds gate FAILS**. The primary cohort's 5/5 result is not a guarantee across repetitions. This failed performance gate remains open; correctness and mechanism verification are reported separately. No further task rerun replaces these unfavorable observations.

The even-sized timely subset also exposed an upper-middle-versus-standard-median reporting error. Both runnable benchmark entry points now use a tested standard median, averaging the two middle values for even cohorts. Independent immutable-record replay corrects the four-row median to **1,199.32 ms** without changing any task outcome or raw timestamp. Original scripts, summaries and records remain archived for authentication. Five-row primary medians are unaffected.

Evidence:

- [Primary 80 read trials](validation/task-read-recovery-20261117.json)
- [Independent 80 read trials](validation/task-read-recovery-independent-20261117.json)
- [Primary 50 counter trials with the strict observer](validation/file-read-task-20261117.json)
- [Original primary counter cohort](validation/file-read-task-observer-v1-20261117.json)
- [Original independent counter cohort, including the late trial](validation/file-read-task-independent-observer-v1-20261117.json)
- [Independent strict counter cohort, including its failed task-window gate](validation/file-read-task-independent-strict-v2-20261117.json)
- [Immutable independent counter replay with the corrected standard median](validation/task-productivity-verification/file-read-task-independent-corrected-20261117.json)
- [Independent review receipt](validation/task-productivity-review-20261117.json) and [portable auditors/checker controls](../../experiments/task-productivity-20261117/verification/)
- [Original observer source](../../experiments/task-productivity-20261117/bench-file-read-task-observer-v1.mjs), retained only for historical input authentication; the current script under `scripts/` is the runnable entry point
- [Source-bound validation and review receipt](validation/task-productivity-validation-20261117.json)

The validation receipt records exact final commands, test/skip counts, source and input hashes, independent reruns, audit results and limitations. Full FileRead native import was unavailable in the existing test environment because dependencies including `zod/v4` were missing. Validator-body integration, production service tests, real SDK HTTP cancellation, Bun helper execution and all changed-module transpilation are recorded at their actual scope. Full native packaging, installation into existing sessions, live-provider coding benchmarks and a matched-model Sol Max comparison remain unmeasured.

## Reproduction

Use Node >=22.13 with type stripping and the repository's pinned `@future/sdk` dependency installed. The recorded runtime is Node 24.22.1 and SDK 0.116.0. From the candidate checkout:

```sh
git worktree add --detach ../future-code-baseline e2344798ea34cc3f06fed54679b44b084d94f512
node scripts/bench-task-read-recovery.mjs ../future-code-baseline /tmp/task-read-recovery.json
node scripts/bench-file-read-task.mjs ../future-code-baseline /tmp/file-read-task.json
node --experimental-strip-types --test --test-concurrency=1 tests/correctness/streaming-tool-executor.test.ts tests/correctness/file-read-token-budget.test.ts tests/correctness/file-read-token-count.test.ts tests/correctness/task-productivity-observer.test.ts
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-commands.mjs
```

Historical reports retain the exact hashes of the observer versions that produced them. The portable auditors use explicit input maps to authenticate those archived bytes; production source hashes are always checked against the actual checkout. To audit the retained records independently:

```sh
python experiments/task-productivity-20261117/verification/audit-read-results.py docs/agent-platform/validation/task-read-recovery-20261117.json --baseline ../future-code-baseline --input-map experiments/task-productivity-20261117/verification/read-input-map.json
python experiments/task-productivity-20261117/verification/audit-file-results.py docs/agent-platform/validation/task-productivity-verification/file-read-task-independent-corrected-20261117.json --baseline ../future-code-baseline --input-map experiments/task-productivity-20261117/verification/counter-strict-input-map.json
node experiments/task-productivity-20261117/verification/checker-tamper.mjs .
node experiments/task-productivity-20261117/verification/file-checker-tamper.mjs .
node --experimental-strip-types experiments/task-productivity-20261117/verification/native-sdk-abort.mjs .
```

An audit `PASS` authenticates and recomputes the evidence. The independent counter audit separately returns `experimentResult: FAIL` for the missed timing target.

Run timing cohorts without simultaneous heavy test launches. A late or unfinished candidate must be retained and reported as such; repeating a cohort does not erase it. Source/input freeze guards reject changed code during measurement. Rebuild and restart/resume the installed agent to adopt the source changes; this PR does not deploy a binary to existing sessions.
