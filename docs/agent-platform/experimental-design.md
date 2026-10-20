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
    "batch": {"maxStates": 256, "maxLikelihoodTerms": 1000000},
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

For parallel work, the host selects greedily by **conditional** information per
millisecond. Let `S` contain the unresolved measurements already reserved and
the candidates selected earlier in this batch. The next score is:

`conditionalInformation(c | S) = I(H; Y_c | Y_S, accepted evidence)`

The host enumerates possible outcomes of `S` and averages information over their
probabilities. It does not assume that a pending job succeeded, update the
accepted-evidence posterior with predicted results, or make a dependent task
ready. After each selection, it recomputes scores within the highest available
purpose/lemma-priority class. Thus complementary measurements can outrank a
second measurement of the same uncertainty. Experiments with zero modeled
information can still run when host priorities or remaining candidates require
them; the supplied likelihood model is not authority to cancel required work.

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
| Parallel batches | Greedily maximize conditional information per millisecond, including live pending measurements; preserve purpose/lemma priority and line diversity |
| Costs | Use host-observed job milliseconds, with a 1 ms floor; label configured fallbacks explicitly |
| Zero likelihood under every hypothesis | Report `EXPERIMENT_DESIGN_MODEL_INCONSISTENT` and pause optional recommendations |
| Conflicting accepted evidence | Report `EXPERIMENT_DESIGN_CONFLICTED_EVIDENCE` and pause optional recommendations |
| Mandatory scientific tasks | Keep their admitted requirements and acceptance checks |

Each conditional score is exact under the finite model, up to floating-point
arithmetic. Greedy cost-normalized selection does not guarantee the globally
optimal batch. Pending measurements and distinct results are assumed
conditionally independent given the hypothesis; projects must calibrate that
assumption, especially when jobs share data. Job duration includes orchestration
time and is neither accelerator compute nor dollar cost. Posterior certainty is
conditional on the model and has no acceptance authority. Independent theory
and scientific validators still decide what a submitted artifact establishes.

## Bound exact conditioning

`design.batch` is optional. Its defaults are 256 outcome states and 1,000,000
likelihood terms per batch calculation. `maxStates` permits 1..4096;
`maxLikelihoodTerms` permits 1..4,000,000. These deterministic limits cover both
pending-job conditioning and candidate scoring, making decisions reproducible
after restart. The term counter charges one term per hypothesis/outcome per
state, reserves an entire priority class before scoring it, and also charges
state expansion. It is a computation bound, not measured processor time.

When enumeration would exceed either limit, the host returns the already
selected prefix and exposes `STATE_LIMIT` or `LIKELIHOOD_TERM_LIMIT` in
`frontier.design.batch.stopReason`. If the limit is reached before all pending
jobs can be conditioned, it recommends no new experiments and leaves
`pendingInformationBits` null. It never silently substitutes individual ranking
or samples outcomes. A model with many noisy measurements may therefore return
fewer optional jobs than available slots. Narrow the portfolio, wait for results,
or increase the configured bound within its ceiling. Mandatory task execution
and ordinary scientific acceptance remain independent of this advice.

## Inspect and validate

```sh
node --experimental-strip-types src/harness/foundry/swarm/cli.ts research-strategy --root STATE --run RUN
node --experimental-strip-types scripts/experiment-batch-demo.mjs
node --experimental-strip-types --test tests/foundry/experiment-design.test.ts tests/foundry/experiment-batch.test.ts
```

The bounded snapshot includes the model and evidence hashes, posterior weights,
entropy, counts of included/excluded observations, and selected candidates'
individual and conditional information, effective costs and cost bases. The
allocation score uses `conditionalBitsPerMs`; `bitsPerMs` retains the individual
diagnostic. Batch diagnostics include the count and hash of pending candidates,
expected new information beyond pending measurements, and actual conditioning
limits and counters. They exclude full likelihood tables and raw observations
from the frontier context. A restart reconstructs the same posterior from durable
accepted evidence; no model memory is required.

The offline demo uses four equally likely hypotheses encoding two independent
bits. Two screens read the first bit; a third reads the second. Individual
ranking chooses the first two screens and obtains 1 bit. Conditional selection
chooses complementary screens and obtains 2 bits with the same two-job budget.
The demo calculates both joint information values directly from the full joint
distribution. This is a synthetic model calculation, not a physical experiment
or a live-agent speed measurement; token and dollar costs remain unknown.

The tests compare noisy three-outcome batches against an independent joint
distribution oracle and check state/work limits, pending reservations, runtime
admission, replay, crash recovery and the independent acceptance boundary. They
provide no general experimental sample-efficiency or open-problem success claim.
