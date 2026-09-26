# Hierarchical task mesh: implementation and operator guide

Version 1.2.0. This document describes shipped code, not a proposed future component.
See `RESEARCH.md` for source-backed rationale and `../TEST_REPORT.md` for measured tests.

## 1. Separate cognition from execution control

```text
Operator: objective, constraints, immutable acceptance gates, budgets
                              |
                     Root integration task
                     /       ...       \
                Regional tasks (at most 8 per parent)
                  /          ...          \
               Local integrators (at most 8 per parent)
                  /          ...          \
               Narrow leaf tasks (at most 8 per parent)

Every level uses:
  durable task/dependency board -> ready queue -> bounded execution slots
  scoped messages + paged result/evidence reads + bounded replace-only notes
  isolated attempt workspaces -> executable checks -> serialized integration

No LLM decides every dispatch, heartbeat, retry, counter or dashboard row.
```

The root owns final synthesis and configured integration checks. It does not need to
approve every local action or receive every observation. An active coordinator can
create child coordinators through `delegate`; the runtime validates their ownership,
scopes, depth, limits and prerequisites. The parent then releases its execution slot.
After its prerequisites finish, any available slot can resume the parent from durable
state and a fresh task-local packet. Successful delegation does not consume a failure
retry, including when `max_attempts` is one.

The current implementation runs one supervisor and SQLite database on one host. There
is no distributed worker service or consensus cluster. Independent branches can progress
while their root LLM task is asleep; loss of the supervisor/host still needs process
restart and durable-state recovery. The existing singleton lease prevents two supervisors
from concurrently owning the same project.

## 2. Two ways to build the task graph

### A. Operator-prepared independent tasks

Create a JSON envelope `{"tasks": [...]}` using the existing TaskSpec fields. Every leaf
must have its own objective, acceptance criteria and explicit write scope. Preserve
cross-leaf dependencies where needed. Write tasks require meaningful configured gates.

```bash
future-control --project /path/to/project submit leaves.json \
  --hierarchy --root-id project-root --fanout 8 \
  --integration-gate project-integration
```

This deterministic compiler preserves supplied leaf contracts/dependencies and adds
read-only integrators. It groups tasks; it does **not** infer semantic decomposition
from an arbitrary goal. The root gate ID must already exist in the configuration.
Intermediate integrators do not gain arbitrary write authority. Their own quality
remains UNKNOWN when no executable gate applies, even when their descendants passed.

For 512 leaves and fan-out eight, configure `max_total_tasks` to at least 585. The default
500-task ceiling intentionally rejects a larger unapproved graph. `max_delegation_depth`
must be at least three. Admission checks both existing and new children atomically.
Malformed ownership, cycles, excessive fan-out or inconsistent depth are rejected.

### B. Model-selected bounded decomposition

Submit one coordinator task with the approved overall scope and gates. It may return
`delegate` with up to the configured number of direct children. Children can themselves
be coordinators, but cannot broaden scope or weaken inherited safeguards.

A successful yield resumes only after dependencies complete. The direct-child ceiling
is lifetime-wide, not reset on resumption or retry. At the ceiling, further decomposition
must occur inside an eligible child coordinator, not by silently adding more root
children. There is no automatic reparenting or reopening of completed subtrees. A
blocked child is surfaced through dependency status and incidents; an operator must
approve retry when the existing safe recovery policy requires it.

A compiled read-only integrator cannot fix a new source defect by granting itself write
permission. Failed cross-component integration requires a separately authorized repair
task or an operator-approved retry/contract change. This is an authority boundary, not
an excuse to treat a failing final gate as success.

## 3. Bound every model request

| Configuration | Default | Meaning |
|---|---:|---|
| `max_workers` | 4 | Concurrent execution slots; accepted range 1-256, exercised up to 64 here |
| `max_children` | 8 | Lifetime immediate children per coordinator |
| `max_delegation_depth` | 3 | Maximum ownership depth admitted by the configured runtime |
| `max_active_per_cell` | 4 | Simultaneously active immediate siblings; permits sharing slots across cells |
| `max_context_bytes` | 16384 | Maximum canonical serialized UTF-8 bytes of input messages |
| `max_context_chars` | 24000 | Existing character ceiling; both limits apply |
| `context_items` | 8 | Maximum board/result/mailbox page size and default dependency-card count |
| `max_note_bytes` | 1600 | Replace-only durable working note |
| `max_message_bytes` | 1200 | Individual message UTF-8 byte ceiling |
| `max_inbox_pending` | 32 | Maximum native pending messages per recipient |
| `scoped_messages` | true | Limit native messages to explicit local collaboration edges |

The serialized byte measurement is **not a tokenizer count**. Provider framing, hidden
provider state and output tokens are separate. Configure the served model and output
limit appropriately. The byte guard is enforced by the worker context builder and at
HTTP/command backend admission; reviewer inputs are checked too.

The exact task instructions, acceptance criteria, scope and approved gates are mandatory.
They are not silently shortened to make a request fit. An oversized mandatory packet
blocks rather than weakening the contract. Optional observations, messages and result
cards are admitted under the ceiling, with explicit omission counts. The most recent
feedback is preferred; older observations are bounded and expendable.

Notes replace, rather than append to, a bounded text slot. Revision checks prevent stale
updates. Notes are model-authored and unverified, not policy or proof. Call `remember`
before yielding when a specific interface decision must survive a context reset.
Tool results are retained in per-attempt artifacts with explicit excerpt labels and
hashes when shortened. Detailed logs do not become everyone's prompt history.

## 4. Selective collaboration tools

These extend the existing JSON-action protocol. Return one action object, not a chat
transcript or free-form progress report.

```json
{"action":"inspect","relation":"dependencies","after":"","limit":4}
```

Relations: `children`, `parent`, `peers`, `dependencies`, `dependents`. Results are sorted
by stable task ID and include total count and `next_after`. An optional `task_id` inspects
an owned descendant's relations, one bounded page at a time:

```json
{"action":"inspect","task_id":"local-integrator-id","relation":"children","limit":4}
```

There is no global transcript tool. Cards expose recorded lifecycle state, a short
unverified summary, the number of omitted uncertainties, evidence/artifact counts and
code-computed subtree counters. A coordinator can inspect descendant evidence directly
when a summary is insufficient instead of asking an already completed child to repeat
its whole conversation.

```json
{"action":"result","task_id":"leaf-id","section":"evidence","after":"","limit":2}
```

Sections are `artifacts`, `evidence`, `uncertainties`, `summary`. Artifact pages use a
path cursor; other sections use an integer-offset string. Always use the returned cursor.
Recorded evidence includes verdict, input fingerprint, artifact reference and a bounded,
labeled details excerpt. Missing records return UNKNOWN. Full logs remain retained
operator artifacts; native project-file reads deliberately exclude private control
state. Result hashes are recorded-at-integration observations, not automatic proof that
a file still matches after an external edit.

```json
{"action":"message","recipient":"related-task-id","content":"API finding with exact file/function reference"}
{"action":"inbox","after":0,"limit":4}
{"action":"remember","note":"Interface v3; check src/api.py and gate integration","expected_revision":0}
```

Native message edges are immediate parent/child, siblings, or explicit dependency
endpoints. Descendant **read** permission does not imply permission to broadcast to
all descendants. Unparented unrelated tasks are not implicitly peers. Each sender has
a lifetime 100-message ceiling; recipients have pending-message backpressure. Terminal
recipients reject new native messages. A finding outside the local collaboration graph
must be routed to a live related coordinator or addressed through an approved task graph.

A message is queued before it is delivered. Its durable cursor advances only after a
successful model request actually included that message. Failed requests do not consume
mail; fitting a later message cannot skip an earlier omitted message. A native worker
cannot finish while known pending mail remains undelivered. Delivery is not proof of
understanding or execution. No end-to-end exactly-once external side-effect guarantee
is made.

## 5. Scheduling, fairness and context reset

An idle slot claims eligible work atomically. Prerequisites, task budgets, active writer
scopes and the per-cell concurrency ceiling are enforced. Lower numeric priority wins;
among equal-priority candidates, less-loaded cells are preferred. This is bounded
load balancing, not LLM negotiation or an unimplemented auction algorithm.

One excessively broad task can still be a serial bottleneck. An agent may decompose
before writing; it cannot exceed its tool-round or wall-time budget by keeping a long
conversation alive. Coordination is local and event-driven, while code handles polling,
leases and reports. Waiting parents do not occupy execution slots or run periodic LLM
status meetings.

## 6. Fixed reporting and honest evidence

Report schema version two has 13 tables, always in the same order:
System, Tasks, Agents, Connections, Dependencies, Quality, Incidents, Artifacts, Budget,
Hygiene, Hierarchy, Contexts, Mailboxes.

Hierarchy rows separate a coordinator's own gate result from leaf counts and descendant
blockers. Cross-dependency edges do not double-count leaves. Context rows show admitted
request counts, peak measured bytes, recorded ceilings and row-wise bounds checks.
Mailbox rows show pending counts, delivery cursors and note revisions. None is generated
by an LLM. Unconfigured checks and unverified claims remain UNKNOWN.

The read-only dashboard can display a large table without placing that table in an
agent's model context. Its JSON/HTML/Markdown snapshots remain projections of durable
state, not independent authorities. Fixed schemas do not imply factual certainty where
evidence is missing.

## 7. Reproduce the mechanics test

```bash
python examples/hierarchy_demo.py --output ./hierarchy-fixture \
  --leaves 512 --fanout 8 --workers 64
future-control --project ./hierarchy-fixture status
future-control --project ./hierarchy-fixture serve --port 8765
```

Use an empty output directory. This demonstration performs no network or paid LLM calls.
It uses scripted responses with actual scheduling, workspace creation, gated integration
machinery and byte auditing. Read-only fixture tasks have no semantic acceptance gate,
so their task-quality verdict stays UNKNOWN. The demonstration's PASS refers only to
its declared orchestration checks. It is not a 512-agent software-engineering benchmark.

The supervisor is deliberately stopped on fixture completion; the stored dashboard
therefore shows STOPPED, not a pretend live system. For real work, use your approved
model endpoint, protected project tests, bounded budgets and a disposable checkout.

## 8. Limits that remain

The implementation uses local SQLite, synchronous snapshot/hash work, one supervisor
and serialized integration. Filesystem copying, a shared API rate limit, expensive tests
or tightly coupled tasks can dominate runtime. Hundreds of logical tasks do not imply
hundreds of useful simultaneous workers. No multi-host, long-duration, large-repository
or hosted-model success-rate claim is established by the included fixture.

A stronger deployment could use distributed workers and a transactional service, but
that is not shipped. Similarly, this release does not implement arbitrary skill-based
bidding, dynamic topology learning, automatic policy changes, autonomous deployment,
or an OS sandbox. Existing cancellation, budgets, protected tests and safe-recovery
boundaries remain in force.
