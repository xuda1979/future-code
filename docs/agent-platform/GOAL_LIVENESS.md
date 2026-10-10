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

While a query runs, its spinner reports preparation, compaction, model/API,
tool/job execution and stop-hook phases every 15 seconds, with elapsed time,
time since observed activity and estimated context tokens. These updates are
UI telemetry: they add no conversation messages and make no model requests.
Activity is not proof of accepted progress. Approval dialogs still identify
requests awaiting operator input.

A silent model read expires after 180 seconds without model content, even if
transport heartbeats continue. `FUTURE_CODE_MODEL_IDLE_TIMEOUT_MS` can set
1000–3600000 ms. Before tool admission the host reconnects once. After tool
admission it collects the existing tool results and continues with those
receipts instead of replaying effects. Repeated model failure is a visible,
durable blocker. Long-running tools/jobs are not cancelled merely for being
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
When no safe recovery remains, the agent can write `Status: blocked` and a
specific `Blocker: <cause and attempted recovery>` in its current goal file.
The host surfaces that reason. A bare blocked label cannot silently stop work.
Caller limits, state corruption, API failure, tool cancellation and stop-hook
prevention are also reported before pausing. Child/SDK failures cannot pause
the main thread's goal.

Run `node scripts/test-correctness.mjs` and `node scripts/test-commands.mjs` for
the liveness regressions, plus the standard resilience/Foundry/Swarm gates.
These offline checks cover runtime policy and recovery, not live-provider R&D
speed or a packaged CLI certification.
