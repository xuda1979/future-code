# Future-Code Technical Report

**Version:** 2.0  
**Date:** October 2026  
**Status:** Product and architecture report

## Executive summary

Future-Code is a runtime for sustained software development and research using external LLM APIs. Its defining architectural decision is to separate **cognition** from **authority**. Models propose plans, code, tool calls, hypotheses, decompositions, and recovery ideas. A host-owned runtime decides what may execute, what state is durable, what evidence is sufficient, and when work is accepted.

This addresses the failure modes that dominate long-horizon R&D: stalled model loops, repeated failed hypotheses, duplicated remote jobs, provider outages, conflicting subagent edits, context growth, and premature success declarations. Future-Code therefore treats the model as an intelligent but replaceable component inside a governed execution protocol.

> **Models propose. Evidence decides. Future-Code enforces.**

## 1. Core architecture

Future-Code is organized around three planes.

### Cognitive plane

External models perform open-ended reasoning, code generation, decomposition, tool planning, hypothesis formation, and recovery analysis. Different roles may use different configured models. The system does not require a single monolithic manager model.

### Sovereign control plane

The host kernel owns the state that must remain deterministic even when the model is stochastic:

- durable objectives and frozen acceptance contracts;
- task DAGs and bounded dynamic spawn edges;
- read/write scopes;
- leases and fencing generations;
- execution/model/remote-compute budgets;
- provider cooldown state;
- remote-job identity and reconciliation;
- independent verifier identity;
- final integration policy.

Model output is a `Proposal<T>`, not authority. A model's final answer cannot directly mark a task PASS, expand scope, replace a verifier, erase failure history, or redefine a frozen objective.

### Evidence plane

Evidence Fabric stores durable goals, machine observations, immutable artifacts, verifier results, claims, conflicts, adjudication records, execution episodes, and replay receipts. Workers are replaceable; goals and evidence persist.

## 2. Fast tasks and long projects need different policies

Using one runtime policy for every task is a major source of wasted time.

For a simple interactive task, latency is often dominated by unnecessary maximum reasoning, repeated API retries, proxy pacing, process startup, and heavy verification setup. The interactive path should therefore use balanced effort, bounded foreground retry, narrow context, and explicit escalation.

For multi-hour or multi-day objectives, the dominant risks are different: lost state, duplicate external work, stale leases, provider outages, integration conflicts, context explosion, and premature acceptance. Foundry/Swarm therefore uses durable state, independent verification, remote-job reconciliation, bounded recovery, and explicit final integration.

The architectural rule is:

> **Latency policy should depend on task horizon; correctness policy should not.**

The current launcher follows this direction by no longer forcing maximum effort for every request, respecting configured helper/subagent models, bounding interactive persistent retry by default, avoiding legacy request-spacing penalties on routes that do not require them, and preventing a failed stream from falling into a second complete buffered retry loop.

## 3. Sovereign Kernel

A run starts from an explicit contract covering objective, task graph, acceptance gates, budgets, scopes, protected paths, worker/checker identities, and integration policy. A model may propose actions inside that contract but cannot rewrite success when work becomes difficult.

Tasks are durable nodes. Ready tasks are leased. Lease fencing prevents a stale worker from publishing after ownership moves. Existing task specifications remain immutable; dynamic decomposition is represented by explicit spawn edges with delegation, depth, and child-count limits.

This gives the system replayable lineage and makes parallelism visible to the scheduler rather than hiding it inside nested chat loops.

A task PASS is not a project PASS. Final integration reconstructs accepted patches in dependency order, detects conflicts, checks protected verifier sources, runs frozen integration tests, and only then publishes a combined result.

## 4. Foundry and Swarm

Foundry is the governed execution kernel. Swarm adds an external-model coding loop, tools, workspaces, durable sessions, and independent verification.

Each coding task can execute in an isolated Git worktree with declared read/write scope. Context is treated as a budgeted resource: a worker receives its goal, acceptance predicates, relevant source context or authenticated dependency views, and explicit deliverable format rather than the entire project transcript.

Dynamic DAG expansion is valuable only when discovered work is genuinely independent. Future-Code therefore constrains spawning instead of equating more agents with more productivity.

Multi-host workers may accelerate execution, but final acceptance remains coordinator-owned.

## 5. Evidence Fabric and Knowledge Protocol

A chat transcript is not automatically reliable project knowledge.

Future-Code represents durable knowledge as structured evidence:

- goals and dependency relationships;
- machine/verifier/experiment evidence with provenance;
- explicit strong-evidence conflicts;
- content-addressed artifacts;
- execution experience indexed by structural task signatures;
- host-computed resource-allocation priors.

When strong evidence conflicts, the system does not average it away. It creates an adjudication opportunity whose discriminator can be a minimal reproduction, counterexample, differential test, or discriminating experiment. The adjudication task must enter the normal admission path.

Experience records summarize verified outcomes, topology, duration/cost when observed, failure strategy, and spawning behavior. They can guide future work, but every reused strategy must still pass the current verifier.

## 6. Provider and remote-compute resilience

External API failure is modeled as a durable wait rather than a failed coding attempt.

Shared provider routes transition through healthy, open, and half-open states. During cooldown:

- no new model request is reserved for the affected pool;
- workers release capacity instead of sleeping while holding a slot;
- one controlled half-open probe tests recovery;
- an outage epoch prevents a late old success from clearing a newer outage;
- unknown provider spend remains unknown.

Remote jobs use stable identity. If the controller times out, Future-Code reconciles by job key before resubmitting. This avoids the expensive failure mode in which uncertainty becomes duplicate training or simulation.

## 7. Reflection and bounded self-improvement

Self-improvement is useful only if it cannot optimize away the acceptance contract.

Future-Code records objective episodes and can trigger reflection after stagnation, repeated failure, failed quality gates, recovery, or objective completion. Intervention memory stores strategy, context, sample count, uncertainty, and verified outcome.

The intended question is not "what critique sounds intelligent?" but:

> **Which intervention previously improved verified progress under comparable conditions?**

Interventions are advisory and may abstain. They do not gain scheduler authority and cannot alter the frozen acceptance contract.

## 8. Adaptive HACT: verification-evidence virtualization

Adaptive HACT is a research component for systems that already require bounded hierarchical diagnostic evidence.

Stable check identities and candidate/checker/environment bindings define the semantic plane. A separate layout plane can reorder and aggregate trusted records. Layout migration increments a generation fence so stale layout tickets cannot authorize current work.

The cost model uses **completion hyperedges**: the actual sets of checks that become final together. Pairwise similarity can propose an order, but pairwise statistics cannot in general determine hierarchical subtree activation cost. Final layout selection therefore replays full completion sets.

The frozen v5 artifact reports:

- 27 train/validation/held-out synthetic workloads;
- clustered held-out padded-evidence reductions of 23.43%, 10.75%, and 5.56% at 128, 512, and 1,024 checks;
- essentially zero benefit in independent/global controls;
- 36 layout replays of 12 archived source candidates;
- whole-epoch compressed reductions of 41.84% for NetworkX, 4.36% for Toolz, and 18.53% for Future Code versus fixed8;
- exhaustive diagnostic pages reduced from 148 to 95 for the practical learned layout;
- root-status text identical across every replay triple.

These are evidence-representation results, not claims that HACT improves LLM reasoning, provider billing, or physical-WAN latency.

## 9. Evaluation discipline

Future-Code's real-project evaluation protocol freezes source revision, task graph, model, tools, budgets, verifier, and integration checks before comparing candidate recipes.

The system records verified objectives, verified tasks, wall-clock time, real model requests, provider usage when available, unknown requests, cost when trustworthy, and artifact identities.

The methodology rejects several common forms of self-deception:

- a faster incorrect result is not a speedup;
- fewer than three live repetitions are insufficient for a live productivity claim;
- replayed responses cannot establish paid-model token efficiency;
- missing billing remains null/unknown, not zero;
- one project cannot establish a universal comparison with Claude, Codex, Cursor, or another system.

## 10. Security and trust boundaries

Future-Code is a governed runtime, not a complete OS sandbox or Byzantine consensus system.

Git worktrees isolate source state, not hostile processes. The trusted computing base includes protected contract state and independent verification. External providers may continue computing after host cancellation, so unknown external spend remains unknown. HACT generation fencing is not remote attestation.

## 11. Differentiation

| Concern | Simple agent loop | Future-Code |
|---|---|---|
| Objective | prompt text | durable objective + frozen contract |
| Decomposition | model-local plan | host-visible DAG + bounded spawn |
| Concurrency | ad hoc calls | leases, scopes, dependencies, quotas |
| Provider outage | retry/sleep/error | durable cooldown + released capacity |
| Remote uncertainty | resubmit/lose | stable identity + reconcile-first |
| State | conversation | store + journals + artifacts + evidence |
| Success | model says done | independent verifier + integration |
| Learning | prompt edits | measured episodes + intervention memory |
| Evidence delivery | logs/context dump | optional HACT evidence plane |

The economic value is highest where failure is expensive: multi-repository changes, ML training, scientific computing, remote experiments, and long R&D objectives where a duplicated job, lost hypothesis, or premature merge costs far more than one model request.

## 12. Roadmap

Near-term priorities are:

1. automatic FAST/STANDARD/RESEARCH task-horizon routing;
2. bounded parallel execution of independent read-only tools;
3. streaming Swarm model responses;
4. measurement-driven reduction of worktree/verifier fixed overhead;
5. multi-project matched live productivity campaigns.

Medium-term work includes stronger multi-host authority only after measurements justify it, cryptographically stronger evidence binding for high-assurance environments, learned intervention policies with explicit uncertainty, and real HACT diagnostic-retrieval/WAN studies.

## Conclusion

Future-Code is best understood as an **agent operating system for verified long-horizon work**. Models provide intelligence; the host owns authority, durable state, recovery, and evidence. The goal is two-sided: simple work should feel fast, while difficult R&D objectives should survive the failures, uncertainty, and context limits that make ordinary agent loops unreliable.
