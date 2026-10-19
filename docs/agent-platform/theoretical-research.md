# Theoretical science and mathematical research

Future-Code can coordinate theoretical arguments through its existing task DAG,
scientific jobs, hypothesis frontier, claims and programme ledger. The opt-in
theory contract adds exact deductive targets and prerequisites. Definitions,
equations, scientific knowledge and proof rules remain project-owned.

| Capability | Host behavior |
| --- | --- |
| Exact target | Bind the statement, allowed assumptions, protocol and certificate artifacts |
| Evidence classification | Preserve deductions, counterexamples, bounded checks and heuristic arguments separately |
| Lemma closure | Require independently accepted deductions of every exact premise before new dependent proof jobs and final acceptance |
| Research allocation | Prioritize shared missing lemmas by distinct open transitive dependents, within the existing falsification-first policy |
| Parallel teams | Dispatch independent ready obligations through existing bounded agent profiles, cohorts, tools and task leases |
| Reuse and correction | Export exact lemma versions, invalidate dependent findings after retraction, and import explicit versions across runs |
| Context | Supply checked premise statements and evidence references; use compact theoretical programme imports |

## Freeze a deductive protocol

Add `theory` to a [schema-2 scientific specification](SCIENTIFIC_EXPERIMENT_FRAMEWORK.md):

```ts
const lemma = {
  ...projectExperiment,
  theory: { schema: 1, statement: encodedLemma, premises: [] },
};
const theorem = {
  ...projectExperiment,
  theory: {
    schema: 1,
    statement: encodedTheorem,
    premises: [{ template: "lemma", specHash: digest(lemma) }],
  },
};
```

`statement` is a nonempty project-defined encoding of at most 8192 UTF-8 bytes.
The target hash is `digest({statement, assumptions})`, using the specification's
existing frozen `assumptions` array. A premise binds its entire configured
scientific protocol, including code/data/environment identities and oracle
requirements. Build specifications in dependency order. Unknown templates,
changed hashes, extra premise assumptions and cycles are rejected at configuration
time. Represent a discharged assumption in the lemma's statement; do not import
a deduction under assumptions unavailable to its consumer.

The core checks provenance and closure. Projects configure a separately pinned
read-only validator to interpret the statement and certificate. For a proof
assistant, that validator must check the exact declaration, imported theorems,
kernel result and allowed axioms, and reject unresolved holes, `sorry`/`admit`,
or new unapproved axioms. A compiler exit status alone supplies none of these
guarantees. Freeze checker/environment identity; let the worker generate the
candidate proof as a required evidence artifact under its existing file scope.

Validators receive the ordinary `spec`, `result` and host-built `context`.
`context.theoryPremises`, when required, contains each exact statement,
assumptions, protocol/target hash and accepted source references. This context
comes from independent task acceptance or explicit active programme imports,
and its hash is part of every validator report. Workers cannot supply it or
substitute a claimed lemma result. Validators can compose these checked
deductions under the frozen target's assumptions.

## Classify evidence without hiding gaps

Every validator of a theory protocol must return the ordinary bound report plus:

```json
{
  "theory": {
    "targetHash": "64-character-hash-of-statement-and-assumptions",
    "kind": "deduction",
    "artifact": "proof",
    "artifactHash": "64-character-hash-from-the-trusted-artifact-manifest",
    "openObligations": []
  }
}
```

The named artifact must be required by the protocol, nonempty, complete and
bound to the trusted executor manifest. Independent validators must inspect its
contents. Host checks cannot establish the semantics of an arbitrary certificate.

| Report outcome | Required evidence | Derived theory status |
| --- | --- | --- |
| `SUPPORTED` | Checked `deduction`, no open obligations | `ESTABLISHED` under the declared assumptions |
| `REFUTED` | Checked `counterexample`, no open obligations | `REFUTED` |
| `INCONCLUSIVE` | Exploratory, partial or inconclusive evidence | `OPEN` |
| Disagreeing support and refutation | All reports retained | `CONFLICTED` |

`bounded-check` and `heuristic` evidence can only produce `INCONCLUSIVE` for a
theory contract. Finite tests over an infinite domain and agreement among agent
reviewers cannot establish a universal statement. Open obligations are retained
in the immutable validator report; the assessment references that report.
Use `acceptance: "valid-result"` for exploratory or negative-result tasks and
`"supported-hypothesis"` when the required deliverable is a checked deduction.
Ordinary experimental protocols keep their existing schema-2 behavior.

## Manage a research team

Configure the existing [parallel frontier](research-frontier.md), bounded
`supervision.dynamicDAG`, independent workflow adviser and permitted scientific
jobs. Each lemma and final target can be a candidate using its own template.
The host derives proof edges from `theory.premises`; `after` remains available
for exploratory outcome conditions. The combined graph must be acyclic.

Give the parent objective an explicit `research: ["target-template"]` requirement.
This makes the final target part of immutable acceptance. A portfolio or a prose
research goal alone does not require that an optional experiment be completed.
The parent can reserve its target while the adviser delegates ready lemmas.
That dormant proof keeps its experiment budget reservation and releases its
frontier parallel slot until its premises exist. Task leases still enforce the
admitted recipe's live-worker limit. An unavailable adviser cannot manufacture
success: missing required proofs fail the existing scientific gate.

Within each existing purpose class, the frontier first ranks missing premises by
the number of distinct still-open transitive dependents. Shared lemmas therefore
precede unrelated exploration of the same purpose, and a diamond's final target
is counted once. Falsification retains its earlier priority; information scores
and measured costs break later ties. These counts allocate work; they are not
probabilities of proving a conjecture. Inconclusive premises keep downstream
proofs waiting. Refutation and conflict invalidate dependent branches.

Use separate agent profiles or cohorts for constructive derivations, alternative
methods, counterexample searches and gap audits. New worker guidance makes these
roles explicit. Existing `spawn_tasks`, `propose_claim`, `publish_finding`,
`save_progress` and project knowledge tools preserve scoped intermediate work.
Reviewer notes and newly proposed lemmas remain unverified until independently
checked. The framework supports up to 256 configured frontier candidates and
32 frontier slots, subject to the project's tighter task, depth, context,
request, quota and parallelism limits. More work proceeds in bounded waves.

## Reuse, resume and revoke

With a [research programme](research-programmes.md), theorem publication records
its exact lemma finding versions alongside explicit task imports. Revoking a
lemma invalidates dependent findings transitively. New jobs, result verification
and atomic task acceptance recheck prerequisite availability. Cross-run reuse
requires explicit active `task.knowledge` versions; it does not relaunch the
original experiments. Theoretical worker contexts use compact checked statement
views with full record/assessment hashes. Complete records remain in the ledger.
Repeated assumption sets are stored once in each worker context and referenced
by hash, preserving their exact contents within the admitted context budget.

Revocation never blocks reconciliation of an already submitted job. Its original
identity and terminal receipts remain inspectable after restart; the invalid
deduction fails acceptance. Historical proofs retain their original assumptions
and provenance. Nothing in this extension clears conflicts by voting.

Final integration (including cached receipts) and objective completion also
recheck exact imports, prerequisite closure and programme revocations. The
supervisor preserves the initial scientific target task IDs and requirements
across recovery; helpers and methods can change around those anchors. A saved
PASS is historical evidence, and a later revocation blocks new acceptance.

## Run the offline example

```sh
node --experimental-strip-types scripts/theory-research-demo.mjs
node --experimental-strip-types --test tests/foundry/theory.test.ts tests/foundry/swarm-theory.test.ts
```

The demo constructs eight propositional lemmas and then their conjunction.
A separate small natural-deduction checker validates every inference, assumption,
import and exact conclusion. Output shows batches of eight and one, and nine
established statements under the supplied assumptions. The Swarm regression
instead uses a mandatory parent theorem and eight concurrently delegated lemma
jobs, followed by restart, cross-run reuse and retraction checks. Scripted model
replies exercise runtime behavior; the checker runs independently in subprocesses.

This example checks orchestration and deductive evidence for a small formal
fragment. It measures neither frontier-model research quality nor a speedup on
open problems. Tokens and dollar cost remain unknown. Project-defined scientific
or formal oracles, suitable model capabilities and real task evaluations are
still required. Configured protocol graphs are finite; agents can generate new
exploratory claims with existing tools, while admission of new trusted protocols
remains outside model authority.
