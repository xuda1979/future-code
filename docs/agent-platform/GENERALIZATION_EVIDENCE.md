# Methodology discovery and evidence beyond development examples

A run can miss its objective because its plan omits essential methodological
steps. Future-Code's shared process must discover those steps from permitted
references and project memory, then audit the adequacy of the plan before
execution. Domain knowledge and project-specific workflows belong in retrieved
sources and project configuration.

A perfect development score establishes performance on that measured workload.
It does not establish performance on unseen sources, independent task families
or missing workload slices. A weak external evaluation is a reason to investigate
the evaluation and development process. It does not identify insufficient
optimization, narrow development inputs or an interface mismatch by itself.

## Automatic reasoning and explicit enforcement

Worker and recovery guidance now explicitly asks for essential lifecycle discovery,
missing prerequisites, input quality/diversity, evaluation coverage, failure modes
and an independent plan audit when requirements are unknown. The configured
workflow policy adviser also reviews missing critical steps rather than only
scheduling bottlenecks. Within existing authority it can expand an unstarted task
into ordered discovery, audit and execution children. The adviser has no worker
tools: reference inspection belongs to permitted worker tasks; omitted context
stays unknown. Simple justified tasks remain direct, and model-authored plans
never replace independent acceptance.

This mechanism does not embed an application-specific recipe. The appropriate
steps are derived for the current objective, recorded with sources and unknowns,
and revised when observed failures reveal a missing premise. It remains dependent
on permitted reference access and the reasoning quality of the configured models.
The offline ordered-DAG regression verifies the planning path and dependency
barriers, not a measured ability of a live model to discover every necessary step.

Shared worker and recovery guidance now asks agents to define the target workload,
look for applicable independent evaluations with permitted tools, inspect family
counts and coverage, and distinguish coverage from optimization effort through
bounded controlled experiments. This guidance applies without a domain registry.
It is advice, not independent evidence or a guarantee that an agent discovers
every relevant external result.

For machine enforcement, add `generalization` to a schema-2 experiment spec and
configure its designated independent validator in `jobs.<name>.research.validators`.
Reference the job in the task's `research` obligations. Existing projects must
explicitly adopt this contract; their previous acceptance rules remain unchanged.
The host cannot infer unseen workload semantics or retroactively invalidate a
past result from an undocumented external score.

The frozen contract defines:

| Field | Meaning |
|---|---|
| `validator` | ID of a configured result validator, separately pinned from the executor |
| `candidateHash` | Exact artifact being evaluated, including any composed components |
| `exposureHash` | Manifest of inputs used for fitting, selection, tuning and other adaptive decisions |
| `scoringHash` | Scorer, prompts, execution conditions and runtime versions used for all compared suites |
| `suites` | Exactly one development suite, at least one external suite, and optional held-out suites, each with a distinct manifest |
| `minimumGroups`, `minimumSources` | Required independent family and source counts, chosen for the claim |
| `minimumSuccessRate` | Required binary family success rate for the suite and each required slice |
| `slices` | Project-defined workload categories and minimum family counts for each |
| `maxDevelopmentGap` | Maximum permitted development-to-independent performance drop |

The runtime supplies no universal adequate sample size or project taxonomy.
For example, an operator might require 40 independent development families and
60 external families from two sources. Those counts are policy inputs, not a
claim that they establish general capability. Use raw artifacts for the full
evaluation; structured validator output remains subject to the existing 65,536
byte report ceiling. Evidence has at most eight suites, 16 slices per suite,
1,024 groups per suite and 2,048 groups in total; the byte ceiling can bind first.

Example contract fragment (replace the symbolic hashes with actual SHA-256s):

```json
{
  "schema": 1,
  "validator": "workload-audit",
  "candidateHash": "<candidate-sha256>",
  "exposureHash": "<adaptive-input-manifest-sha256>",
  "scoringHash": "<measurement-contract-sha256>",
  "maxDevelopmentGap": 0.15,
  "suites": [
    {
      "id": "development", "role": "development",
      "manifestHash": "<development-manifest-sha256>",
      "minimumGroups": 40, "minimumSources": 1,
      "minimumSuccessRate": 0.8,
      "slices": [{"id": "composition", "minimumGroups": 20}]
    },
    {
      "id": "independent", "role": "external",
      "manifestHash": "<external-manifest-sha256>",
      "minimumGroups": 60, "minimumSources": 2,
      "minimumSuccessRate": 0.8,
      "slices": [{"id": "composition", "minimumGroups": 20}]
    }
  ]
}
```

## Validator evidence and trust boundary

Only the designated validator's authenticated `ValidatorReport.generalization`
is interpreted. The ordinary checks and exact spec/result/context/implementation
bindings remain mandatory. The evidence repeats candidate, exposure and scoring
hashes and contains:

```text
suites: [{id, manifestHash, disjointFromExposure: PASS|FAIL|UNKNOWN,
          groups: [{id: sha256, source, slices: [sliceId],
                    verdict: PASS|FAIL|UNKNOWN}]}]
```

The independent validator must rebuild this evidence from the complete raw
artifacts and frozen manifests. It must authenticate the actual candidate and
runtime, check exact and near-duplicate families, detect adaptive test exposure,
reconcile all expected trials including missing/failed trials, and compute a
conservative verdict for each independent family. Merely copying worker-provided
group IDs, a claimed sample count or a claimed success flag is not sufficient.
Derived cases, paraphrases and repeated seeds within a family must not inflate
the independent family count. Use the same stable family ID wherever a family
appears across manifests. Source IDs must identify actual provenance, not invented
labels for the same source. Family independence remains a scientific assumption
to justify, not something SHA-256 can prove.

The host rejects duplicate families within or across suites, failed isolation of
independent suites from adaptive inputs, identity drift and malformed evidence.
It reports unknown isolation as inconclusive. An external suite reusing a
development source cannot support the external-source claim. A held-out suite
may share a source with development while keeping families and adaptive exposure
disjoint. External here describes provenance outside development; it does not
require a public benchmark or any particular provider.

## Host assessment and repair

The host recomputes binary family counts, source counts, required-slice counts and
95% marginal Wilson intervals. Every required slice must meet the same performance
target; a good pooled score cannot hide a weak slice. Unknown trials cannot
support or refute a performance claim. Missing suites, too few independent
families/sources, missing slices and intervals crossing the target remain
`INCONCLUSIVE`. An interval entirely below the target or a conservative gap
(`development.lower - independent.upper > maxDevelopmentGap`) records `REFUTED`.
A point-estimate gap alone records an inconclusive warning.

These intervals assume independent binary families. They are marginal diagnostics,
not simultaneous confidence across slices, a causal diagnosis or a guarantee
under repeated adaptive testing. An agent that uses external failures to guide
development has exposed those families; reserve new families and a fresh frozen
evaluation for subsequent claims. Changes to candidate, manifests or measurement
conditions require a new experiment identity, never an edited old result.

Assessments and full diagnostic lists are persisted before acceptance is checked.
Under `supported-hypothesis`, unsupported broad claims fail. Under `valid-result`,
honest negative/inconclusive experiments can complete as useful observations;
their outcomes remain negative/inconclusive. Conflicting independent scientific
validators remain explicit, even when the evaluation evidence passes.

Failed verification includes the assessment reference, severe diagnostics first,
and bounded next-experiment advice. Existing repair feedback delivers it to the
next worker turn; restart reuses exactly bound validator receipts without
submitting another experiment. The full assessment remains durable when a compact
feedback summary omits diagnostics.

Recommended follow-up separates causes:

1. Audit artifact loading, execution interfaces, scoring and exposure identities.
2. Group external failures by the missing capabilities and workload conditions.
3. Compare broader development inputs with additional optimization using matched
   budgets and a preserved baseline; vary one factor at a time when practical.
4. Evaluate on fresh independent families and required slices before allocating
   more resources or claiming improvement.

Shared runtime changes contain no project names, benchmark contents, framework
rules or training-algorithm policies. Those belong in project adapters and
configuration. Offline fixtures test this protocol and repair behavior; they
do not demonstrate improved model quality or live research productivity.

## Verification

```sh
node --experimental-strip-types --test tests/foundry/generalization.test.ts
```

A workflow-policy regression also checks source-discovery and independent-audit
prerequisites before an execution child can be claimed.

The regressions exercise small perfect development scores with poor external
results, missing/unknown coverage, weak slices, family contamination, identity
tampering, validator authority, bounded feedback, restart replay and actual
worker repair. The Foundry and Swarm gates both include this file.
