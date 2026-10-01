# Future-Code Evidence Fabric

## Purpose

Evidence Fabric is an additive semantic and evidence plane on top of the existing
Foundry/Swarm control plane. It does **not** create a second scheduler and it does
not give an LLM authority over leases, budgets, PASS, integration, protected
paths, or remote side effects.

The core invariant is:

> goals and evidence are durable; workers are replaceable.

The authoritative execution graph remains `tasks` + `spawn_edges`. Foundry
continues to own leases, fences, verification, admission, integration and
recovery. Evidence Fabric projects that execution into a goal/evidence graph and
provides host-computed scheduling priors.

## New durable entities

- `fabric_goals`: durable sub-goals bound to immutable task specifications.
- `fabric_goal_edges`: dependency and decomposition relationships.
- `fabric_evidence`: machine/verifier/experiment evidence with provenance and
  explicit strength.
- `fabric_conflicts`: contradictory strong evidence. Conflict creates an
  adjudication opportunity; it is never resolved by majority vote.
- `fabric_experience`: compact reusable execution outcomes indexed by a
  topology/task signature rather than conversation text.
- `fabric_allocations`: host-computed resource scores used as a scheduling
  prior.
- `fabric_domain_packs`: immutable domain contracts for goal/evidence types,
  validators, adjudicators and success policy.

## Evidence-aware resource allocation

The allocator deliberately does **not** accept model-authored feasibility
scores. Its current score is computed from observable state:

```text
score =
  3.0 * critical-path importance
+ 0.6 * bounded exploration / uncertainty
+ 2.0 * historical verified yield for the same task signature
+ 0.8 * strategy novelty
+ 1.5 * verified dependency/evidence strength
- 3.0 * repeated-failure penalty
- 2.0 * resource-spent penalty
```

The score only changes ready-task ordering. It cannot make a blocked task ready,
override scope conflicts, expand budgets, bypass verification, or declare
success. Existing operator priority and critical-path rank remain deterministic
tie-breakers.

## Conflict adjudication

Two strong opposing evidence records for the same goal create a durable OPEN
conflict. `adjudicationTask()` constructs a proposal whose acceptance criteria
require a machine-checkable discriminator: a minimal reproduction,
counterexample, differential test, or discriminating experiment.

The proposal is **not inserted directly into the scheduler**. It must enter
through the existing reviewed/dynamic-DAG admission path, preserving one
authority boundary.

## Execution experience

Terminal PASS/FAIL tasks produce compact experience records containing:

- structural task signature;
- graph/scope topology;
- outcome and independent evidence strength;
- measured duration/tokens/cost when available;
- spawned-work and failure-strategy fingerprints.

This is intentionally different from chat memory. A future task can retrieve
verified priors without replaying old conversations, and every reused strategy
must still pass the current verifier.

## Tool Effect Contract v2

Every Swarm tool has an explicit side-effect contract:

- reads: replay-safe, no compensation;
- worktree writes: state-bound, snapshot rollback;
- checks: replay behavior comes from the pinned check contract;
- `spawn_tasks`: durable control-plane request identity;
- `run_job`: external effect with stable job key and explicit reconciliation.

The driver records this contract before execution. It complements the existing
schema/permission checks; it does not weaken them.

## Domain packs

The first built-in contract templates are:

- `software-engineering`;
- `ml-research`;
- `scientific-computing`.

A domain pack is immutable under a name. A semantic contract change must use a
new versioned name. Packs currently define evidence/validation vocabulary and
success policy; they do not execute arbitrary plugin code.

## Scaling boundary

This PR intentionally keeps the current single authoritative coordinator and
local SQLite control store. Multi-host workers remain disposable execution
accelerators. Moving the authoritative metadata store to a distributed backend
should happen only after real workload measurements show that the current
control plane is the bottleneck.

## Productization boundary

The repository README identifies much of the mirrored CLI snapshot as research
material from another product and does not provide a root license for that
snapshot. Commercial productization should therefore separate the original
Foundry/Swarm/Evidence-Fabric work into a clean repository with explicit
provenance and licensing rather than treating the mirrored snapshot as a
product codebase.
