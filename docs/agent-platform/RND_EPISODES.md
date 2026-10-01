# R&D Episodes and Outcome Graphs

Future-Code's durable moat should not depend on a current model weakness or on a
feature that a model vendor can copy. This subsystem turns verified objective execution
into reusable, machine-checkable learning data without copying raw prompts, model
responses, objective text, job inputs, credentials, or provider URLs into the episode.

## Episode boundary

A completed supervised objective emits one immutable `future-code-rnd-episode` artifact
and one immutable `future-code-rnd-outcome-graph` artifact. The completion attestation
binds both hashes, so the learning record is part of the same host-owned acceptance
decision as integration evidence and external-effect reconciliation.

The episode covers the entire objective lineage, not just the final successful run:

- every admitted revision and run;
- task signatures and independently verified outcomes;
- attempt duration, context, failure fingerprints, token/cost measurements when known;
- hashed agent/model capability identities and provider pools;
- remote experiment status, input/result/reconciliation hashes;
- evidence records and strengths;
- recovery decisions and replacement-run transitions;
- objective/run resource consumption and event-kind counts.

## Privacy-minimized export surface

The episode is designed to be safer to aggregate across projects than raw transcripts.
Task semantics use the existing normalized `taskExperienceSignature`; local task IDs,
agent names, model identifiers, recovery details, job template names, and scheduler job
IDs are represented by hashes. Provider requests are aggregated by the provider-pool
hash already used by the runtime. The original request and response artifacts remain in
the local durable journal and are not copied into the episode.

This is data minimization, not a formal anonymization guarantee. Content hashes can
still be sensitive metadata, especially for low-entropy inputs, so cross-organization
sharing needs an explicit privacy/governance layer.

## Policy-learning rows

Each revision produces a compact policy transition:

```text
stateHash -> action(REPLAN | COMPLETE) -> nextStateHash
              |
              +-- actionHash
              +-- measured resource vector
              +-- run outcome
```

`stateHash` binds task signatures, current outcomes, failure fingerprints, model-profile
hashes, strategy hashes and host-measured resources. A recovery action binds the next
plan hash plus the next task signatures. Future learned routing/decomposition/recovery
policies can therefore train on verified execution trajectories without treating model
self-reports as ground truth.

No scalar reward is invented in this patch. The record preserves objective completion,
run outcome, duration, model requests, bytes/tokens, failed attempts, measured cost and
external jobs so a later policy-training contract can define an explicit reward.

## Outcome graph

The graph represents durable causal/provenance relationships among:

```text
objective -> revision -> run -> task -> attempt
                               |       -> evidence
                               |       -> provider
                               +------> external job

run -> recovery -> replacement run
revision -> next revision
task -> dependency task
```

The graph is content-addressed and immutable. It is intended to become the substrate for
R&D institutional memory, similarity search, failure/recovery mining, and eventually
execution-policy learning.

## Inspect

After a successful supervised objective:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts episode \
  --root .future-code/rnd --objective OBJECTIVE_ID
```

The command returns the privacy-minimized episode plus the `graphHash`. Use the existing
`receipt --hash GRAPH_HASH` command for bounded graph inspection.

An episode row is append-only. SQLite triggers reject mutation or deletion; artifact
hash verification detects on-disk tampering.
