# Git delivery latency and project experience

The interactive CLI distinguishes a short Git delivery instruction from an
implementation or research task. For example, `git add, commit and push` and
`please commit the changes and push to origin` receive a delivery scope reminder.
`fix the bug then commit and push`, questions about Git, quoted commands and
unrecognized wording keep the normal reasoning policy. This conservative
recognizer changes latency policy only; it does not grant execution authority.

## Bounded model work

The ordinary stream watchdog detects silence. It cannot bound a provider that
keeps producing thinking tokens or retry heartbeats without doing useful work.
For recognized delivery-only requests in the interactive main thread:

- Each model request has a 120-second wall-clock limit, including active tokens
  and provider retry waits. All model rounds/retries in that foreground query
  share a 240-second budget. The deadline uses a monotonic clock.
- Before tool admission, one recovery attempt is permitted. Persistent transport
  retry mode cannot turn a delivery deadline into an unlimited retry loop.
- After tool admission, the runtime collects actual results before continuing.
  It never restarts admitted commands to recover a model stream. An exhausted
  budget is reported as a failure, never as successful delivery.
- These limits govern the model stream, not external command completion. Hooks,
  signing, permissions, verification and long-running commands retain their
  normal execution and collection rules. A slow hook or network push can still
  take longer; diagnose its actual result before retrying.

Set `FUTURE_CODE_GIT_MODEL_TIMEOUT_MS` to an integer from 1,000 to 3,600,000 to
change the per-request limit. The shared query budget is twice that value.
Invalid values retain the default. Other task types, background agents,
noninteractive SDK requests, models and reasoning effort are unchanged.

The Git tool instructions also enforce staging **before** committing. Only
independent reads should run in parallel. Delivery reuses existing check receipts
only if they still bind the exact candidate and project policy permits reuse.
An uncertain commit/push outcome requires reconciling HEAD and the remote ref.

## Learn within each project

The existing automatic file memory now supports `type: experience` alongside
user, feedback, project and reference memories. Both the foreground memory writer
and the optional background extractor receive the same learning instructions.
The foreground path does not depend on enabling background extraction and adds
no extra reflection API request or end-of-turn gate.

Save a lesson autonomously when work reveals a reusable, non-obvious insight.
Ordinary successful commands and routine Git delivery do not need memory entries.
Use a small topic file and a one-line pointer in `MEMORY.md`, as with other
memories. A lesson records:

| Field | Content |
| --- | --- |
| Conditions | Environment/version and trigger where the lesson applies |
| Observation | What failed or worked |
| Evidence | Dated observed command/result, receipt or artifact pointer |
| Lesson | Procedure, cause if established, and unsuccessful alternatives |
| Limits | Uncertainty, hypotheses and conditions requiring a fresh check |

By default, memory is private to the current user's canonical project root;
worktrees of that root share memory. Existing explicit directory overrides and
team-memory configuration retain their behavior. Project/domain content belongs
in that project's memory, not in shared runtime policies or another project.
Keep credentials and raw transcripts out of lessons. Correct or retire stale
lessons when new evidence contradicts them, and honor disable/ignore/forget
instructions. The existing `autoMemoryEnabled: false` setting or
`FUTURE_CODE_DISABLE_AUTO_MEMORY=1` disables automatic memory.

Lessons guide the next investigation. They cannot authorize commands, override
the user's current objective, certify completion or replace independent checks.
Recall verifies applicability against current files and evidence. This feature
uses model-authored memory instructions and the existing file tools; it does not
guarantee that every potentially useful lesson is captured.

## Verification scope

Focused offline tests exercise continuous-thinking/retry deadlines, cumulative
budgets, cancellation, conservative request selection, production retry decisions,
and the real streaming tool executor. A local Git fixture verifies one actual
stage/commit/push with a pre-commit hook and remote-ref reconciliation. Memory
tests cover all writer prompts, type compatibility, disk/index recall and
separate project directories.

These are runtime regression tests with simulated model streams, not a measured
live-provider productivity claim or a full packaged CLI certification.
