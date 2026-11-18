# Keep authorized work moving from the best existing artifact

The reported failure was a month of infrastructure repair and repeated checks
without substantial model-training progress, despite an earlier improved
adapter. This patch removes concrete continuation defects and preserves the
operational facts needed to resume work. It does not establish a new quantum
benchmark score or demonstrate that the live remote training system is fixed.

## Findings and changes

| Observed mechanism | Previous behavior | Changed behavior |
| --- | --- | --- |
| Repeated routine permission requests | The third handoff changed the durable goal to `PAUSED`. | Two corrections lead to changed execution recovery. A configured fallback is selected automatically when available, with producer-bound thinking removed. A persistent model failure stays explicit without revoking the standing objective. |
| A model writes a complete external-blocker report | Report wording alone could pause the main goal, including an invented observer work slot. | The real query requires `Failure receipt: <tool-use-id>` matching an actual paired failed tool result from the current objective generation. A model report cannot invent a caller budget or missing authority. |
| Compaction loses the successful artifact and next action | The host restores the root objective and milestone frontier, but has no compact operational record of the known artifact, job, failed approach and next action. | The next request projects the session's bounded `work-state.json` directly from disk. It does not depend on the model remembering or opening a growing status history. |
| Repeated compound shell probes | A successful opaque Bash call cleared the activity diagnostic before its repeated receipt was counted. | Exact repeated opaque requests/results produce an advisory review. Changed evidence clears the repetition; the host does not infer failure or cancel a healthy job. |
| Internal note updates | Only goal-report edits were treated as bookkeeping by the action review. | Edits to the internal work-state record also remain bookkeeping, not outcome progress. |

The failure-receipt list is capped at 32 IDs and lives in the owning query.
Question/plan redirects, duplicate/unpaired results and child messages cannot
authenticate an external blocker. Objective, revision or steering changes retire
old failure evidence, including failures from an older request finishing late.
After a restart, a missing receipt requires a new targeted diagnostic; it is
neither a healthy verdict nor permission to repeat an unchanged denied action.

The fallback/recovery budget is durable and bounded. Repeated unchanged model
refusal eventually produces `model_contract_failure`, with the objective still
`ACTIVE`; the host cannot guarantee that an uncooperative provider will execute
work. Actual operator pauses, caller limits, permission checks, API failures and
independent acceptance remain enforced.

## One small work record

For a long task, keep `work-state.json` beside the session-specific `goal.md`.
It is optional and must never become a setup gate for a simple task. The host
accepts at most 16 KiB, exact root/revision binding and known fields. It rejects
unsafe file types, symlinks, oversized or invalid records. Invalid hints cannot
stop work. Reads are fresh and bounded; no transcript rewriting or new model
call is required.

```json
{
  "schema": 1,
  "goal": "Exact current root objective",
  "revision": 1,
  "baseline": {
    "artifact": "path or immutable artifact identity",
    "evidence": "prior evaluation record",
    "contract": "frozen evaluation identity"
  },
  "activeJob": {
    "id": "existing job identity",
    "target": "actual execution host",
    "checkpoint": "last complete checkpoint",
    "lastProgress": "last meaningful observed event",
    "nextCheck": "next expected event or deadline"
  },
  "nextAction": "One executable action that advances the requested outcome",
  "metric": {
    "name": "primary outcome metric",
    "baseline": "recorded comparison",
    "current": "measured value or explicitly unmeasured",
    "nextEvaluation": "when the next comparison runs"
  },
  "attempts": [
    {"action": "last failed approach", "result": "observed failure", "next": "changed recovery"}
  ]
}
```

`baseline`, `activeJob`, `metric` and `attempts` are optional; at most four
attempts are retained. Update on material results, launches, failures and changed
next actions. Do not log every probe. This is advisory recorded context, not a
host-verified checkpoint, live health check, execution grant or acceptance
receipt. Reconcile an existing job on its actual host before replacing it. A
dead forwarding port does not establish that the remote job died. Reuse
exploration evidence only while relevant inputs match, and keep final
verification independent.

## Reproducible evidence

The baseline is `55e0bc6ee6ab15c295515150d62d9d06f4f4e036`.

| Check | Baseline | Patched source |
| --- | --- | --- |
| Same 62 frozen behavioral contracts | 29 pass, 33 fail | 62 pass, 0 fail |
| Repeated authorization in the controlled replay | Third decision `BLOCKED`, goal `PAUSED` | Third decision `RECOVER`, goal `ACTIVE` |
| Lossy-summary operational context | Known checkpoint absent from fresh request | Known checkpoint and next action present |
| Invented observer-budget report without failure evidence | `BLOCKED`, goal `PAUSED` | `CONTINUE`, goal `ACTIVE` |

The replay also executes a real CPU scalar-adapter optimizer in subprocesses.
The prior 12-step checkpoint is preserved; each patched scenario continues it
for 120 updates. Its final parameters and momentum exactly match a separate
uninterrupted 132-step process. This checks save/resume and continuation behavior.
It is not Qwen, IBM, a live-LLM benchmark or a speedup measurement. The bounded
baseline replay does not model how a live agent might rediscover missing state.

Reproduce with an isolated baseline checkout:

```sh
node scripts/bench-goal-regressions.mjs BASELINE experiments/goal-resume-20261118/regressions.json
node scripts/bench-goal-resume.mjs BASELINE experiments/goal-resume-20261118/results.json
node scripts/test-correctness.mjs
node scripts/test-commands.mjs
```

Both JSON reports include source hashes. The production end-turn and rejected
question branches are exercised separately in `goal-decision-flow.test.ts`,
including fallback, signature cleanup, tool pairing, exact blocker receipt,
caller/queue precedence and child isolation. Broad correctness/command gates
pass; platform-specific skips remain explicit. All changed runtime sources
also transpile with Bun 1.4.2 using `--no-bundle`. No complete native CLI release
or remote accelerator deployment was performed.

## What the project evidence establishes

The last pushed `xuda1979/quantum-gpt` main revision inspected was
`49beef5dd58381a571735fa67d8848afd83c655e` (November 1). It records the prior
`sft-27b-q38-v22-resume-20261023T081500Z/checkpoints/step-1941/adapter` and later
training held for an operator go or a supposed observation-slot mismatch. Its
status history is 2,843,025 bytes. The recorded internal 18-task results are
not an IBM score, and current remote artifact integrity was not revalidated.
Its `resume_training.py` also restricts discovery to `v10*`; that project-side
selector deserves reconciliation with the active run before use.

The November 18 `c10744` keeper and daemon state are not in that pushed revision.
This patch must therefore be validated against the actual current checkpoint,
resident job and frozen evaluation before claiming the month-long training
problem is resolved. The next useful project action is to reconcile that known
adapter/job and continue a bounded training window, then compare the resulting
candidate to the preserved baseline under the same evaluation contract.
