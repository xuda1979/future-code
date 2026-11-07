# RSI implementation review — 2026-11-07

Scope: runtime source at `582d095`, with emphasis on unattended, project-neutral
recursive self-improvement. The target is an R&D operating system whose changes
remain measurable, recoverable and independently checked. This review does not
equate passing synthetic tests with improved research intelligence.

## Findings and implemented repairs

| Finding | Consequence | Repair and regression evidence |
| --- | --- | --- |
| `evaluate` retained only completed pairs and created new random runs on every call. | A crash after the first arm lost its experiment binding; a restart spent again and discarded partial-work accounting. | Freeze every arm ID before execution; add `resumeEvaluation` and `evaluation-resume`; reuse scheduler fencing and stable run admission. Tests reopen SQLite, terminate a real process between arms, and confirm original run IDs and attempt costs survive. |
| Evaluation JSON updates unconditionally replaced an unpromoted receipt. | Concurrent resumes could overwrite newer experiment progress. | Compare-and-swap the previous receipt hash. A two-connection test proves four unique arms/four executions and rejection of the stale writer. |
| `suggest` ignored prior comparisons and always preferred the same parallelism candidate. | Repeated `evolve` calls could re-test a rejected hypothesis indefinitely and starve the context-allocation alternative. | Scope completed-trial memory to baseline plus frozen protocol; try the next supported knob. Explicit manual evaluation can still request another trial. |
| `score` demanded `accepted === protocol.tasks.length`, while promotion compared every runtime task against the root graph. | A valid root with verified dynamic children was rejected, undermining adaptive decomposition. | Compare exact root specs, authenticate all accepted child evidence, require all actual tasks in a terminal PASS to be complete. Tests allow different child counts in each arm and reject deleted child evidence and an injected unfinished child invisible in the summary. |
| `Scheduler.start` replay used locale sorting while SQLite used binary ID ordering. | Valid mixed-case task IDs could fail stable-run recovery. | Use the same deterministic ID comparison as task-graph verification; mixed-case replay test. |
| `evolve` only ran one disposable suggestion/evaluation. | There was no host-managed bounded sequence that reused pending work and learned from failed trials. | Add `maxCycles` / `--max-cycles`, explicit stop reasons, optional authenticated auto-promotion, and pending/admitted receipt reuse. CLI tests exercise resume, cycle bounds, missing evidence and exhausted hypotheses. |
| RSI snapshots exited successfully when measured suites failed and followed session-store directory symlinks. | Supervisors could mistake failed verification for a successful snapshot; cyclic links inflated counts or caused excessive traversal. | Return failure after preserving the row; record exit/signal/error diagnostics; count stores once without following symlinks. Production-script fixture tests cover a failing lane and a cyclic directory link. |

## Architecture boundaries

The shared mechanism contains no quantum, chip, trading, biology or other domain
rules. Project-specific tasks, data, evaluators and evidence semantics remain in
adapters and immutable contracts. Root objectives, acceptance checks, resource
ceilings, environment identity, evaluation metric and minimum gain cannot be
changed by the automatic recipe loop. A model response does not accept a task.

Runtime execution remains authoritative in `tasks` and `spawn_edges`. The new
evaluation arm list only binds experiments to those runs. It is not a second
scheduler. It creates no extra provider calls for completed arms, and an unknown
interrupted cost cannot become zero. A stale baseline or missing accepted
artifact stops further reuse. Promotion still rechecks persisted summaries,
all accepted artifacts, contract/protocol hashes, lineage and receipt consumption.

No process-level side effects, package dependencies, model training, acceptance
relaxation, permission changes, merge or deployment are added by this change.
The Foundry comparison is an engineering admission check. It does not provide
statistical significance, a protected holdout service or production canaries.

## Remaining work toward stronger RSI

1. **General code evolution.** The automatic controller optimizes validated
   execution knobs; it does not yet propose arbitrary changes to its own runtime,
   rebuild them in isolated pinned worktrees, independently evaluate them on
   protected projects, integrate them, and supervise a rollback canary. Implement
   that as an adapter/host workflow with explicit artifact lineage before claiming
   autonomous runtime rewriting.
2. **Legacy harness adaptation.** `src/harness/improver` applies bounded heuristic
   adjustments without a paired baseline comparison. Its header now describes
   this accurately. Keep such adjustments distinct from measured Foundry admission;
   migrating the legacy CLI requires a separate compatibility and persistence plan.
3. **Generalization and deep reasoning evidence.** Use held-out projects with
   frozen success, cost, latency and reliability metrics. Include difficult tasks
   that require deeper investigation and short tasks that penalize unnecessary
   work. The current rules infer possible parallelism/context benefits from
   workload structure; they do not establish a learned reasoning policy.
4. **Budgets and continuous supervision.** Cycle count, task/attempt limits and
   timeout ceilings bound this controller. Campaign-wide money/token/wall budgets,
   cross-host ownership and calibrated post-promotion rollback need their own
   contracts. Exhausted hypotheses require new evidence or a new admitted search
   policy; a supervisor should wait rather than repeat unchanged work.
5. **Measurement design.** Paired counterbalancing and complete-cost requirements
   reduce common false claims. Add uncertainty/sample-size protocols and account
   for search/evaluation development cost before claiming a general productivity
   gain. Snapshot suite times and directory bytes remain telemetry, not acceptance.

## Validation

Focused command:

```sh
node --experimental-strip-types --test tests/foundry/evolution.test.ts \
  tests/foundry/evolution-cli.test.ts tests/foundry/rsi-snapshot.test.ts
```

The focused suite covers the actual host runtime and CLI with temporary stores,
real worker processes, hard process death, concurrent connections, negative
controls and synthetic host measurements. It uses no paid provider or accelerator.
The required broader gates are `test-correctness`, `test-resilience`,
`test-foundry`, `test-swarm` and `test-commands` via their canonical Node launchers.
Record exact outcomes in the PR; none of these tests measures live-LLM research
productivity. Revert the PR commit to restore code behavior; additive arm binding
fields and the evaluation index do not require deleting existing state.
