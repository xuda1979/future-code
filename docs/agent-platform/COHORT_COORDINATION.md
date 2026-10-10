# Cohort coordination for large research runs

Many persistent task instances can reuse a small set of external-model profiles.
The current bounds are 100,000 tasks per contract, 32 profiles and 256 concurrent
Foundry attempts / requests per configured provider pool. These are configuration
ceilings, not measured live-model throughput. A 3,000-task synthetic regression
checks bounded communication and indexed paging; it does not demonstrate 3,000
simultaneous model calls or better mathematical research outcomes.

## Research organization

Assign separate cohorts to constructive approaches, counterexample search and
independent reproduction. Give them different goals, inputs and permitted tools.
Explicit DAG tasks assemble promising results and run integration checks. Cohort
notes never release a dependency, modify an acceptance predicate or grant a file
scope. The host remains the only scheduler and acceptance authority.

Add the optional policy to an existing Swarm configuration:

```json
{
  "coordination": {
    "cohorts": {
      "constructive": { "maxConcurrent": 48 },
      "adversarial": { "maxConcurrent": 16 },
      "reproduction": { "maxConcurrent": 16 }
    },
    "maxFindingsPerTask": 8,
    "maxDigestBytes": 8192
  }
}
```

Every agent profile must have a `cohort` from that roster. Profiles permitted to
communicate add `publish_finding` and `read_findings` to their tool capabilities.
The policy is pinned in the worker/verifier identities. Existing configurations
without `coordination` retain their behavior and do not install a cohort board.

`maxConcurrent` caps execution episodes in each cohort across the state store's
runs. A busy cohort defers before opening a thread, workspace or model request.
Foundry persists the continuation and frees its execution slot; this does not
consume a failed implementation attempt. Capacity is transactional across SQLite
handles. Authoritative task fences exclude obsolete leases, and exact-fence
release prevents an old episode from releasing a replacement. Execution releases
its cohort slot on completion, cancellation or deferral. Verification remains
bounded by the global Foundry parallelism ceiling.

These are static caps. They protect alternate research directions from one
cohort consuming every execution episode, provided the admitted DAG gives those
directions eligible tasks and enough global slots. They do not guarantee weighted
fairness or implement automatic cohort-budget redistribution. Existing
`adaptive-critical-path` scheduling uses host-observed verified durations and
evidence-allocation hints to order eligible tasks; it retains priority,
dependency, scope and hard-budget constraints. To move more resources to a
productive strategy, admit an explicitly budgeted follow-up DAG through the
existing supervision/replanning path. Do not let model self-confidence resize
budgets or serve as acceptance evidence.

## Bounded communication and cross-cohort reuse

An agent publishes a short note:

```json
{
  "id": "boundary-case-01",
  "audience": "shared",
  "kind": "counterexample",
  "summary": "A boundary-case experiment suggests a missing assumption; independently reproduce it.",
  "receipts": []
}
```

`publish_finding` allows at most 2,048 UTF-8 bytes of summary, eight owned receipt
references and the configured number of findings per task. The caller's profile
determines the cohort. A task-owned finding ID is immutable: identical retries
reuse it, changed input or a changed patch requires a new ID. Category labels
such as `result` and `counterexample` are agent hypotheses, never judgments.

All notes are visible within the assigned cohort. `audience: "shared"` also
requests cross-cohort export. The host exports it only when the source task
passes independent checks and its accepted patch exactly matches the checkpoint
at publication. Superseded patches and failed tasks cannot export. Source
acceptance and export commit in one SQLite transaction; a crash cannot leave a
PASS without its export or an export without that PASS. The shared stream has
its own acceptance-time cursor, so a task that passes later is not skipped by an
earlier reader. Append-only records preserve provenance.

`read_findings` accepts `audience`, optional `after` and `limit` (1–20). Its
queries use `(run, cohort, seq)` or `(run, seq)` indexes and fetch at most
`limit + 1` rows. Each digest fits both `maxDigestBytes` and one quarter of the
thread's pinned admitted context envelope. An oversized single note becomes an
explicitly labeled preview, with an owned `findingReceipt` for `recall` of the
complete published note. It never loads every agent's transcript into a prompt.
Keep separate cursors for cohort and shared streams; continue while `hasMore`.

Shared notes carry `sourceArtifactHash`, `sourceEvidenceHash` and
`sourceAcceptance: "TASK_CHECKS_PASSED"`. Reuse revalidates the exact task,
contract, recipe, verifier, evidence and referenced patch bytes. Hash drift or
corrupt evidence fails closed. The note always retains
`summaryTrust: "UNVERIFIED"`: a passing task artifact does not certify arbitrary
prose or prove a mathematical theorem. Shared receipt references do not grant
access to the publisher's private receipt bodies. File reads retain their
existing scopes. Formal support/refutation uses the versioned claim protocol
and a machine-checkable discriminator, with stale propagation on revision.

## Context and hallucination controls

The task capsule pins the goal, acceptance and verified dependency projections.
Provider input accounting covers the serialized system prompt, tool definitions
and messages. `contextBytes` bounds UTF-8 request size; it is not an exact model
token count. `maxOutputTokens` independently bounds requested generation. All
messages and full tool outputs stay in the durable journal / artifact store.
Complete old assistant/tool exchanges retire from working context; a bounded
`save_progress` note and owned `recall` receipts support later reconstruction.
Mandatory task and acceptance text is never silently truncated. An oversized
decision problem must be split or given a newly admitted budget.

Cohort sharing adds a bounded evidence-discovery channel. It neither changes
claim status nor substitutes consensus for verification. Useful next steps are
separate tasks for counterexample search, reproduction, formal proof checking
and synthesis. Source changes require revalidation, contradictory strong
evidence stays explicit, and missing evidence keeps the result unknown.

## Operational checks

Run `node --experimental-strip-types --test tests/foundry/cohort-coordination.test.ts`
for capacity/fence checks, negative sharing controls, acceptance/export rollback,
late-arrival pagination, digest bounds, source corruption, driver integration
and the 3,000-task synthetic communication test. Run all five Foundry/Swarm
verification commands listed in `AGENTS.md` before opening a PR.

Before raising real concurrency, measure queue latency, provider rate limits,
encoded input bytes, verified tasks per request, source-reuse yield and repeated
failures. Compare paired runs with equal objectives, checks and spend budgets.
Increasing agent count alone does not establish improved research productivity.
