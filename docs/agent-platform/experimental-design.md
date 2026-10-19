# Active experimental design

The optional `researchStrategy.design` policy ranks eligible experiments by
expected reduction in hypothesis entropy per job millisecond. It uses a finite,
operator-owned probability model and independently accepted observations. The
runtime remains domain neutral: projects supply hypotheses and likelihoods.

## Freeze a likelihood model

Add `design` to an existing [parallel research frontier](research-frontier.md):

```json
{
  "design": {
    "schema": 1,
    "hypotheses": [
      {"id": "mechanism-a", "prior": 0.5},
      {"id": "mechanism-b", "prior": 0.5}
    ],
    "fallbackCostMs": 1000,
    "likelihoods": {
      "screen": {
        "mechanism-a": {"SUPPORTED": 0.9, "REFUTED": 0.1, "INCONCLUSIVE": 0},
        "mechanism-b": {"SUPPORTED": 0.1, "REFUTED": 0.9, "INCONCLUSIVE": 0}
      },
      "detailed": {
        "mechanism-a": {"SUPPORTED": 1, "REFUTED": 0, "INCONCLUSIVE": 0},
        "mechanism-b": {"SUPPORTED": 0, "REFUTED": 1, "INCONCLUSIVE": 0}
      }
    }
  }
}
```

Each likelihood table is keyed by candidate ID and hypothesis ID. It describes
the probability of the independent validator's outcome under that hypothesis.
Treat hypotheses as mutually exclusive and exhaustive within the supplied model.
Every configured candidate and all three outcomes must be present. There must
be 2..32 unique hypotheses with strictly positive priors summing to one; each
likelihood row must also sum to one. Candidate and experiment bounds remain
those of the frontier. Workers cannot edit this model or submit rewards.

Specify probabilities from a reviewed scientific model or calibration data.
This extension does not learn a Gaussian process, invent reliable likelihoods,
auto-formalize mathematics, or establish a hypothesis from posterior weight.
Leave `design` absent to retain the existing UCB-inspired allocation policy.

## Selection and evidence

For hypothesis weights `p(h)`, outcome likelihoods `p(y|h,c)`, and candidate `c`,
the host computes:

`information(c) = H(p(h)) - sum_y p(y|c) H(p(h|y,c))`

Entropy uses base-2 logarithms, so information is measured in bits. The utility
is information divided by the measured job duration or configured fallback.
For the equal-prior example, `screen` offers about 0.531 bits and `detailed`
offers 1 bit. If their measured durations are 10 ms and 1000 ms, respectively,
the screen has greater information per millisecond within the same purpose and
lemma-priority class.

Only accepted task evidence and explicit active programme imports can update
the posterior. Result identities are deduplicated across receipts and runs;
replaying one exact result does not multiply its likelihood. Different result
identities are assumed conditionally independent given the hypothesis. Reusing
the same data under different identities violates that modeling assumption;
projects should encode correlated evidence as one reviewed experiment. Refuted
upstream conditions exclude invalidated descendant observations from inference.
Contradictory evidence stays explicit. Likelihood products use log space.

| Boundary | Behavior |
| --- | --- |
| Falsification and shared lemmas | Keep their existing priority ahead of design utility |
| Dependencies, pending lines, failed work and stalled lines | Retain the existing eligibility gates |
| Parallel batches | Rank by marginal information under the current posterior and preserve line diversity |
| Costs | Use host-observed job milliseconds, with a 1 ms floor; label configured fallbacks explicitly |
| Zero likelihood under every hypothesis | Report `EXPERIMENT_DESIGN_MODEL_INCONSISTENT` and pause optional recommendations |
| Conflicting accepted evidence | Report `EXPERIMENT_DESIGN_CONFLICTED_EVIDENCE` and pause optional recommendations |
| Mandatory scientific tasks | Keep their admitted requirements and acceptance checks |

This is exact information gain for each experiment under a finite supplied
model. It does not optimize the joint information of a parallel batch. Job
duration includes orchestration time and is neither accelerator compute nor
dollar cost. Posterior certainty is conditional on the model and has no
acceptance authority. Independent theory and scientific validators still decide
what a submitted artifact establishes.

## Inspect and validate

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts research-strategy --root STATE --run RUN
node --experimental-strip-types --test tests/foundry/experiment-design.test.ts
```

The bounded snapshot includes the model and evidence hashes, posterior weights,
entropy, counts of included/excluded observations, and selected candidates'
expected information, effective costs and cost bases. It excludes full likelihood
tables and raw observations from the frontier context. A restart reconstructs
the same posterior from durable accepted evidence; no model memory is required.
The tests check analytic information values, adaptive selection, negative
controls, replay, crash recovery and the independent acceptance boundary. They
provide no live-model research-productivity or open-problem success claim.
