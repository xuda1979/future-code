# Versioned knowledge protocol

History remains immutable; conclusions remain revisable.

| Layer | Stored object | Lifecycle |
|---|---|---|
| L0 | Host events and agent events | Append-only; update/delete triggers |
| L1 | Artifact bytes and evidence receipts | Content-addressed; integrity checked on read; evidence rows append-only |
| L2 | Claim graph | Append-only versions; PROPOSED, SUPPORTED, REFUTED, RETRACTED or STALE |
| L3 | Goal/task DAG | Host state machine; tasks and spawn edges remain authoritative |
| L4 | Context views | Rebuildable bounded projections; original observations retained |
| L5 | Reflection and intervention policy | Immutable observations, derived contextual statistics |

A model may propose a statement and cite evidence identifiers. The statement
remains PROPOSED even when it cites a passing test. General test success does
not prove an arbitrary semantic conclusion.

## Claims and invalidation

Opt-in tools are `propose_claim`, `read_claims` and `propose_conflict`. They must be
listed in the agent profile. Unknown keys such as `status: SUPPORTED` are rejected
before effects. Each task may create up to 32 claims; model revisions are capped
at 128 versions. Statements are bounded to 4096 UTF-8 bytes and references to 32.

Claims belong to one run and goal. Evidence and dependency references stay within
the current task and its direct execution dependencies. Revisions require the
current `expectedVersion`; IDs cannot change ownership. Claim dependency cycles
are rejected. Each dependency binds an exact claim version.

Revision, retraction or adjudication appends a new version. Dependent claims
become STALE transitively, without editing historical claims or observations.
Rephrasing a previously supported or stale claim keeps it STALE until independently
adjudicated or explicitly retracted by the host. Exact claim tool requests replay
their recorded version without appending another version after a crash.

STALENESS and open conflicts block objective completion and integration, including
cached integration. They do not reset task execution or automatically repeat
external jobs. `claimRevalidationTask` returns a read-only task proposal for normal
host admission. Its prerequisite graph and workspace must be reviewed against
the current execution contract before scheduling.

## Independent adjudication

The host API exposes `admitAdjudicationTask`, `adjudicateClaim`, `resolveClaimConflict`, `resolveConflict`
and a first-class `AdjudicationRecord`. A trusted host may admit a read-only
discriminator into the existing task DAG after execution has passed. The admission
checks read authority, frozen task/context limits, cycles and idempotent request
identity, and records it as spawned work so objective progress is not inflated.
It reopens execution without rewriting an earlier task or rerunning external jobs.

A successful discriminator must:

1. Be an accepted task in the same run, with intact artifact/proof bindings to
   the frozen task, recipe, contract and independent verifier.
2. Have the specific host verifier check `claim-adjudication` or
   `conflict-adjudication` marked PASS, as appropriate.
3. Bind the artifact judgment to the exact subject identity/version.

For a claim, the artifact contains:

```json
{"claimJudgment":{"claimId":"cause","version":1,"statementHash":"SHA256","verdict":"SUPPORTED"}}
```

`REFUTED` is also valid. All dependency versions must still be current and
SUPPORTED. For a model-reported claim conflict:

```json
{"conflictJudgment":{"conflictId":"SHA256","leftVersion":1,"rightVersion":1,"verdict":"NEITHER"}}
```

`LEFT` and `RIGHT` are also valid. Closing this recorded version-pair conflict
does not implicitly support either claim. Supporting/refuting claims requires
the claim-specific path.

For an existing evidence conflict, the discriminator artifact contains the
`conflictId`, exact sorted `evidenceIds` of both sides, and verdict PASS or FAIL.
It must be the task registered by `adjudicationTask`. Reusing one side of a
conflict, an UNKNOWN result, a model-authored evidence row or another run's proof
cannot close the conflict.

The stock coding-workspace verifier produces scope/behavior receipts; it does
not synthesize semantic adjudication checks from prose. Domain-specific trusted
Drivers/verifiers must implement those checks and artifact judgments. The public
host API supports their use; no generic natural-language truth solver is claimed.

## Inspection

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts claims --run RUN --task TASK
node --experimental-strip-types src/harness/foundry/swarm/cli.ts claim-revalidation-task --run RUN --claim CLAIM
node --experimental-strip-types src/harness/foundry/swarm/cli.ts claim-retract --run RUN --claim CLAIM --version N --reason 'new evidence' --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts claim-adjudicate --run RUN --claim CLAIM --version N --evidence EVIDENCE_ID --allow-exec
```

Use the same `--root DIR` as the run. Retraction preserves all earlier versions;
it is an explicit host action, not a way for a model to rewrite acceptance.
