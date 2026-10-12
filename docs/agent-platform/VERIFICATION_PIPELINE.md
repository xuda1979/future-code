# Independent verification pipeline

## Decision and scope

The two productivity reviews identify a useful objective: reduce the time to a
verified, integrated result while keeping the acceptance contract fixed. Main
`0790218` already contains bounded local/remote file batches, durable recovery,
thread context retirement, intervention measurements, and separate task
worktrees. Reimplementing those mechanisms would add maintenance cost.

This change addresses two remaining gaps in Foundry/Swarm:

- New threads pin their permitted check names in the immutable task message.
  Context retirement preserves those names together with task acceptance,
  scopes and dependencies. The prompt also states that final integration is
  required. Global integration check lists stay in the host configuration, so
  unrelated check names do not enlarge every worker context. Existing threads
  retain their original prompt and replay identity.
- Task acceptance and final integration can run explicitly independent named
  checks concurrently in private worktrees, with a small, pinned concurrency
  limit. Every check still executes against the exact assembled candidate tree.

The terminal query, `/goal`, and transport implementation are separate paths.
This change does not replace those runtimes or alter the frozen context
retirement research protocol.

## Configuration

Add the following fields to an operator-authored Swarm specification:

```json
{
  "verification": { "parallelism": 4 },
  "checks": {
    "types": {
      "argv": ["$NODE", "checks/types.mjs"],
      "files": ["checks/types.mjs"],
      "replaySafe": true,
      "parallelSafe": true
    },
    "unit": {
      "argv": ["$NODE", "checks/unit.mjs"],
      "files": ["checks/unit.mjs"],
      "replaySafe": true,
      "parallelSafe": true
    }
  }
}
```

This is a configuration fragment; existing agents, checks, scopes and budgets
are still required. `parallelism` is an integer from 1 to 8 and defaults to 1.
`parallelSafe` is a stronger operator assertion than replay safety: the check
must not consume another check's generated outputs, rely on its ordering,
compete for a fixed port, or modify shared external state. Private worktrees
isolate files; they are not security sandboxes or external-resource locks.
Configure dependencies and toolchains so each isolated check can start from a
fresh checkout. Ignored build output is private and is discarded after checking.

The cap includes each check's preparation, command execution and cleanup. It is
per verifier; concurrent task verifiers multiply demand. With four active task
verifiers and width four, up to sixteen check workers may be active. Operators
must select a width that fits their CPU, memory and external resource budget.

Only adjacent eligible checks are grouped. For `types, unit, build, package`,
marking only `types` and `unit` independent permits their overlap, then waits for
both before starting `build`. Unmarked checks remain ordered and share the main
verification workspace, retaining prerequisite outputs. An omitted policy,
width one, or a single eligible check uses the original serial path.

Exploratory `run_check` tools retain their existing ordered/replay-safe behavior.
They cannot race preceding edits or subsequent remote jobs. Verification creates
no model requests and changes no tool, objective, or provider budgets.

## Acceptance, failures and evidence

The host first reconstructs accepted dependencies plus the candidate patch and
checks its exact canonical delta and scope. Each parallel check starts from a
temporary commit of that assembled Git tree. Reports bind the tree, check name,
exit status, output, source immutability, isolation and elapsed worker time.
Changed tracked source, nonzero exit, timeout, or host/cleanup error prevents
PASS. A missing exit status is recorded as `code: null`.

Task verification gathers all required check diagnostics. Final integration
stops admitting queued checks after a failed report, waits for already launched
workers, and publishes no acceptance receipt or branch. Reports retain configured
order even when completion order differs. Cancellation drains commands and
cleanup before returning. A cleanup failure fails the check and preserves the
orphan for inspection.

Final integration independently runs the configured checks against the combined
patches; worker certificates cannot substitute for that test. The existing
content-addressed integration receipt can still be reused only with unchanged
binding, valid accepted task evidence and an intact resulting Git tree. A hash
attests to content identity, not behavioral correctness.

## Feedback disposition

| Proposal | Assessment and decision |
|---|---|
| AST-aware semantic retirement | Durable receipts and exact patches already exist. AST retention needs language-specific parsers, invalidation and omission tests; defer it rather than treating an AST as runtime proof. |
| Intervention-driven invariants | Existing memory aggregates measured interventions. User corrections and recovery summaries must remain scoped, attributable observations; automatically promoting them to system authority could preserve a mistaken rule. |
| Contract-pinned working sets | Implement permitted check names in the immutable task prompt; existing task acceptance and complete tool/result retirement stay intact. |
| Predictive read-only speculation | Explicit adjacent reads already batch. Prediction needs a bounded cancellation/cache-invalidation design and measured hit rate to justify extra work. |
| Nonblocking test/compile sharding | Implement independent verification and integration checks in bounded private worktrees; keep exploratory effect barriers. |
| Network-adaptive batches | Remote capability negotiation and recovery already exist. Reliable latency/loss measurements and order-aware adaptation are prerequisites for changing batch policy. |
| Isolated candidate exploration | Existing task worktrees and the dynamic DAG isolate scoped candidate work. Competing overlapping patches still need explicit adjudication and integration. |
| HACT certificates in lieu of full tests | Keep certificates as evidence references. Exact tree and configuration bindings permit existing receipt reuse; combined-tree checks remain required. |
| Automatic dependency/AST sharding | Explicit dependencies and scope validation already gate execution. Import graphs alone miss dynamic and external dependencies; automatic decomposition/AST merging needs separate conflict tests. |
| Deterministic early gates | Named checks are now discoverable from the initial prompt. Integration stops queued work after failure. Automatically injecting language-specific edit probes is deferred. |
| Task-tier model routing | Agent profiles already select external models. Automatic routing requires quality/cost measurements on frozen acceptance tasks; neither model size nor task length proves suitability. |
| P95 provider migration | Existing fallbacks, cooldowns and explicit hedging remain. Preemptive migration requires minimum samples, hysteresis and spend accounting; current hedging stays opt-in. |

The engineering review's six recommendations inform the implementation:

| Engineering area | Application |
|---|---|
| Specifications and invariants | Typed/validated/pinned concurrency policy; regressions for scope, exact inputs, resource caps, barriers, failures and cancellation. |
| Bounded contexts and explicit state | Check names stay with the task; the small worker pool has explicit inputs and no global scheduler state. |
| Review and automated gates | One focused runtime change, repository regression gates, and reproducible short/long host workloads. Broader mutation/SAST/dependency tooling needs its own baseline. |
| Living documentation | This decision record explains configuration, trust, ordering, compatibility and rejected shortcuts. |
| Observability | Per-check immutable reports bind exact source trees and elapsed worker time; existing verifier phase timing remains available. Overlapping worker durations are not additive wall time. |
| Continuous debt pruning | Reuse the existing worktree/process/acceptance infrastructure. Wholesale modularization and churn/complexity automation are separate changes that need evidence of a hotspot. |

## Reproduction

Against main `0790218`, baseline/candidate/candidate/baseline order, ten samples
per arm and workload on Node 24.19.0:

| Workload | Baseline median | Candidate median | Checks executed across task + integration |
|---|---:|---:|---:|
| One fast check, original single-check path | 258.45 ms | 230.94 ms | 2 in both |
| Four fast independent checks | 444.09 ms | 321.30 ms | 8 in both |
| Eight independent checks, simulated 250 ms waiting per check | 4,839.99 ms | 1,612.55 ms | 16 in both |

All 60 trials passed independent task and combined-tree acceptance, with two
scripted provider requests each. The delayed case reached four concurrent check
processes. The single-check samples showed no added latency; these small offline
samples do not establish statistical equivalence or a live short-task speedup.
The delayed workload's approximately 3.00× timing ratio includes Git preparation,
process startup, durable journals, task checking and final integration.

Thirteen focused regressions and all five required local gates passed with zero
failures/cancellations: correctness 62 Node plus 15/7 Python; resilience 158 Node
plus 7 Python; Foundry 439; Swarm 164; commands 99. Suites overlap and their test
counts must not be summed as unique coverage. Raw samples, exact source/test/
script hashes and gate-log hashes are in
[the validation record](validation/verification-batching-20261012.json).

```sh
node --experimental-strip-types --test tests/foundry/verification-batching.test.ts
node --experimental-strip-types scripts/bench-verification-batching.mjs --mode serial --runtime-root /path/to/baseline --repetitions 5
node --experimental-strip-types scripts/bench-verification-batching.mjs --mode parallel --repetitions 5
```

Compare baseline/candidate/candidate/baseline order, including a single fast
check and several fast checks. The delayed workload explicitly simulates 250 ms
per check. All trials must independently pass task and combined-tree checks;
provider replies are scripted. These measurements establish host overhead and
parallel-check behavior only. Live research throughput, token/dollar savings,
and superiority over another coding agent require live paired evaluations.
