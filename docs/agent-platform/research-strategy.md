# Evidence-driven research strategy and local comparisons

The independent workflow policy role can now read a bounded scientific strategy
snapshot in addition to task/resource state. It recommends the next experiment
from operator-pinned protocols, with no model-authored feasibility scores and no
authority to accept results, change protocols or enlarge budgets.

## Strategy configuration

Configure the existing `supervision.workflowPolicy` role, scientific job templates,
and an optional root `researchStrategy`:

```json
{
  "schema": 1,
  "maxExperiments": 3,
  "maxSnapshotBytes": 8192,
  "stopOnRefutation": true,
  "candidates": [
    {"id": "screen", "template": "cheap-test", "line": "hypothesis-a", "purpose": "falsification"},
    {"id": "replicate", "template": "independent-replication", "line": "hypothesis-a", "purpose": "replication",
     "after": [{"candidate": "screen", "outcomes": ["SUPPORTED", "INCONCLUSIVE"]}]},
    {"id": "alternative", "template": "different-method", "line": "hypothesis-b", "purpose": "exploration"}
  ]
}
```

Candidates and templates must be unique; outcome dependencies must be acyclic.
Each template must have a frozen scientific specification. Replication should
use genuinely independent predeclared seeds/data/backend conditions, rather
than rerunning a deterministic seed and pretending to gain independent evidence.
The operator defines which experiments test the same research line. Refuting
one predeclared line does not refute unrelated alternatives.

Selection favours falsification, then replication, then exploration. Within a
purpose, known lower host-observed job durations rank first; unknown costs use
declared order. The duration is creation-to-terminal-observation wall time,
including queueing/polling; it is not a GPU/QPU compute meter or dollar cost.
Completed candidates are not blindly repeated. Declared outcome conditions
unlock follow-ups, unresolved/unaccepted jobs block their own line, and a
refutation can stop further optional work on that line. Contradictions remain
explicit and never become votes. Sparse or unusable evidence causes abstention.

The snapshot consumes only independently accepted scientific assessments and
exact programme findings explicitly imported by tasks on the current workflow
page. Imported findings must match the candidate's configured finding name and
frozen specification. Stale, retracted or conflicted imports block advice rather
than supplying a newer version silently. Omitted workflow pages are unknown;
no unrestricted cross-run search, raw job logs or worker transcripts enter the
policy prompt. History queries use bounded indexed pages.

`maxExperiments` caps the recommendation policy's current-run work; host job and
objective ceilings remain the execution authority even if the model ignores
advice. The workflow agent may propose children through the existing bounded DAG
API, in observe or apply mode. Required parent experiments, acceptance, scopes,
permissions and integration checks remain intact. Strategy advice cannot waive
an experiment that an operator already made mandatory.

Inspect the same snapshot using:

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts research-strategy --root STATE --run RUN
```

## Matched local experiment evaluation

Run a complete comparison without API credentials:

```sh
node --experimental-strip-types scripts/research-strategy-demo.mjs
```

Both arms receive the same frozen quantum circuits, seeds, shots, pinned executor
and experiment/time/output ceilings. Each arm starts with fresh observations;
arm order alternates by case, and the executor receives no arm label. The
`static-all` baseline executes the declared list, including its potential follow-ups;
`adaptive` consumes verified results and the selection policy above. The CPU demo
tests a separable preparation and a Bell preparation. It performs actual
statevector evolution and measurement sampling, not replayed result fixtures.

For these two cases, the adaptive arm runs one experiment instead of two on the
refuted separable preparation, and both experiments on the Bell preparation.
Both arms preserve the same observed refuted research lines. This is evidence
of avoided work in this declared smoke test, not a statistical claim of general
research productivity or a comparison against every static planner.

For your own **local numerical** comparison, construct a
`ResearchComparisonProtocol` (`src/harness/foundry/researchEvaluation.ts`) with
absolute executor/file paths and cases mapping every strategy template to its
frozen `ResearchSpec`. The pinned executable reads `{schema:1,spec}` from stdin
and emits `{result}` as a single JSON object. The host recomputes scientific
assessments. Invalid output, changed provenance, missing replications, output
overflow and deadlines fail closed. Formal proofs continue to use the separate
independent proof-checker gate, rather than this numerical runner.

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts research-compare \
  --root STATE --spec /absolute/comparison.json --allow-exec
```

The report binds protocol/executor hashes, stores every assessment/result hash
and host-measured duration, and records a durable report artifact/event. Unknown
tokens and dollar costs remain null. There is no automatic policy promotion.
This bounded synchronous runner is not a remote submission/recovery service:
use the durable reconciled `ResearchJobs` path for paid hardware, GPU clusters
or QPU/provider APIs. The shipped comparison invokes no live LLM or QPU. Wider
claims require held-out research tasks and independently checked outcomes,
with matched models, budgets, environments and real usage meters.
