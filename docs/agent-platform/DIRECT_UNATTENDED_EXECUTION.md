# Direct work and unattended execution

The host now covers several gaps left by the earlier direct-action and Git delivery fixes. These changes preserve the acceptance boundary: activity is not proof, and a model completion claim still requires independent verification.

## What caused the remaining delays

| Previous behavior | Result | Change |
| --- | --- | --- |
| The Git latency policy recognized only complete, short Git requests. | A request such as “fix the issue, verify it, then commit and push” never entered that policy. Continued thinking/retry heartbeats could keep the final delivery phase alive. | With human delivery intent, paired foreground Git stage/commit/push receipts can enter the existing delivery policy inside a mixed task. |
| Any successful Bash result reset the observation-only diagnostic. | Repeated `rg`, `cat`, `ls`, or `git status` calls looked like completed implementation work. | Recognize a small, bounded set of simple shell observations. They remain observations for the existing 12-receipt review and identical-receipt detection. |
| Question suppression depended on an ACTIVE goal. Some permission routes accepted a forced hook decision directly. | A pause, review state, plan mode, or hook could open another user dialog. | Default execution is unattended across question/plan validation and terminal, print, prompt-tool and SDK permission adapters. Forced hook requests pass through the same final dialog suppression. |
| Shells inherited Git askpass programs. | A Git command could invoke terminal/GUI credential input while the agent waited. | Child shells default to `GIT_TERMINAL_PROMPT=0` and an empty `GIT_ASKPASS`. Configured noninteractive credential helpers remain available. |

## How the delivery policy works

Initial research and implementation retain normal reasoning. Phase detection is eligible only after an explicit delivery hint in the latest trusted human request. Tool output, child messages and host reminders cannot supply that intent. Git commands used within a research fixture alone do not enable it.

Once eligible, a successful paired simple Git effect enters delivery. Missing, duplicate, failed, interrupted, backgrounded, or ambiguous batch receipts release the policy. Further implementation or a test/experiment command also releases it so diagnosis retains normal reasoning. Simple observations preserve an existing delivery phase. Fresh human steering clears both the phase and its old intent.

The existing default remains **120 seconds per model request and 240 seconds of cumulative model-stream time per foreground query**. Thinking tokens and retry heartbeats cannot extend that deadline. This is a narrow wall-clock limit on delivery reasoning, not a token cap on the goal. It does not cancel Git, hooks, signing, tests, or healthy external jobs. Admitted effects are collected; uncertain effects must be reconciled before another attempt.

The lexical hints intentionally reject unsupported/compound shell syntax. They never execute or rewrite a command, approve access, certify success, or skip required checks. A review asks for the specific uncertainty that justifies further exploration; it is not a stall verdict or an order to mutate a read-only task.

## No approval or choice dialogs by default

Unattended execution selects routine implementation choices from evidence and continues authorized work. A model question is redirected before its UI opens, even without a goal or after work is paused. Old goal interaction preferences cannot yield for a choice while unattended.

Already allowed tool operations keep their existing behavior. A remaining `ask` decision becomes a visible denial with its original prerequisite and reason. It does not become an invented approval or answer. Explicit restrictions, mandatory structural validation, operating-system access errors, hooks and independent acceptance remain enforced. Continue permitted independent work; if an external prerequisite blocks all progress, preserve the goal and report the exact failure and recovery attempted.

An owner who intentionally wants the legacy interactive workflow can configure `FUTURE_CODE_INTERACTIVE_PROMPTS=1`. During an active goal, its trusted interaction preference is still required. The setting does not override restrictions or supply credentials. The Git environment changes prevent Git's own terminal/askpass prompts; custom SSH transports, credential helpers and signing programs retain their own behavior and may return external errors.

## Goal tokens

A default `/goal` already has **no lifetime total-token ceiling** and no default continuation-count ceiling. This patch makes that explicit in the command response and adds regressions for continued work beyond one million historical continuations and with cumulative output usage set to `Number.MAX_SAFE_INTEGER`.

Provider context windows and per-response output limits still apply. The host continues across requests and context recovery. Explicit caller limits, operator pauses and failed acceptance still apply; spending more tokens never establishes success. Optional token spending targets cannot revive a paused/review goal or stop an unfinished active goal.

## Validation and reproduction

```sh
node --experimental-strip-types --test --test-concurrency=1 tests/correctness/direct-execution.test.ts tests/correctness/git-delivery-policy.test.ts tests/correctness/goal-decision-flow.test.ts
node --experimental-strip-types scripts/bench-direct-execution.mjs 0a73ff09cfab31e8694871f2d59a52aee9806514
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```

The focused cases include actual local Git stage/commit/push, one preserved pre-commit hook, remote-ref reconciliation, and a loopback HTTP authentication failure that proves askpass was invoked with the old environment but is not invoked with the unattended overrides. No real credentials or paid API requests are used.

The [component comparison](validation/direct-execution-measurements-20261116.json) records baseline/candidate decisions and five raw simulated-stream samples. Its 30 ms test deadline is deliberately scaled down from production. A cancelled thinking stream is not a completed task: these measurements establish policy coverage and bounded waiting, not a live-model productivity speedup or human-level insight. The [validation record](validation/direct-execution-validation-20261116.json) binds checks to source hashes.

Adoption requires rebuilding/upgrading the CLI and restarting or resuming sessions with that build. Running processes do not acquire new host code from a merged PR. Full native packaging, deployment into user sessions and live-provider task productivity are outside this validation.
