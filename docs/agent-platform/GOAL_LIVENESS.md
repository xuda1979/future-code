# Goal liveness and working context

`/goal <objective>` now creates a durable execution goal. `/goal --auto <objective>`
is an alias. A normal model end-turn continues the unfinished goal, including
when a custom output style is selected. There is no default 32-turn ceiling.
Ordinary conversations without a goal still finish normally.

Use `/goal --limit N <objective>` for a finite continuation budget (1–100000),
`/goal --pause` to stop automatic work, `/goal --resume` to restart the configured
goal, and `/goal --status` to inspect its durable state. Existing finite budgets
are preserved; reissue `/goal <objective>` to switch an old bounded goal to
continuous operation. Resuming a bounded goal explicitly authorizes another
batch and preserves its total lifetime counter. Restarting the CLI never resets
that counter or authorizes another bounded batch.

The host yields to queued user input and task notifications before adding an
autonomous continuation. A dispatcher subscribes directly to queue/guard
changes and checks readiness every second as a fallback. It never starts a
second foreground query or bypasses an active local command UI. A new user
question is no longer required to wake an idle queue.
Urgent input interrupts only the current turn, preserving the active goal for
the follow-up. An explicit operator cancellation still pauses the goal.

Queued input is acknowledged immediately. The query guard, including its
dispatch ownership epoch, is the only foreground execution lock. A cancelled
adapter or completed turn's unfinished bookkeeping promise cannot retain a
second queue lock. Late failures and cleanup are fenced from newer requests;
foreground preparation/dispatch errors appear in the conversation.

The whole human instructions `continue`, `resume`, `keep going`, `go on`,
`继续` and `继续工作` resume a paused durable goal with its existing limit and
lifetime counter. Repeated instructions do not reset an already-active batch.
Task notifications and meta messages cannot rearm the root goal. An explicit
resume acknowledges the existing goal-file report; a fresh report is still
evaluated, so a stale blocker cannot immediately park resumed work again.

SessionStart hooks run before UserPromptSubmit, under the input's guard
reservation. Their rejection is observed immediately and their original
invocation is reused after a timeout. Required hook context is never bypassed
or injected twice. Startup-hook waiting and read-only system/user context
loading have a 120-second preparation deadline. Set
`FUTURE_CODE_PREPARATION_TIMEOUT_MS` to 1000–3600000 ms to tune it. A stalled
phase displays its name and an error, releases the request and retains the
goal/checkpoints. This deadline does not govern tools, external jobs or human
permission decisions. Completion observers run after synchronous turn cleanup
and cannot keep the next queued request waiting.

While a query runs, its spinner reports preparation, compaction, model/API,
tool/job execution and stop-hook phases every 15 seconds, with elapsed time,
time since observed activity and estimated context tokens. These updates are
UI telemetry: they add no conversation messages and make no model requests.
Activity is not proof of accepted progress. Approval dialogs still identify
requests awaiting operator input.

A silent model read expires after 180 seconds without model content, even if
transport heartbeats continue. `FUTURE_CODE_MODEL_IDLE_TIMEOUT_MS` can set
1000–3600000 ms. Before tool admission the host keeps reconnecting with capped
backoff in the default unattended retry mode (`FUTURE_CODE_UNATTENDED_RETRY=0`
opts out and retains one reconnect). After tool admission it collects the
existing tool results and continues with those receipts instead of replaying
effects. Transient transport failures and retryable HTTP responses remain
visible waits and resume automatically when service returns. A terminal
provider failure retains the actual error in durable goal state and returns
an error outcome. Long-running tools/jobs are not cancelled merely for being
quiet; their own deadlines and durable supervision remain authoritative.

Active interactive goals use a 64000-token working-context target for proactive
compaction, bounded by the existing provider/output-reserve threshold. Set
`FUTURE_CODE_WORKING_CONTEXT_TOKENS` to 16000–1000000 to tune the target. Existing
compaction-disable settings and smaller thresholds take precedence. Ordinary
conversations, short contexts and noninteractive agents retain their previous
thresholds. Retirement uses the existing summary, transcript and restore
pipeline; it does not delete evidence or alter acceptance checks.

Tool result batches now have a default 32000-character aggregate budget,
enabled even without remote feature flags. The existing storage pipeline
saves full oversized outputs before replacing them with a preview and file
reference; it makes no summarization-model request. Read's self-bounded output
and non-text content retain their existing exemptions. Small outputs are not
offloaded when a reference would make them larger. Previously seen results
retain their decisions, and recorded previews are re-applied identically on
resume. A storage failure keeps the original content.

Set `FUTURE_CODE_TOOL_RESULT_BUDGET_CHARS` to 8000–1000000 to tune the batch
target; a valid local setting takes precedence over the remote override.
`FUTURE_CODE_DISABLE_TOOL_RESULT_BUDGET=1` or an explicit false remote flag
disables this optimization when provisioning a conversation. The budget is
a target, not a reason to discard evidence or alter a previously cached prefix.

Model-declared completion requests REVIEW and never fabricates acceptance.
Unfinished implementation, failing tests and a model end-turn keep the goal
active. A model-authored blocker only pauses the goal when its current goal
file contains a complete external-dependency report:

```text
Status: blocked
Blocker: Required executor is offline: device unavailable
Blocker type: hardware
Recovery attempted: Reconnected and checked device health; executor still offline
External action required: Restore power to the executor
```

Allowed types are `hardware`, `network`, `provider`, `credentials`, `permissions`,
`resources` and `external_dependency`. Reports missing a type, attempted
recovery or required external action cause another diagnostic/work step. These
fields record the agent's report; they do not independently certify the cause
or establish acceptance. The host displays and saves the actual error,
attempted recovery and required action. After restoring the dependency, use
`/goal --resume` and recheck/update the goal file as work resumes.

Caller limits, state corruption, API failure, tool cancellation and stop-hook
prevention are also reported before pausing. Child/SDK failures cannot pause
the main thread's goal.

Supervised Swarm objectives automatically replan missing acceptance evidence
before or after integration, within their existing authority, scientific
obligations and request/replan budgets. Replacement runs cannot hide unresolved
conflicts, stale claims or unreconciled external effects. Those remain explicit
until their ledger is reconciled/adjudicated. Objective-level errors and durable
recovery failures appear first in progress reports, even when many workers have
failed. Deferred provider recovery retains its retry deadline and remains
attached; reporting activity alone never counts as progress or completion.

Run `node scripts/test-correctness.mjs` and `node scripts/test-commands.mjs` for
the liveness regressions, plus the standard resilience/Foundry/Swarm gates.
These offline checks cover runtime policy and recovery, not live-provider R&D
speed or a packaged CLI certification.

Source changes do not update an already-running executable. Rebuild the CLI
in a dependency-complete checkout (`./build.sh`), then restart the updated
executable and resume the saved session in the same project. Preserve the
project's `.future-code` state and session transcript when doing so.
