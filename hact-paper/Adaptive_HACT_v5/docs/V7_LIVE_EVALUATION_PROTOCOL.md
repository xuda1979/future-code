# HACT V7: preregistered live evaluation protocol

This document is the **unexecuted** protocol for external validation. It does not imply the existence of remote credentials, model calls, paid runs, or a production HACT deployment.

## Research questions

- **RQ5: diagnostic delivery.** Does HACT provide shorter time-to-evidence and lower complete diagnostic service bytes than a strong flat indexed ledger with an equivalent evidence query interface?
- **RQ6: downstream utility.** When real software agents need proof of tests/analyses during long-horizon repair, does HACT reduce their actual prompt tokens, retrieval interactions, and debugging wall-clock time while maintaining quality?
- **RQ7: robustness.** Do gains survive shifts in test grouping, task order, failed checks, migration, and network conditions? How often is the incumbent preferable?

## Preregistration

Freeze before evaluation: Git hashes, tasks, source snapshots, model IDs, generation parameters, seed schedule, tool APIs, prompt templates, context budget, verifier, hardware/region, backend, price schedule, exposure permissions, timeout and timeout attribution.

Randomize HACT-versus-control ordering within repository/task and model; use paired blocked trials and at least 3 independently seeded repetitions. Independent units are tasks/projects, **not individual packets or test events**. Prespecify exclusions and account for model variability. Do not mix hosted inference endpoints, tokenizer families or hidden prompts across arms.

**Quality gate:** every candidate must pass exactly the same independent verifier and final integration contract. Failures, incomplete runs and abstentions stay in their originally assigned arm.

## Comparable services

Expose a shared `get_verification_status` and `fetch_diagnostic(query, budget)` API. Hold the authorized checks, outcome snapshot, query predicates, completeness guarantee, failure disclosure and maximum message size fixed across systems. Measure separately:

1. Root-status-only projection: no hierarchical diagnosis. This is a lower-capability negative control.
2. Flat indexed ledger: canonical check records with on-demand lookup and aggregation, plus an index maintained under the same concurrency rules.
3. Flat ledger plus standard compression.
4. Fixed-order balanced HACT, learned-order balanced HACT and an offline exact HACT reference, each with the same indexes/privileges where needed.

Index lookup/aggregation CPU, index storage, layout fit/migration costs, cache warmness, encoding/decoding and additional requests are counted for the appropriate arm. No claim of comparable services is allowed unless the same requested diagnostic questions can be answered completely.

## Measures and inference

Primary outcomes: verification-accepted objectives per wall-clock hour and requested diagnostic-service completion latency (p50, p95, tail; count timeouts). Joint guardrail: acceptance correctness must not regress.

Secondary: total application bytes, complete on-wire bytes, prompt/completion tokens **observed from the provider**, provider cost when trustworthy, number of diagnostic retrievals, peak context size, intermediate evidence freshness, failed hypotheses retried, CPU time, end-to-end turnaround.

Estimate paired differences with cluster-aware uncertainty (bootstrap over independent task/project blocks). Report negative cases and differential effects by repository, diagnostic query type, verification workload and network profile. Do not use a fake byte-to-token conversion or turn network goodput assumptions into measured WAN timing.

## Live execution and provenance

Produce one row per attempt with frozen contract hash, code hash, model/endpoint ID, requested diagnostic IDs, intervention policy, complete events, independent verifier evidence, precise wall clocks, cost origin and error code. Validate hashes before aggregation. Missing outcomes are UNKNOWN or VOID, never treated as zeros or successes.

No live run can be considered complete unless (1) every baseline arm is present and quality matched, (2) the results manifest validates, and (3) observed provider charges, if any, have the same provenance across arms.

## Release gate

The v7 paper may be circulated as a rigorous **offline comparative study** after its regression tests and archived-replay audit pass. Claiming top-journal-ready empirical demonstration of agent productivity additionally requires executing this matched live protocol and independent review. A public submission must check target venue guidance, author affiliations, disclosures, references, data rights and patent timing.
