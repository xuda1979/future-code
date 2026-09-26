# Architecture and contracts

## Control plane

One supervisor owns a renewable SQLite runtime lease for one project. It validates
configuration and the saved DAG, reconciles commit journals, recovers expired workers,
then runs a bounded asyncio worker pool. A second live supervisor cannot acquire the
same lease. SQLite transactions serialize state mutations; each task's attempt has a
monotonically increasing fence and a lease. Expired or cancelled workers cannot publish
results using an old fence.

The coordinator process contains concurrent logical agents, not independently hosted
microservices. Each agent has a narrow task packet, its own staged filesystem snapshot,
recent observations, dependency results and addressed task messages. No full-project
conversation transcript is copied into each context. Both serialized character and UTF-8 byte ceilings
bound context; neither is an exact tokenizer-based limit. Version 1.2 adds lifetime fan-out,
fresh-context parent resumption, scoped board/result pages and replace-only notes; see
[HIERARCHICAL_COORDINATION.md](HIERARCHICAL_COORDINATION.md). Mandatory contract information
is not silently dropped: an oversized contract is rejected and should be decomposed.

`Config.max_workers` caps concurrent logical workers. Actual parallel usefulness depends
on independent scopes, dependency shape, provider capacity and acceptance-test cost.
Verification/integration is serialized, deliberately trading some throughput for a
consistent combined-project gate result. Large snapshots are bounded and may block the
event loop during hashing; start with small projects and increase lease time for larger
ones. This is not a benchmark claim for very large repositories.

## Task lifecycle

`queued -> running -> done` is the successful path. Other persistent states are:

| State | Meaning and exit |
|---|---|
| waiting | Delegated parent awaits children; original final gate remains mandatory |
| retry_wait | A known transient interruption or recoverable conflict is waiting until its next eligible time |
| blocked | Operator diagnosis/change is needed; only an explicit reasoned retry requeues it |
| failed | Stored failure state; cannot satisfy dependent tasks |
| cancelled | Operator cancelled work; descendants are cancelled where journal safety permits |

A task has one owner, explicit write scope, prerequisites, acceptance criteria, gate IDs,
role, domain profile, priority, step/attempt/deadline limits and optional review requirement.
Lower numeric priorities dispatch first among eligible tasks. Repair work can be assigned
priority 0. The runtime does not secretly change project objectives or generate a new
unbounded backlog from unrelated findings.

Claims require every prerequisite to be `done` and no overlapping active writer. Scope
matching is path-component based: `src/a` includes `src/a/x.py`, not `src/another.py`.
A delegated child cannot broaden the parent's write scope, increase its task limits,
remove the parent's reviewer requirement or change its domain profile. The original
parent's integration check must still pass after children complete. Cross-task messages
are durable, bounded and treated as data, never privileged instructions.

## Model action protocol

The HTTP adapter sends chat-style `{model,messages,stream:false,max_tokens,temperature}`
and accepts text at `choices[0].message.content`. A worker response must be exactly one
JSON object. It may select only `list`, `read`, `search`, `write`, `gate`, `message`,
`delegate`, `inspect`, `result`, `inbox`, `remember` or `finish`. Unknown/missing keys are rejected. The production system prompt
and action key contracts are in `src/future_code/worker.py`; this is the source of truth.

There is no arbitrary model-selected shell command, delete tool or deployment tool.
Configured gates are explicit administrator-approved argv arrays. Every write task
requires executable gates. Existing files must be read before native-tool overwrite.

`finish` is a proposal, not success. The runtime rebases untouched files from current
source, checks read/write conflicts, executes the configured gates on the resulting
combined tree, validates domain evidence, optionally requests a separate model review,
and authenticates the final input fingerprint. Model prose cannot mark a task `done`.
Model summaries are saved as `MODEL_REPORTED_NOT_FACT_CHECKED` and are not used to format
operational status tables.

## Filesystem and integration

`.future-code/` contains private `config.json`, `state.db`, `workspaces/`, `artifacts/`
and `reports/`. Secret-like paths, `.git`, runtime control state, ignored caches, symlinks
and oversized files are not made available as normal worker inputs. Omission is visible
in snapshot metadata; an omitted existing root file cannot be overwritten through the
native write tool. This heuristic is not a comprehensive secret detector.

Source writes stay in an attempt workspace. Before promotion, every changed path must
be in its leased scope and outside protected acceptance inputs. Deletions are rejected.
The supervisor verifies staged hashes and the current root inventory, writes immutable
payloads/backups and a durable prepared integration journal, then replaces each target
file atomically and marks the journal committed.

A multi-file commit is **not globally atomic** to unrelated readers. On a crash, recovery
first authenticates all payloads, all affected original/new hashes, the unchanged unrelated
tree, allowed paths and the reconstructed verified fingerprint. It rolls forward only
when this is consistent; otherwise it blocks and preserves evidence. There is no silent
partial-success claim or automatic destructive rollback over later user changes.

The full snapshot is intentionally simple. It is not a Git worktree, remote transactional
filesystem, distributed lock or OS access-control boundary. Use a disposable branch and
an outer sandbox for untrusted projects or tools.

## Transport and recovery

The HTTP client pools connections, bounds connections/response bytes/timeouts, verifies
TLS, disables implicit environment proxy routing and does not follow redirects. A
corporate proxy or custom CA requires an explicitly reviewed adapter/configuration
extension; this release does not disable certificate verification to make a connection
appear healthy.

408/425/429 and 5xx or transport interruptions enter bounded jittered backoff. Retry-After
is respected within an explicit ceiling. A circuit cooldown admits at most one half-open
inference probe. Health polling is optional, uses a configured same-origin route and is
not a billable dummy inference. `REACHABLE` does not prove the selected model works.
401/403, invalid requests and TLS failures require configuration/operator attention.

Before every completion request, SQLite reserves one call and a conservative token
allowance. Unknown provider outcomes remain counted because they may be billable. Actual
provider usage is a separate, possibly incomplete measurement. There is no automatic
budget reset or invisible failover to a different model/provider.

Checkpoint recovery authenticates task contracts, root read/write hashes and staged
payloads; gates rerun before publication. Native HTTP worker interruptions can resume.
An interrupted or expired external CLI attempt blocks instead of automatically replaying
unknown external side effects. Automatic source-conflict regeneration is limited by task
attempt ceilings; commands must still be trusted and appropriately isolated.

## Stable reporting contract

`reporting.TABLES` freezes thirteen table IDs (report schema two), order and columns. `status.json` is the
machine-readable projection; Markdown and HTML show the same event sequence and snapshot
time. They are separately atomically replaced, not a three-file atomic transaction.
Long Markdown cells are visibly shortened; JSON retains the full structured value.

Quality PASS is bound to a named check, attempt and input hash. It does not automatically
remain a statement about a later edited project. Artifact hashes are labelled recorded
at integration. Stale heartbeats become UNKNOWN; stale endpoint observations retain an
explicit freshness flag. Missing price, usage, metrics or checks are not invented.

The dashboard is read-only and loopback-only, with Host checks, optional Bearer token,
HTML escaping and restrictive response headers. `/health/live` is supervisor liveness;
`/health/ready` is dispatch readiness, not LLM accuracy or production success. `/metrics`
exports a small Prometheus text surface. No OpenTelemetry exporter, pager, external
notification service or provider billing integration is implemented.
