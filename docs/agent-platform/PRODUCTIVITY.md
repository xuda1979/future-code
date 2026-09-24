# Productivity controls for Harness Foundry

This extends `src/harness/foundry/`, the existing single-host durable agent
runtime. It does not replace `QueryEngine.ts`, switch the interactive assistant
to Foundry, or make an external Claude session use this scheduler automatically.
Your coding-agent worker and independent verifier must already be wired through
Foundry's `Driver` or pinned `CommandDriver` interface. The supplied upstream
demo is an offline fixture, not a coding model.

## Execution model

A planner supplies a dependency graph of bounded tasks. The host executes this
loop without another model call for scheduling or status:

```text
validated task DAG + immutable contract
  -> compile dependency ranks and bounded per-task context reservations
  -> atomically claim an independent batch of ready tasks
  -> independent agents: execute -> independent verifier
  -> PASS publishes an authenticated artifact and releases dependants
  -> refill slots after individual completion, not a whole batch barrier
```

Use model intelligence to decompose and solve tasks, not to repeatedly narrate
which agent should run next. Task quality and final integration tests remain
more important than the number of concurrent agents.

## Implemented changes

| Control | Actual behavior | Default and limits |
|---|---|---|
| Batched claims | `Scheduler.claimMany` checks all reservations in one SQLite transaction. Immutable specifications, ranks and allocations are cached per scheduler/run. Mutable states are always reread. | Used by `runTasks`; legacy `claim` remains supported. |
| Critical-path scheduling | Rank is own estimated duration plus the longest downstream duration. Explicit task priority wins first, then rank, then task ID. | Opt in with `scheduling: "critical-path"`. Omitted estimates count as one unit, producing depth-based ordering. |
| Read/write-aware reservations | A writer excludes overlapping readers and writers. Readers may share scopes. | `readScope` is optional; existing `writeScope` semantics remain. |
| Aggregate context reservations | Admission caps the sum of running tasks' allocated capsule budgets. A budget that cannot ever fit is rejected before creating a run. | Optional `maxInFlightContextBytes`. This is not RAM, billed tokens or a complete provider-context limit. |
| Explicit dependency views | Selected RFC 6901 pointers carry exact values from a verified dependency artifact. The full artifact stays in the content-addressed store. | Optional `Task.dependencyViews`; omitted dependencies remain fully inline. |
| Progress-aware deadline | Distinct adapter fingerprints renew an idle timer. Repeats, including alternating repeats, do not renew it. Worker and verifier stages are both covered. | Optional `noProgressMs`; never extends the hard attempt deadline. |
| Repeated-failure stop | Persisted identical consecutive failure fingerprints stop retries early. Runtime fingerprints include stage, error, candidate artifact and verification checks. | Optional `maxRepeatedFailures`; different candidates remain eligible, subject to total attempts. |
| Bounded coordination | Same-process completions refill immediately. Spare local slots check for remote completion within 250 ms. Empty local queues back off from 25 to 250 ms. | Single-host SQLite, not a distributed cluster service. |

The context ceiling bug is also fixed: explicit and priority-weighted allocations
cannot exceed the immutable contract's context ceiling. Invalid task budgets are
rejected. An irreparable capsule overflow or missing projected field fails at
preparation rather than launching/retrying the same model input repeatedly.
A `priorityContextShare` of 1 no longer allocates every task twice the base budget.

The scheduler still scans task states on refill; this is not a claim of constant
time scheduling or unlimited scalability. Ranking is a heuristic, not an optimal
scheduler. Incorrect estimates and priority overrides can reduce its benefit.

## Enable through the existing admission workflow

Existing recipe hashes and omitted-field policies remain usable. New settings
belong to a proposed recipe, not a rewrite of the immutable contract or gates.
Do not hot-swap old and new runtime binaries while a run is active. Pause, retain
the run ID and state directory, upgrade all processes sharing the store, then
resume. The telemetry table is additive; existing data is not deleted.

From the repository root, with an already initialized Foundry store:

```bash
node --experimental-strip-types src/harness/foundry/cli.ts propose \
  --root .future-code/foundry \
  --changes examples/foundry/productivity-candidate.json
```

The example changes are compatible with `examples/foundry/spec.json`: four
workers and a 32 KiB aggregate reservation for four 8 KiB capsules. They are not
universal settings; admission rejects values above your own frozen limits.
The proposal prints a candidate hash but does not activate it.

```bash
node --experimental-strip-types src/harness/foundry/cli.ts evaluate \
  --root .future-code/foundry --candidate CANDIDATE_HASH \
  --protocol YOUR_FROZEN_PROTOCOL.json --allow-exec

# Only after inspecting an ADMIT result:
node --experimental-strip-types src/harness/foundry/cli.ts promote \
  --root .future-code/foundry --evaluation EVALUATION_ID --confirm

node --experimental-strip-types src/harness/foundry/cli.ts run \
  --root .future-code/foundry --tasks YOUR_TASKS.json --allow-exec
```

Use a protocol containing representative real coding tasks, independent
acceptance tests and pinned worker/verifier implementations. Use the same task
graph, model, input revision and acceptance gates in both arms. Do not promote
based on the synthetic microbenchmark. Changes to dependency views are task
contract changes, so freeze them consistently before comparing recipe arms.
A checker should include final integrated tests, not just per-file unit tests.

## Task contracts for large software projects

Prefer one testable deliverable per task: an interface, one independent module,
a migration, a failing regression reproduction, or final integration. Specify
read and write scopes before concurrent execution. An interface-first graph
allows API, storage and UI implementation to proceed after the shared interface
has passed verification; integration depends on all three accepted artifacts.

Do not give every agent the whole repository transcript. Put the goal,
acceptance predicates, relevant source excerpts or pinned source references,
interface requirements, and exact deliverable format in its capsule. The
runtime will not invent missing project knowledge or subdivide the graph for
you. Make tasks smaller when their mandatory information exceeds the budget.
Keep slow tasks that genuinely require extended computation; a duration outlier
alone is not evidence that the work is wrong.

Example task, assuming a direct predecessor `api-contract` produces an artifact
with `api` and `invariants` fields:

```json
{
  "id": "implement-storage",
  "goal": "Implement storage against the verified interface; preserve existing behavior.",
  "acceptance": ["storage contract tests pass", "relevant regression tests pass"],
  "dependencies": ["api-contract"],
  "readScope": ["src/contracts"],
  "writeScope": ["src/storage", "tests/storage"],
  "estimatedDurationMs": 60000,
  "contextBudget": 8192,
  "dependencyViews": { "api-contract": ["/api", "/invariants"] },
  "input": { "testCommand": ["npm", "test", "--", "storage"] }
}
```

This is a task-schema example for your coding adapter, not input for the offline
add-function demo. The host does not execute `input.testCommand` automatically.
Its estimate must be within the contract timeout ceiling. Avoid mixing a few
millisecond estimates with omitted estimates (which default to one unit).

A projected dependency arrives as:

```json
{
  "taskId": "api-contract",
  "artifactHash": "SHA256_OF_THE_FULL_VERIFIED_ARTIFACT",
  "artifact": { "/api": "exact selected value", "/invariants": [] },
  "view": { "pointers": ["/api", "/invariants"], "hash": "SHA256_OF_PROJECTED_ARTIFACT" }
}
```

`artifactHash` authenticates the original artifact, not the projected map.
`view.hash` authenticates that map. Missing paths and corrupted source artifacts
fail closed; no goal, acceptance predicate, or selected value is truncated.
The driver and verifier must understand this opt-in representation. File hashes
without file content are not a substitute for a working retrieval mechanism.

## Progress reporting and early bug containment

Enable a watchdog only after the worker AND verifier can report useful progress,
or choose an idle allowance above their longest legitimate silent operation.
For example, a recipe with `attempts: 3` and `timeoutMs: 180000` could propose
`noProgressMs: 30000` and `maxRepeatedFailures: 2`, provided its contract admits
those values. Thirty seconds is an example, not a measured recommendation.

An in-process adapter receives an optional third argument:

```typescript
async function execute(capsule, signal, control) {
  // Perform bounded tool calls in your existing adapter.
  const result = await runFocusedTests({ signal });
  control?.progress(`test:${result.suite}:${result.revisionHash}`);
  // Return the usual artifact; this event is NOT a PASS certificate.
  return buildWorkerResult(result);
}
```

Pinned subprocess adapters can write bounded progress records to stderr. Keep
stdout as the original single JSON result:

```javascript
process.stderr.write(
  'FUTURE_CODE_PROGRESS ' + JSON.stringify({ fingerprint: 'test:storage:revision-hash' }) + '\n'
);
```

A reserved record is at most 1024 bytes, its fingerprint at most 256 UTF-8 bytes.
Malformed reserved records fail the invocation when progress parsing is enabled.
All stdout, stderr and progress bytes share the original output budget. The
novelty set retains at most 1024 distinct fingerprints per attempt. This prevents
unbounded heartbeat state; it does not authenticate model claims of progress.
Do not use timestamps or random IDs as fingerprints: those can mask a stall.

Progress never satisfies a correctness gate, publishes an artifact, extends the
absolute deadline, or unblocks a dependant. Use independent tests and verified
artifact hashes for those transitions. Identical verification failures stop
early; different candidate artifacts still receive their allowed verification.
Only adapter-observed tokens/cost count as measurements, never model JSON usage.

## Verification and measurement

Run the added test suite plus the selected existing regression suites:

```bash
node --experimental-strip-types --test \
  tests/foundry/productivity.test.ts tests/foundry/kernel.test.ts \
  tests/foundry/commands.test.ts tests/foundry/lifecycle.test.ts
node --experimental-strip-types scripts/bench-foundry-productivity.mjs
```

The benchmark runs the actual scheduler, runtime, SQLite store and artifact
verification boundary. It reports three different quantities separately:

* Virtual-clock scheduling of an intentionally skewed 72-task DAG at eight
  workers, with identical tasks and durations under both policies.
* Actual serialized capsule bytes for full versus explicitly selected dependency
  fields, checking retained API equality and the full source hash.
* Real-clock execution of 1000 synthetic arithmetic workers, three repetitions,
  16 workers, independent arithmetic checks, including artifact and SQLite I/O.

Compare the third quantity with an unmodified source checkout using:

```bash
node --experimental-strip-types scripts/bench-foundry-productivity.mjs \
  --runtime-root /path/to/unmodified/future-code --overhead-only \
  --tasks 1000 --repetitions 3
```

These tests make **zero model calls**. They cannot establish a Claude latency,
software-quality or end-to-end coding-productivity improvement. Short synthetic
workers magnify host overhead; long model calls may show much smaller gains.
Report every repetition and reject a speedup that reduces accepted quality.
Run baseline/candidate real-project trials in alternating order with unchanged
model settings and guardrails before deployment.

`attempt_telemetry.context_bytes` records the prepared capsule bytes per attempt,
not the number of tokens billed or the total bytes a driver later retrieves.
`progress_count`, `last_progress_at` and `failure_fingerprint` are diagnostic.
Existing `RunSummary.progressDensity` scoring is intentionally unchanged; it uses
the old allocated-budget proxy, not this new measured-input telemetry.

## Boundaries

Read/write scopes are logical scheduler reservations within ONE run. They are
not an OS sandbox, repository-wide lock across independent runs, symlink defense,
or a guarantee against a worker that ignores its scope. Use one run per shared
workspace and isolated worktrees/containers for real coding workers. Merging,
path enforcement and sandbox construction are NOT implemented by this patch.

Lease fencing rejects stale returned results; it cannot undo a timed-out
worker's external side effects. Arbitrary in-process drivers must cooperate with
AbortSignal. The command adapter kills subprocess groups, but the runtime's
abort race is not a proof that every descendant has already stopped before a
replacement is admitted. Do not rely on logical locks alone for physical write
isolation. Synchronous code that blocks the JS event loop also blocks timers.

No automatic semantic task splitting, model routing, speculative duplicate
coding agents, result cache, online model training or distributed work stealing
is claimed here. Blind speculation was deliberately avoided because it spends
additional model tokens and complicates write isolation. The patch leaves the
independent-verification requirement and promotion contract intact.

## Research basis

The implementation combines established ideas rather than claiming each
mechanism is a new invention. Relevant primary engineering reports include:

- Anthropic, *How we built our multi-agent research system*, 2025-06-13:
  https://www.anthropic.com/engineering/multi-agent-research-system
  Narrow delegation, independent parallel work, artifact handoffs and the cost
  of coordinating agents; coding has fewer independent branches than research.
- Anthropic, *Building a C compiler with a team of parallel Claudes*, 2026-02-05:
  https://www.anthropic.com/engineering/building-c-compiler
  Task isolation and strong verifiers matter; many workers pursuing one shared
  bottleneck can duplicate work rather than accelerate it.
- Anthropic, *Effective context engineering for AI agents*, 2025-09-29:
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  Retain high-signal task context and use progressive disclosure instead of
  accumulating an ever-growing transcript.

The repository-specific contribution is integrating those principles into
Foundry's durable lease, context, evidence and admission boundaries, with
executable regression tests and explicitly separated measurements.
