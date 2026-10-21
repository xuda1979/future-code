# Evaluator-guided program discovery

Future-Code can search over project-defined candidate programs using fresh external
LLM sessions and independently pinned computational evaluators. The process comes
from the general search method in [arXiv:2610.22367, Methods: Evolutionary search](https://arxiv.org/html/2610.22367v1).
The core accepts opaque JSON candidates, generic correctness checks and computable
metrics. Projects provide their representations, test oracles and resource models.

The existing [research frontier](research-frontier.md) schedules a finite set of
scientific protocols and hypotheses. Discovery adds iterative program rewriting:
one specification can generate many different implementations. Existing
`evolution.ts` continues to evaluate changes to the harness recipe itself.

| Search requirement | Implemented behavior |
| --- | --- |
| Ideation from a specification | A fresh proposer session returns the configured number of algorithm families |
| Protected family development | Every family gets one task per round under bounded scheduler parallelism |
| Independent evaluation | A separate pinned command checks the candidate and reports metrics bound to its hash and the frozen task |
| Trade-off preservation | MAP-Elites retains the best objective value in each declared metric cell, separately for each family |
| Sharing between approaches | On configured migration rounds, foreign elites enter the bounded alternatives context; the parent stays local |
| Fresh session memory | The proposer receives the task, a local parent, recent rejection feedback, bounded alternatives and short unverified notes |
| Durable lineage | Accepted task/evidence artifacts retain candidates, evaluator reports, parent hashes and inspiration hashes |
| Recovery | Deterministic round IDs and existing task leases deduplicate controllers and reuse completed evaluations |

Algorithm-family diversity is model-proposed, not formally proven. The host rejects
duplicate IDs and identical approach descriptions. Family protection is a finite
search policy; it does not establish that approaches are semantically distinct.

## Run a local lifecycle demo

Requires the repository's Node >=22.13 runtime; no dependency install or API key.
Run from the repository root:

```sh
node --experimental-strip-types scripts/discovery-search-demo.mjs
```

The demo uses scripted proposals and a real, separately pinned evaluator. Its
finite specification is `n*n+n` for every integer `0..100`. Six trials include two
incorrect programs; the valid smallest expression is eight UTF-8 source bytes.
Four family/cell alternatives survive. This exercises the pipeline and archive;
it is not a live-LLM productivity measurement or a new scientific result.

For persistent inspection, use a dedicated state directory:

```sh
node --experimental-strip-types src/harness/foundry/cli.ts discovery-init \
  --spec examples/discovery-search/spec.json --root .future-code/discovery
node --experimental-strip-types src/harness/foundry/cli.ts discovery-run \
  --root .future-code/discovery --allow-exec
node --experimental-strip-types src/harness/foundry/cli.ts discovery-status \
  --root .future-code/discovery
```

`discovery-run` also resumes a paused or interrupted search. Status includes the
best complete candidate/report, retained cell references, rejected-trial count,
round IDs and infrastructure errors. Full records are content-addressed JSON in
the state's `artifacts` directory. The host API exports `initializeDiscovery`,
`runDiscovery` and `discoverySnapshot` from Foundry's public index.

## Use an external LLM

Copy the example specification. Replace its proposer with:

```json
{
  "argv": ["$RUNTIME", "./examples/discovery-search/api-proposer.mjs"],
  "envAllow": ["DISCOVERY_API_URL", "DISCOVERY_MODEL", "DISCOVERY_API_KEY"]
}
```

Set those environment variables outside the specification. `DISCOVERY_API_URL`
is the complete OpenAI-compatible chat-completions endpoint. The example adapter
accepts HTTPS and local HTTP, requires a complete JSON response, bounds the actual
encoded request and response, and sends one fresh two-message request per session.
Use an appropriately larger task timeout for a real provider. Initialize a new
state directory after changing a frozen specification or pinned implementation.
Other API protocols can use the same stdin/stdout proposer contract through an
operator-supplied adapter. Endpoint/model selection may vary for proposal
production; the independently pinned scientific acceptance contract remains fixed.
No local inference-engine or provider KV-cache control is required.

The default example remains scripted. No model request occurs until an operator
configures the API adapter and explicitly runs with `--allow-exec`. Provider
billing is not measured by the command adapter; tokens and dollars remain `null`.

## Project interface and evaluator contract

`task` freezes the specification, candidate interface, correctness check IDs,
objective metric/direction and archive axes. An axis's increasing `boundaries`
partition measured values into intervals; a value equal to a boundary enters the
upper cell. An empty axis list retains one best candidate per family. Objective
metrics may represent any computable quantity, including a product of resource
costs calculated by the evaluator. Both `min` and `max` directions are supported.

Pin every evaluator dependency and fixture using its command `files` list.
Include reviewed data/environment identities and statistical assumptions in the
task interface. A changed evaluator, fixture, objective or accuracy requirement
needs a new frozen search. Referenced external dependencies must be immutable or
checked by the project evaluator; pinning does not recursively discover imports.

The proposer returns `{"families":[{"id":"...","approach":"..."},...]}` for
`phase: "ideate"`, and `{"candidate": <JSON>, "notes": ["..."]}` for `propose`.
The interface defines the candidate representation: code, a proof-search program,
a design description or another project artifact. Full rewrites are permitted.

The evaluator gets `phase: "evaluate"`, the public `task`, `protocolHash`,
`candidate` and `candidateHash`. It returns:

```json
{
  "schema": 1,
  "protocolHash": "SHA256 of canonical task JSON",
  "candidateHash": "SHA256 of canonical candidate JSON",
  "checks": [{"id": "project-check", "verdict": "PASS", "detail": "optional bounded detail"}],
  "metrics": {"projectCost": 123},
  "feedback": "Bounded diagnostics or a concrete counterexample."
}
```

Use Foundry's canonical JSON/digest helpers or an equivalent implementation. The
report must cover each frozen check exactly once. Only all-PASS reports with
finite objective and axis metrics enter the archive. Complete FAIL/UNKNOWN
reports stay as rejection feedback and consume a trial slot. Missing metrics on
such rejected candidates are allowed. A stale hash, missing check, malformed
response, changed pin or adapter error blocks the round. Neither a worker's
claimed score nor a free-form insight counts as evidence.

A task PASS authenticates a complete search evaluation, including a rejection.
Candidate correctness is visible separately in the evaluator's project checks.
`COMPLETE` means all configured rounds finished; `best: null` means no candidate
passed. The CLI exits unsuccessfully if no valid candidate exists. Archive
retention never promotes a harness recipe, deploys a program or certifies a
universal mathematical/scientific claim. Projects must enforce their own exact
or sampled validation guarantees. For bounded-error studies, freeze distributions,
replication counts, failure budgets and confidence procedures in the task and
check them inside the independent evaluator. Hidden holdouts and independent
finalist validation belong to that project protocol.

## Bounds and failure recovery

The operator declares family/round counts, migration interval, alternatives count,
parallelism, context/candidate/output byte limits and task deadline. At most 16
families, 256 rounds and 4096 cells per family are supported. With no lost leases,
there are `1 + families * rounds` proposer calls and `families * rounds` evaluator
calls. One extra lease per task permits replay after a controller dies. Two lost
leases exhaust that allowance and block progress; normal adapter errors do not
receive an unchanged automatic retry. Thus at most twice those command launches
are permitted in the absence of operator cancellation/restarts. Repeated explicit
graceful cancellations may replay unfinished commands; accepted tasks are reused.

Core task/parent context is never truncated. Alternatives are omitted from the
end until the actual encoded capsule fits. If mandatory context cannot fit, the
host refuses admission. Notes and recent feedback are bounded; history remains
in durable receipts rather than an ever-growing model conversation.

The archive is reconstructed from authenticated accepted tasks on reopening;
ordinary execution readiness, leases and completion remain in `tasks` and
`spawn_edges`. Only one round's family tasks are admitted at a time. Round
creation uses stable IDs and the scheduler's existing transaction, so a crash
between admission and execution cannot lose the recovery reference.

Commands must perform replay-safe local computation. A private working directory
and the demo's JavaScript VM are not OS security sandboxes. Projects executing
untrusted code need appropriate isolation in their evaluator. Physical devices,
remote training and other external effects should continue using reconciled
[ResearchJobs](research-experiments.md), not this local command loop.
