# Cognition, authority and evidence

Future-Code gives models semantic freedom while retaining deterministic host
control over execution. Independent evidence decides acceptance.

| Plane | Can do | Cannot do |
|---|---|---|
| Cognitive | Propose a plan, tool call, child task, hypothesis or recovery | Set PASS, raise a budget, bypass scopes, replace a verifier |
| Sovereign kernel | Validate contracts, schedule work, admit/reject/defer proposals, enforce leases and reconcile effects | Convert model confidence or observational policy statistics into truth |
| Evidence | Preserve observations and artifacts; version conclusions; record conflicts and independent judgments | Erase earlier observations when a hypothesis is withdrawn |

Deterministic scheduling, search, constraint solvers and statistical estimators
are legitimate host algorithms. Semantic conflict detection can use a model;
the consequences and acceptance path are enforced by host code.

## Proposal boundary

`proposals.ts` exposes `Proposal<T>`, `submitProposal`, `decideProposal` and
`requireAdmission`. The host supplies source identity, run, task, fence, frozen
contract and recipe bindings. The payload is canonically copied and hashed.
A proposal is data, never an execution capability.

- `RESPONSE`: every decoded/replayed Swarm model message enters the proposal ledger.
- `TOOL_CALL`: host validates the advertised schema, profile capability, paths,
  protected paths and effect contract before invoking a tool.
- `SPAWN`: uses that gate plus existing atomic DAG admission, child scope and limits.
- `CLAIM` / `CONFLICT`: record hypotheses and unresolved contradictions; no truth authority.
- `RECOVERY`: both API and injected planners pass owner, graph, scope, novelty and
  finding checks before a replacement run is prepared.
- `PLAN`: available to host adapters proposing complete initial DAGs; operator-supplied
  Task[] still uses existing frozen-contract admission.

`kernel_proposals` and `kernel_admissions` are append-only. Admission decisions
are ADMIT, REJECT or DEFER. Calling `decideProposal` with a host-supplied defer
reason persists DEFER; the existing continuation mechanism owns scheduling.
A prior ADMIT is revalidated on reuse, including lease freshness. Neither a
receipt nor a reconstructed envelope can authorize modified payload bytes.
Tool-specific checks, OS/workspace checks, spawn limits and job reconciliation
still execute at the effect boundary. Admission does not promise tool success.

## Scope and compatibility

This boundary governs Foundry Swarm's external-API runtime and recovery path.
It does not rewrite the older terminal QueryEngine or third-party adapters.
Adapters passed the public Store/Scheduler API are trusted host code; generated
agents are never passed those objects. SQLite/file access is not a security
sandbox against a hostile administrator or in-process plugin.

New tables and triggers are additive. Existing runs, recipe hashes, durable
agent threads, accepted proofs and external job identities retain their binding.
Opening an old store installs the new tables without rewriting historical data.

## Verification

`tests/foundry/sovereignty.test.ts` exercises payload tampering, expired leases,
immutable history, semantic hypotheses, version invalidation, machine-bound
adjudication, forged authority, rejected paths and contextual-policy abstention.
Existing dynamic DAG, recovery, idempotency, multihost and evidence-reuse suites
remain part of the required gate.
