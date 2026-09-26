# Response to the review — Adaptive HACT v3.0

The supplied review describes the original HACT manuscript. This revision starts
from the later IC-HACT v2 manuscript rather than discarding its completion-frontier
model and real-source tests. The current title is **Adaptive HACT: Learned Layouts
and Migration-Aware Verification for Agent Harnesses**. Repeated copies of the
same review are addressed once here.

## 1. Fixed leaf order

**Change.** The acceptance registry remains immutable, but its display order is
now a learned exact permutation. The compiler proposes the original order,
spectral seriation and average-linkage clustering from historical Jaccard
co-completion similarity. Each proposal is then optimized using the complete
completion-wave objective, not a pairwise surrogate, and selected on a separate
validation cohort. New stable-ID tokens prevent a display-position change from
relabeling evidence.

**Theory.** Section 4 preserves exact O(b n^3) compilation conditional on an order
and adds a finite-catalogue held-out selection bound. Section 3 gives a parity
construction showing that identical pairwise statistics need not imply identical
subtree activation cost. We explicitly attribute seriation, clustering and the
alphabetic DP. We do not claim unrestricted permutation optimality or repeat an
NP-hardness assertion for our precise objective without a proof.

**Evidence.** On 20 shuffled-cluster seeds, the selected layout reduces strict-epoch
bytes by 26.38% relative to original-order DP (95% interval 25.94–26.79%).
Independent updates show no reliable improvement. Source replay compares original,
shuffled, fixed8 and learned orders; the actual fresh paired checker runs hold test
execution order constant. See Section 8.2 and Tables 3, 5 and 6.

**Remaining limit.** The search considers three proposal families, not all
permutations. Pairwise seriation can miss useful higher-order structure.

## 2. Nonstationary workloads and tree switching

**Change.** A causal full-information controller chooses a frozen catalogue layout
before observing the current completion wave. Migration is charged as actual
canonical manifest bytes plus a forced full new-tree reconstruction. Coupled
fixed-share sampling reduces unnecessary changes while preserving each weight
vector's marginal distribution. Checkpoints preserve controller state. The
stable-ID guard and generation-stamped ticket are exercised together in tests.

**Theory.** Theorem 4 states service-plus-migration tracking regret relative to a
path with a bounded number of changes under a fixed catalogue, exogenous costs,
a declared loss-spread bound and full feedback. The appendix provides the path
prior, exponential-potential and coupling arguments. Fixed-share and dependent
sampling are credited to prior work; this is not claimed as a new generic online
learning algorithm or a stronger minimax rate. The empirical fixed learning/share
rates do not automatically yield an asymptotic sublinear bound.

**Evidence.** Eighty streams contain 163,840 events. The coupled policy's long-shift
total-cost ratio is 0.845 relative to frozen, including migrations. We report
independent sampling, zero-share coupling, a priced 64-event window rule, unpriced
greedy choices with realized migration charges, and clairvoyant comparators.
The simple window heuristic outperforms coupled share in several regimes.
Coupled share regresses 7.88% on stationary and 16.45% on rapid-shift streams.
These unfavorable results remain in the abstract, evaluation and discussion.

**Remaining limit.** Losses must not react to the selected hidden action history.
The proof does not cover a manager changing its reasoning schedule because of
layout changes, or an unbounded sequence of newly invented catalogue layouts.
The online benchmark is a persistent-refresh cost simulation, distinct from the
strict new-candidate gate executions.

## 3. Broader cost accounting

**Change.** Table 2 separates actual certificate bytes, migration manifests,
compilation/scoring, source preparation, private copying, checker process time,
aggregation, full wrapper time, active harness duration, context-building time
and actual prompt bytes. Provider token fields remain null when usage is absent.
No fixed bytes-to-tokens conversion is used.

**Evidence.** The three source projects have 24 fresh paired checker runs, plus
three trusted baselines and three source restorations. Their aggregate outer
wrapper times are 39.69 s for fixed8 and 39.77 s for learned layouts. Hence large
certificate reductions do not establish a checker or end-to-end speedup.
The 512-check, three-proposal compilation measurement takes 18.435 s; that setup
cost must be amortized rather than ignored.

**Remaining limit.** The optimizer remains byte-specific. A weighted latency or
money objective requires explicit units and observable counterfactual costs.
The paper does not imply that a manifest is a bounded agent prompt or that the
measured serialized bytes are actual wide-area network traffic.

## 4. Toy benchmark and actual agent harness

**Change.** We retain v2's real NetworkX, Toolz and Future Code source snapshots
and clearly distinguish reuse of their 33 published confirmation outcomes from
fresh v3 executions. We add an actual acceptance plug-in for the unmodified
Future Code v1.2 runtime and a 40-check SQLite/HTTP fixture with idempotent
transactions, rollback/rejected writes, HTTP status errors, bounded responses,
malformed JSON and end-to-end integration.

**Evidence.** Nine paired-mode harness episodes run real supervisors, two parallel
child workers, durable stores, private attempts, gate subprocesses and serialized
integration. Every episode recovers from an injected model-endpoint HTTP 503,
rejects the two intentionally incorrect candidates, and accepts the known correct
revisions. Three modes are direct pytest, strict fixed8, and strict learned layout.
The last two tie at 97,920 certificate bytes; medians are 18.11 and 18.12 s versus
12.98 s for direct gates. Mean prompt streams are about 70–71 KiB. The integration
is functional, but the added strict protection costs roughly five seconds on this
small fixture rather than accelerating it.

**Partial rather than complete satisfaction.** The model actions are scripted,
not generated by a hosted LLM. No live model tokens, billing, natural historical
bug cohort or SWE-bench score is claimed. A live-endpoint deployment guide is
included, but a guide is not an experiment. The full request for genuine hosted
LLM patch-generation evidence therefore remains open. This is stated in the
abstract, Section 8.5, limitations and artifact README.

## 5. Soundness and cache stamping

The stable registry is separate from display position. Migration revokes old
publication tickets, advances a monotone layout generation, and reconstructs the
kernel from canonical evidence keyed by semantic ID. Returning to an old layout
cannot revive its old ticket. An in-flight record may survive display-only
migration but not a new candidate epoch. Same-epoch contradictory outcomes fail
closed. Tests cover permutation/back-permutation, delayed delivery, epoch ABA,
conflicts, simultaneous submission/migration and controller-driven migration.

Theorem 5 preserves the conditional publication statement: complete current
matching passes imply the approved predicates only under the stated trusted
checker, dependency and immutable-input assumptions. The CLI strengthens the
protected-input comparison to detect additions/deletions, not just modifications,
and binds schema-2 contracts to approved checker and environment identities.
The report itself still does not perform an atomic external deployment.

## 6. Reproducibility and independent checking

The prototype passes 187 tests, 43 new relative to v2; the vendored Future Code
suite separately passes 263. An independent auditor reconstructs 80 ordering
workloads, 80 online streams, 33 source replays, 24 fresh paired runs, nine harness
records, 2,305 actual packets in 63 streams, and 32 bootstrap comparisons without
importing producer algorithms. Tamper tests show that malformed permutations,
gaps and altered cost models are detected. The reproduction launcher was itself
tested and ran a fresh three-mode harness exercise in an isolated directory;
its functional smoke times are not mixed with the primary timing cohort.

A draft summary's method-label mismatch was caught before release and corrected;
empty measurement cohorts now raise errors rather than becoming zero costs.
The final release verification separately records archive CRC, file hashes and
re-execution from the extracted deliverable. These are independent software
checks, not an external security assessment or third-party replication.

## Revised claim

The paper now claims a **stable-ID, learned-layout, migration-accounted
verification mechanism with concrete integration and measured operating limits**.
It does not claim that hierarchy, clustering, hashes, fixed-share learning or
small contexts are newly invented, that all deployments become faster, or that
the work has already reached an accepted-conference standard.
