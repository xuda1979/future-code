# Evidence before expanding work

An agent can keep producing patches without measuring the uncertainty that
determines its next useful action. Failure-loop detection alone does not catch
this trajectory: no check may have run yet. Future-Code now supports a declared
measurement cadence and current-evidence prerequisites for new external jobs.
These are general R&D controls, not project-specific training or benchmark rules.

## Configuration

Merge this fragment into a complete Swarm specification before initialization:

```json
{
  "agents": {
    "researcher": {
      "tools": ["read_file", "write_file", "run_check", "run_job", "recall"],
      "checks": ["acceptance"],
      "diagnostics": ["small_evaluation", "environment_check"],
      "jobs": ["experiment"],
      "decisionPolicy": {
        "maxUnmeasuredWriteTurns": 4,
        "measurementChecks": ["small_evaluation"]
      }
    }
  },
  "checks": {
    "small_evaluation": {
      "argv": ["$NODE", "./checks/small-evaluation.mjs"],
      "files": ["./checks/small-evaluation.mjs"],
      "replaySafe": true
    }
  },
  "jobs": {
    "experiment": {
      "preflightChecks": ["small_evaluation"]
    }
  }
}
```

The fragment omits existing provider, acceptance, environment-check and job
adapter definitions. Keep those required fields in the complete specification.
The operator must implement a relevant measurement and pin its command. A
successful process should mean that the declared prerequisite is satisfied;
printing plausible metrics or passing an unrelated smoke test cannot establish
scientific validity. Protect project-owned evaluator files through the normal
`protectedPaths` contract.

`diagnostics` grants additional named `run_check` capabilities. It does not add
checks to independent task acceptance or final integration. Diagnostics must be
replay-safe and use the existing configured process deadline; they have no new
universal two-second/five-minute limit. Expensive experiments belong behind the
durable job protocol, not inside a diagnostic command. Every agent allowed to
submit a gated template must also have permission to run its preflight checks.

The new policies are opt-in. A simple one-turn patch need not acquire a baseline
or call another model. The supervised example enables the measurement cadence;
choose a useful interval and measurement for your project rather than assuming
that every four-turn task needs the same experiment.

## Runtime behavior

| Situation | Host behavior |
|---|---|
| A model turn changes scoped source | Count once, including multi-edit batches. Reads, notes and no-change batches do not count. |
| The declared interval is reached | Show a `MEASUREMENT` health card and inject a bounded decision review into the next ordinary worker request. No separate reviewer request or automatic test is created. |
| Another source-changing turn is proposed | Reject edits before effects until a declared measurement produces a new completed observation. Remaining edits in the current turn retain their original order. |
| A selected measurement exits nonzero on unchanged source | Record useful negative evidence and reopen the repair path. It cannot authorize a successful job prerequisite or task PASS. |
| A check is unrelated, has an unknown outcome, mutates source, or simply repeats an identical result on identical input | It cannot clear an overdue review. Unknown/mutating results invalidate older support for that check. |
| An agent proposes a new gated job | Transactionally require every named preflight check to have a successful, owned result on current source and evidence before creating the job identity or calling the adapter. |
| Source, verifier feedback, completed-job evidence or verified-child evidence changes | Previous prerequisite observations become stale. An unrelated passing check cannot substitute for the declared name. |
| Independent jobs are admitted in one adjacent batch | Their intents may share the same current preflight observations, preserving authorized parallel fan-out. |
| An already admitted job is resumed | Preserve ensure/inspect reconciliation and immutable input binding even if its preflight observations have since become stale. Never submit a replacement merely because evidence changed. |
| Capacity-delayed work has no job identity yet | It is still a new submission. Recheck prerequisites if sibling results changed the evidence epoch while it waited. |
| The agent finishes its patch | All existing independent task and integration checks still determine acceptance. A measurement review is not an extra final acceptance check. |

Observations live in the task's durable session checkpoint and owned immutable
receipts. Write-batch counts commit with the batch result; a lost checkpoint
restores the prior patch and count. The latest review is included in the normal retirement projection when it fits
the admitted byte envelope; admission still uses durable state if that projection
is dropped. `agent_decision_reviews` is only a bounded health projection,
not a scheduler or source of execution authority. The append-only `job.intent`
records a preflight receipt binding check results, source/evidence epoch, job key
and immutable job input. Historical measurement reviews also appear in R&D
reflection as `measurement_overdue`; a recovered review does not imply that a
successful result remains blocked.

## Judgment and limits

Swarm workers and terminal `/goal` creation/resumption/continuation share concise
guidance: identify the uncertainty that could change the next action, prefer a
small discriminating measurement before substantial investment, state the
actions implied by different outcomes, retain negative results, and revisit the
approach when evidence changes. Straightforward work stays direct.

The two host controls govern Foundry/Swarm. The terminal `/goal` path receives
reasoning guidance; its unrestricted tool ecosystem does not acquire Swarm's
named-check/job admission policy. Existing initialized configurations remain
immutable: enable new fields in a reviewed fresh specification/root.

The host verifies result identity, ownership, freshness and process outcome. It
cannot infer whether an operator chose a scientifically decisive evaluation.
The adapter still owns staging and validating the experiment's actual
code/data/checkpoint identities: a local source-bound preflight is not proof that
remote compute used the same source. Job-specific data and input predicates must
be enforced by project-owned checks/adapters. A preflight evaluation can establish
that the measurement pipeline is valid even when its target score is low; it
should not require the final improvement the subsequent experiment is meant
to achieve. The policy does not discover missing
benchmarks, automatically rewrite an active global DAG, or guarantee human-level
judgment. Measurements and negative outcomes inform the model's next choice;
existing bounded recovery remains available when a trajectory fails.

## Validation

```sh
node --experimental-strip-types --test tests/foundry/decision-policy.test.ts
node scripts/test-correctness.mjs
node scripts/test-resilience.mjs
node scripts/test-foundry.mjs
node scripts/test-swarm.mjs
node scripts/test-commands.mjs
```

The focused comparison uses real local Git worktrees, scripted provider replies
and a mocked remote job adapter. Both arms pass independent task and final
integration checks with three scripted model requests. Without the preflight
policy, three jobs launch before measurement and four launch overall. With it,
zero launch before measurement and one launches overall. This measures avoided
premature effects in that offline workload, not real training time or live-model
productivity. The healthy one-edit comparison uses two requests in both arms.

Use the [real-project protocol](REAL_PROJECT_EVALUATION.md) for live trials. Measure
time to the first decision-relevant observation, total time to accepted output,
wasted external work, actual request/token/cost usage and human interventions.
Keep task quality and budgets matched; include failed and inconclusive trials.
