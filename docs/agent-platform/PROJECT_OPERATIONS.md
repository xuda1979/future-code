# Project neutral continuous operations

Future-Code can run an opt-in external operations project using the existing
Foundry Store, Scheduler, Swarm model loop and independent checks. A persistent
event starts a bounded task episode; the service remains available for the next
event after that episode finishes. There is no domain registry of products,
scientific facts, legal rules, reference answers or business strategies in this
extension. Projects supply their own knowledge, adapters and acceptance checks.

The lightweight `--ops` remote-execution interface remains compatible. The
governed interface below is `/swarm operations` or the standalone Node entrypoint.

## Execution and authority

The operator supplies an `operations` policy in a Swarm spec. Initialization
copies it, pins adapter executables and declared dependency files, protects local
adapter paths, and includes the entire configuration in worker/verifier identity.
Each agent profile receives an explicit subset of capability names. Model
requests include those capabilities' input schemas and effect contracts, without
adapter commands or credential environment variables.

`invoke_capability` validates its input and permission before an adapter is
called. `read_operations` exposes a bounded projection of resource commitments
and unresolved action references. These tools are inert unless explicitly
enabled. The default coding/research configuration and existing stored hashes
retain their prior behavior.

An external write has one stable identity derived from the policy namespace,
capability and configured scalar input fields. Include the relevant account,
resource, intended transition and generation in that identity. It survives new
model call IDs, attempts and runs. A changed payload for the same identity is
rejected. A genuinely different transition needs a distinct operator-defined
identity; changing IDs to replay an uncertain commitment is invalid.

The host atomically records intent and reserves resources before dispatch. A
successful execute response must be followed by an inspect response. Timeouts,
crashes, invalid replies and unknown usage retain the reservation and become
durable reconciliation work. After dispatch the host only inspects that action;
it never automatically sends a second mutation because a connection failed.
The pinned adapter must distinguish a terminal rejection from temporary absence.
An unavailable provider can therefore require attention rather than speculative
replacement. Terminal outcomes and actual usage are bound to immutable receipts.

Resource amounts use nonnegative safe integers in operator-defined units, such
as minor currency units, device operations or compute seconds. Each capability
reserves a declared upper bound; terminal inspected usage must include every
reserved resource and remain within that bound. UNKNOWN usage is not zero.
The resource ceiling and model request/byte ceilings span all runs in the store.
New events, retries and replanning do not reset them. They are lifetime ceilings,
not rolling daily allowances or a claim to meter unknown provider dollar bills.

## Project configuration

This fragment is added to an ordinary Swarm spec. The complete runnable example
is in `examples/operations/spec.json`.

```json
{
  "operations": {
    "schema": 1,
    "namespace": "project-account-v1",
    "resources": { "capacity": { "unit": "integer-units", "limit": 100 } },
    "timeoutMs": 10000,
    "maxBytes": 65536,
    "pollMs": 1000,
    "maxModelRequests": 500,
    "maxModelRequestBytes": 10000000,
    "capabilities": {
      "advance": {
        "adapter": { "argv": ["$NODE", "./project/adapter.mjs"] },
        "effect": "write",
        "identity": ["/account", "/resource", "/generation"],
        "reserve": { "capacity": 10 },
        "input": {
          "type": "object",
          "properties": {
            "account": { "type": "string", "enum": ["approved-account"] },
            "resource": { "type": "string", "maxLength": 128 },
            "generation": { "type": "integer", "minimum": 1 }
          },
          "required": ["account", "resource", "generation"]
        }
      }
    }
  }
}
```

Grant the profile `tools: ["invoke_capability", "read_operations", ...]` and
`capabilities: ["advance"]`. The schema deliberately supports a finite subset:
objects, arrays, strings, finite numbers, safe integers, booleans, null, enums
and bounds. Undeclared object fields are rejected. Schemas cannot load code,
follow references, fetch URLs or grant credentials.

For external reads use `effect: "read"`, an input schema and an adapter. Reads
do not reserve write resources or certify task acceptance. For writes an optional
`requires: ["observation-id"]` demands a fresh host observation before new intent.
The trusted host calls `Operations.observe` with an artifact hash, observation
time and expiry. This checks provenance bytes and freshness; the project adapter
and independent validator still determine what the observation means.

## Adapter protocol

One JSON request arrives on stdin. One JSON reply must appear on stdout. The
process is bounded, shell expansion is disabled, and only explicitly allowed
environment names are inherited. Declare transitive implementation files in
`adapter.files`; executable pinning is not hermetic dependency attestation or
an operating-system sandbox.

```json
{
  "schema": 1,
  "operation": "execute",
  "key": "HOST_GENERATED_ACTION_HASH",
  "inputHash": "HOST_GENERATED_INPUT_HASH",
  "input": { "account": "approved-account", "resource": "r1", "generation": 1 }
}
```

Operations are `read`, `execute` and `inspect`. The adapter verifies input and
the project's substantive policy before committing an external transition.
`inspect` must observe authoritative external state using the same key and
input hash. Return `PENDING` or `UNKNOWN` when evidence is insufficient.

```json
{
  "schema": 1,
  "key": "HOST_GENERATED_ACTION_HASH",
  "inputHash": "HOST_GENERATED_INPUT_HASH",
  "status": "CONFIRMED",
  "externalId": "provider-reference",
  "result": { "observed": true },
  "usage": { "capacity": 7 }
}
```

`REJECTED` means a terminal, verified noncommitment with zero usage for every
reserved resource. It must not mean a transient lookup returned no result.
Compensation is a separate capability with its own policy and evidence; an
external purchase, message, deployment or physical operation has no universal undo.
Provider idempotency retention and lookup capabilities must be tested by each
adapter. The core does not promise universal exactly-once remote execution.

## Events services and deadlines

`operations.routes` maps project event types to pinned Task arrays. The host
preserves each template's input under `task.input.configuration` and attaches
authenticated ingress under `task.input.event`. Untrusted payload text does not
change tools, credentials, checks or resource limits. The trusted ingress adapter
must validate signatures, account/tenant identity and replay protection before
calling `OperationsEvents.enqueue` or the CLI ingestion command.

Events deduplicate by namespace, source and external ID. Changed content under
that identity is rejected. Optional `availableAt` is a durable absolute timer.
Before creating a run the host persists the exact plan, recipe, contract and
stable run ID. A restart adopts that same run through `Scheduler.start`.
No independent execution queue can mark its tasks accepted.

The service has three persistent modes:

| Mode | Behavior |
| --- | --- |
| ACTIVE | Admit due events and new authorized actions. |
| DRAINING | Continue admitted episodes; admit only event types listed in `resolutionEvents` and new capabilities marked `purpose: "resolve"`. |
| PAUSED | Admit no new service episodes or mutations. Existing external actions can still be inspected through an explicitly resumed task. |

Trusted adapters record obligations with `addObligation({id,dueAt,detail,evidenceHash})`.
They remain visible after pause and episode completion. Resolution requires a new
evidence artifact; artifact integrity alone does not establish a customer's or
experiment's substantive entitlement. With a pinned `obligation.due` route, the
service creates bounded, deduplicated deadline notifications. Add that event type
to `resolutionEvents` when it must run while draining. No domain-specific remedy
is inferred by the kernel.

The attached service waits on Store notifications and the next durable deadline,
backs off during idle periods, and invokes no model merely to poll. Use a process
manager to keep it resident. A failed episode returns `NEEDS_ATTENTION` with its
run retained; this release does not silently invent a replacement business plan.
Existing Swarm supervision remains available for explicitly authorized recovery.

## Commands

Initialize a fresh root through normal Swarm initialization. Configure actual
model credentials through environment references and trusted adapters first.

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts init --root STATE --spec PROJECT.json --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts operations ingest --root STATE --file EVENT.json --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts operations tick --root STATE --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts operations serve --root STATE --allow-exec
node --experimental-strip-types src/harness/foundry/swarm/cli.ts operations status --root STATE
node --experimental-strip-types src/harness/foundry/swarm/cli.ts operations mode --root STATE --mode DRAINING --allow-exec
```

The same arguments follow `/swarm` in the interactive client. Standalone
`operations/cli.ts help` also describes observation and obligation host commands.
No daemon starts during import, initialization, status inspection or teaching.
Keep SQLite on local storage and back up its database and artifact store together.

## Knowledge outcomes and capability improvement

Human knowledge and skills enter through the existing `teach` and project pack
interfaces. They are attributed references, not execution authority. Agent
experience can accumulate through `record_experience`; its conditions and source
receipts remain visible. Accepted task checks do not establish an arbitrary causal
lesson. Project-specific metrics and independent discriminators must evaluate
outcomes before a procedure is promoted.

Inline `domainPack` objects now allow a project to define its evidence vocabulary
without editing core enums. The object is strictly validated, content-pinned and
registered before use. Existing named presets remain compatible. Pack prose and
vocabulary cannot replace independently pinned executable acceptance checks.

Missing capabilities can be developed in normal scoped worktrees, tested against
fixtures and provider sandboxes, and proposed as a new operator-pinned release.
Live workers retain the admitted adapter version and resource ceilings. The new
runtime does not let an agent rewrite its own protected adapter or turn a newly
generated script into live authority. Account onboarding, capability grants and
new production integrations still need their ordinary authorization.

## Applying the same runtime to different projects

| Project | Project supplies | Shared execution mechanism |
| --- | --- | --- |
| Long software work and runtime improvement | Repository, tests, release and rollback policy | Durable episodes and checked candidate promotion |
| Chip design and verification | EDA tools, requirements, coverage and signoff validators | Pinned capabilities, job identity and evidence gates |
| Mathematical research | Statements, proof assistants and independent proof checks | Versioned findings and checked obligations |
| Aerospace and industrial simulation | Solvers, models, mesh/data contracts and evaluation | Resource bounds and remote result reconciliation |
| Fab control, biological or precision experiments | Authorized device adapters, interlocks and operating procedures | Fresh-state requirements, commitments and deadlines |
| Quantum experiments and scientific discovery | Instrument/simulator adapters, protocols and scientific validators | The same scheduling, knowledge and verification paths |
| E-commerce or procurement | Store/supplier/account adapters, customer obligations, market rules and accounting evaluators | Event intake, action identity, reserved resources and inspected outcomes |

These are integration patterns, not measured claims of performance or scientific
competence in every field. No live store, supplier, payment, EDA system or physical
instrument was connected by the offline tests.

## Verification

```sh
node --experimental-strip-types --test tests/foundry/project-pack.test.ts tests/foundry/operations.test.ts tests/foundry/operation-events.test.ts tests/foundry/operations-swarm.test.ts
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```

Tests exercise actual host modules, SQLite connections, pinned subprocess adapters,
scripted external-model responses and independent checks. They include lost replies,
duplicate events/actions, shared resource ceilings, model-budget persistence,
stale authority, payload drift, missing receipts, timer restart, draining and
obligation history. Scripted providers establish runtime behavior; they do not
measure live-model intelligence, commerce profit or operational reliability at
international scale.
