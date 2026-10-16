# Persistent research programme knowledge

Experiment receipts are useful across runs only when their provenance, assumptions
and dependencies remain intact. The opt-in programme ledger exports findings
atomically with independent task acceptance and imports exact versions into later
tasks. It does not turn saved notes into proof or maintain another execution DAG.

## Configuration

Add to the operator-owned Swarm specification:

```json
{
  "researchProgramme": {
    "id": "quantum-materials",
    "maxFindingsPerTask": 4,
    "maxContextBytes": 16000
  }
}
```

The specification must include scientific job templates as described in
[research experiments](research-experiments.md). Each accepted scientific job
publishes under its template name by default; use `research.provides` for a
different stable finding name. Names must be unique across configured templates.
Different results for the same logical finding create immutable versions. The
record binds its complete frozen scientific specification, assessment, source
run/task, artifact/evidence/contract hashes and exact imported dependencies.
Negative and inconclusive valid results are retained alongside positive results.

Publication occurs within the scheduler's acceptance transaction. An assessment
must be cited by the successful independent `research` check; a worker's note,
an unaccepted task or an arbitrary artifact hash cannot publish knowledge. The
existing code and scientific checks remain required in every later run.

## Inspect and reuse

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts knowledge --root STATE
node --experimental-strip-types src/harness/foundry/swarm/cli.ts knowledge --root STATE --finding bell --version HASH
```

The list is bounded and paginated by `--task-after ID` and `--limit N`. Inspecting
an exact version includes historical records; list states show whether current
heads are ACTIVE, STALE, RETRACTED or CONFLICTED. No transcripts or full-run scans
are needed to build the context for a task.

Declare imports on an operator-approved task:

```json
{"knowledge": [{"id": "bell", "version": "64-character-version-hash"}]}
```

Only active exact heads are usable. Their bounded structured records enter the
worker's initial context as `VERIFIED_OBSERVATIONS_WITH_ASSUMPTIONS`. An omitted
import grants no cross-run context. Dynamic children inherit these references
or choose a subset; they cannot discover or import additional programme data.
The host checks imports before running, during final verification, and again
inside atomic acceptance. If a dependency changes during execution, the task
cannot commit a result using stale knowledge. Replan with explicit current
references rather than silently substituting a newer result.

## Invalidation and contradictions

Superseding a head invalidates all transitive dependents of that exact version.
The original content and source evidence remain inspectable. New versions must
refer to active dependencies; self-replacement and dependency cycles cannot
produce an accepted export. Use distinct logical names for a result that builds
on an earlier finding instead of overwriting its own dependency.

Support and refutation of the same frozen protocol create an explicit conflict.
Neither result becomes reusable programme context. Further agreeing results do
not resolve the conflict by voting. Investigate with an independently checked
discriminator and an explicitly reviewed new protocol/finding name. This version
deliberately supplies no model-controlled conflict-clear operation.

Operators can revoke an exact finding:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts knowledge-retract \
  --root STATE --finding bell --version HASH --reason "Calibration assumptions expired" --allow-exec
```

Retraction preserves history, invalidates dependents and records its reason in
the event log. Running the same revoked protocol again cannot silently reactivate
it. This ledger spans runs in the same pinned Foundry store/project; importing
untrusted bundles or transferring acceptance across different projects/environments
is not provided. Exact code/data/environment hashes and assumptions remain part
of every finding, rather than a claim of unrestricted scientific generalization.
