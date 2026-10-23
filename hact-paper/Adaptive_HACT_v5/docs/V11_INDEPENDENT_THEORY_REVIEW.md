# HACT v11: independent theory review and generalized separation

Reviewed 2026-10-21. This is an independent AI-agent check of the v10
mathematical argument and its implementation boundary; it is not human peer
review, a novelty certificate, or a prediction of journal acceptance.

## Findings

- **PASS, conditional:** the v10 pairwise-information separation is correct.
  Its lower bound correctly accounts for every tree shape and permutation,
  rather than only permutations of one balanced topology.
- **PASS, conditional:** the ordered subtree/forest recurrence is exact for
  the stated additive interval/arity objective. Its $O(bn^3)$ time and
  $O(bn^2)$ space claims are justified. Exactness concerns the padded packet
  objective; compressed streams and unrestricted ordering remain separate.
- **PASS, conditional:** the authorization argument follows from canonical
  trusted records, bijective layout maps, exact coverage partitions and
  atomic generation/epoch checks in `AdaptiveGuard`. The raw `Kernel` is an
  internal component; conflict persistence and layout tickets belong to the
  guard. External source stability and atomic external commit remain explicit
  trust/integration requirements.
- **Clarify:** validation observations must be independent of the training
  data that selected the catalogue, as well as independent across validation
  inference units. Repeated timing rows within a project are not independent
  project replications. State this directly in the proposition.
- **Clarify:** the fixed-share normalization requires $R>0$, already enforced
  by `CoupledShare` and `tracking_bound`. Its exogenous full-information
  assumption is essential; the argument does not automatically cover a
  learner whose layout changes the next agent action or check schedule.
- **Clarify:** the reported 115,462 partitions are candidate root partitions
  summed across all 511 subset subproblems. They are not 115,462 partitions
  of the full nine-leaf root alone.

The largest immediately available theoretical improvement is below. It shows
that the information separation survives all affine positive slot prices and
all fanouts at least three, and quantifies its sharp minimax penalty. This
removes dependence on one selected numerical packet format.

## General packet-price theorem

Let maximum arity be an integer $b\ge3$, header price $H\ge0$, slot price
$S>0$, and construction multiplier $\lambda\ge0$. (Integer $H,S$ correspond
to byte counts; the proof also holds for real prices.) A feasible tree has
$n=b+1$ distinct labeled leaves and internal arities in $\{2,\ldots,b\}$.
Define

$$
 c(d)=H+Sd,\qquad W(T)=\sum_{v\in\operatorname{int}(T)}c(d_v),
$$

$$
 J_D(T;\lambda)=\lambda W(T)
       +\mathbb E_{U\sim D}\sum_{v\in\operatorname{int}(T)}
                 c(d_v)\mathbf1\{G(v)\cap U\ne\varnothing\}.
$$

There exist distributions $P,Q$ with identical singleton and pairwise
probabilities and disjoint globally optimal tree sets, allowing every leaf
permutation. Write $W_2=2H+S(b+2)$. Their optima are

$$
 J_P^*=(1+\lambda)W_2-\frac{H+3S}{4},\qquad
 J_Q^*=(1+\lambda)W_2-\frac{H+2S}{4}.
$$

Up to sibling order, $P$ has one optimum, grouping all three parity leaves
below one internal child; $Q$ has three optima, grouping any parity pair.

**Proof.** Let $A$ be $b-2$ anchor leaves, present in every event. On the three
remaining leaves $\{0,1,2\}$, $P$ is uniform on
$\varnothing,\{0,1\},\{0,2\},\{1,2\}$ and $Q$ is uniform on
$\{0\},\{1\},\{2\},\{0,1,2\}$. Append $A$ to each event. On the parity
leaves every singleton has probability $1/2$ and every pair $1/4$ in both
laws. Anchors have probability one; anchor/parity pairs have probability
$1/2$. All pairwise summaries therefore agree. Events are nonempty even
when the parity subset is empty.

If there are $I$ internal nodes, tree edge counting gives

$$
 W(T)=I(H+S)+Sb.
$$

Because $n=b+1$, the arity cap implies $I\ge2$. Every node containing an
anchor is touched with probability one. At most two internal nodes can
contain only the three parity leaves. If there are two, they are binary;
if there is one, it has arity at most three. Their total price is therefore
at most $2c(2)$, and each is hit with probability at least $3/4$. Consequently,
for every $I\ge3$,

$$
 J_D(T;\lambda)\ge(1+\lambda)W(T)-\frac{c(2)}2.
$$

A tree with two internal nodes and a parity pair child costs
$(1+\lambda)W_2-c(2)/4$ under either distribution. The lower bound on every
$I\ge3$ tree exceeds this pair tree by at least

$$
 (1+\lambda)(H+S)-\frac{c(2)}4
   =\frac{3H+2S}{4}+\lambda(H+S)>0.
$$

Thus no $I\ge3$ tree is optimal. A two-internal-node tree consists of a
root and exactly one internal child. If that child contains an anchor,
its refresh cost is $W_2$ and the parity pair tree strictly dominates it.
The only remaining child sets are a parity pair or the full parity triple.
A pair is missed with probability $1/4$ under both laws. The triple is
missed with probability $1/4$ under $P$ and zero under $Q$. Its price is
$c(3)>c(2)$, so $P$ strictly prefers the triple and $Q$ strictly prefers a
pair. The displayed costs and counts follow. Every competing two-node tree
has the same construction cost; larger trees have strictly larger
construction cost. The conclusion holds for all $\lambda\ge0$. $\square$

### Sharp pairwise-only penalty

A selector supplied only exact singleton/pairwise summaries (plus the known
prices, fanout and construction multiplier) receives identical inputs under
$P,Q$. All tree classes except the parity triple and parity pairs are
componentwise dominated by a parity pair. It therefore suffices to consider
probability $q$ of selecting the triple. The regrets are

$$
 r_P(q)=\frac S4(1-q),\qquad r_Q(q)=\frac{H+2S}{4}q.
$$

A deterministic selector has worst-case regret at least $S/4$, attained by
choosing a parity pair. A randomized selector has sharp worst-case regret

$$
 \inf_q\max(r_P(q),r_Q(q))
   =\frac{S(H+2S)}{4(H+3S)},\qquad
 q^*=\frac S{H+3S}.
$$

The lower bound applies even with exact pairwise probabilities, so it is an
information limitation, not an estimation-error result. It does not restrict
an algorithm allowed to retain completion sets or higher-order statistics.
With $H=512,S=320,b=8$, the deterministic penalty is 80 bytes, the randomized
penalty is $1440/23\approx62.609$ bytes and $q^*=5/23$. The optimum refresh
costs remain 3,856 and 3,936 bytes. One full construction gives 8,080 and
8,160 bytes. A zero header is a valid mathematical boundary case; the current
serializer's stricter positive-header validator is unchanged.

## Independent numerical checks

`experiments_v11/theory_generalization.py` imports no HACT producer objective,
compiler, or v10 subset solver. Its restricted-growth set partitions recurse
over all labeled trees with exact rational objective values. The reference
caps enumeration at nine leaves; this is a computation budget, not a theorem
restriction.

Executed:

```sh
/workspace/scratch/bd256f27e4fd/hact-venv/bin/python -m pytest -q \
  tests_v11/test_generalized_separation.py
/workspace/scratch/bd256f27e4fd/hact-venv/bin/python \
  -m experiments_v11.theory_generalization --full \
  --output /workspace/scratch/bd256f27e4fd/v11-theory-independent.json
```

- **23 tests passed.** These include explicit, independently listed evaluation
  of all 25 four-leaf trees with arities two or three, the $H=0,b=3$ boundary,
  fractional construction multipliers, moment equality through $b=32$, and a
  tamper test that deliberately changes the closed-form optimum and requires
  rejection by the exact reference.
- **39 exact grid cases passed:** $b\in\{3,4,5\}$, prices
  $(H,S)\in\{(0,1),(1,1),(512,320),(10000,1)\}$, and
  $\lambda\in\{0,1/2,2\}$; plus the three default-price $b=8$ cases.
- The nine-leaf reference independently recovers 511 nonempty subproblems,
  115,462 candidate partitions across them, one optimum for $P$, and three
  for $Q$. It returns 3,856/3,936 bytes at $\lambda=0$,
  5,968/6,048 at $\lambda=1/2$, and 12,304/12,384 at $\lambda=2$.

These are constructed mathematical checks, not additional software projects,
checker executions, natural bugs or live-agent episodes.

## Prior-art positioning requiring a manuscript update

The broad idea that higher-order information can matter for hierarchical
clustering is established. A relevant primary reference omitted from v10 is:

Vaggos Chatziafratis, Rad Niazadeh and Moses Charikar. *Hierarchical
Clustering with Structural Constraints*. ICML 2018, PMLR 80:774-783.
[Official metadata](https://proceedings.mlr.press/v80/chatziafratis18a.html);
[primary paper, Section 3 and Equation (5)](https://proceedings.mlr.press/v80/chatziafratis18a/chatziafratis18a.pdf).
Their 3-hypergraph hierarchy objective uses triplet-dependent separation
weights and least-common-ancestor cluster sizes. HACT prices every touched
ancestor using a bounded arity packet price and adds construction/migration
costs. This is a distinction between explicit objectives, not a claim that
HACT originated higher-order hierarchy optimization.

The existing comparison to Papp, Anegg and Yzelman's balanced/hierarchical
hypergraph partitioning remains appropriate:
[arXiv:2208.08257](https://arxiv.org/abs/2208.08257),
[SPAA 2023 DOI](https://doi.org/10.1145/3558481.3591087).
Their hardness results do not automatically transfer to HACT's unrestricted
shapes and lack of balance constraints.

The author's publication list identifies a published related alphabetic-tree
paper, *Alphabetic Trees: Theory and Applications in Layout-Driven Logic
Synthesis*, IEEE TCAD 20(1):58-69, 2001:
[primary author publication list](https://mpedram.com/publications).
Do not silently replace the currently cited undated manuscript with that
publication without checking that the relevant recurrence occurs there.

## Remaining interpretation limits

The general theorem strengthens one exact analytical contribution; it does
not establish workload prevalence, practical superiority, agent productivity,
or top-journal readiness. The safety and statistical guarantees are
conditional, and the online guarantee specializes established expert
algorithms. The updated empirical campaign needs its own provenance,
independent inference units, full-cost accounting, retained unfavorable
results and primary endpoint fixed before inspecting outcomes. Final human
review of the proof and literature positioning remains part of author review.

## V11 final implementation and evidence gate

An additional independent gate on 2026-10-21 inspected `ichact/fullwave.py`
and the attributed journal manuscript. The restricted-class exactness proof
is consistent with the implementation boundary: all fitted intervals are
maximal disjoint incumbent subtrees; unchanged ancestors keep their coverage
and arities; integer rescoring guarantees nonincreasing training cost.
Float64 DP does not become an exact rational solver merely because its
proposal passes the integer monotonicity check. The manuscript states this
qualification and the distinction between fixed-order topology changes and
higher-order causal attribution. Its generalized information theorem retains
the persistent-refresh boundary explicitly.

`audit/check_v11_compiler.py` reconstructs objectives directly from serialized
dictionary trees and actual raw completion IDs. It imports no HACT model,
layout, compiler, refiner, service implementation or producer scoring helper.
It checks all retained normalization derivatives against their raw parents,
including unchanged collection/completion order, phases and statuses. It
checks split membership (training 0--1, validation 2, held-out 3--4), bound
inputs/layouts, incumbent-favoring validation ties, and local freeze/evaluation
chronology. These local receipts are not an external preregistration or proof
that no human ever inspected a held-out file.

The gate passes with the following retained results:

- **Public compiler primary cap32:** five comparable projects, two wins and
  three ties. Click is 3,223,296 to 3,175,168 held-out bytes (1.493130%);
  Jinja is 3,903,360 to 3,896,448 (0.177078%). Packaging optimization remains
  UNKNOWN with its full 26,948-check registry preserved. No fallback is counted
  as a successful optimization.
- **Secondary cap64:** the positive per-project savings span 15.99606% to
  18.69462%; attrs ties. This is the explicitly separate sensitivity, not a
  replacement primary endpoint.
- **Historical synthetic ablation:** all 27 primary cells tie; one secondary
  cell improves by approximately 0.00762%. An independent sampler regenerates
  all frozen split digests, and direct packet reconstruction confirms every
  held-out total and selected catalogue entry.
- **Controlled service:** ten admitted cases, four arms and three timing
  repeats supply 5,040 checked answer rows. An independently written raw-record
  semantic oracle reproduces every recorded canonical answer digest; paired
  answers, complete-page counts and common-codec bytes agree. Codec ledgers,
  query sums, actual cache use and whole-trajectory stage inclusion check out.
  Both Packaging service cases remain UNKNOWN before timing admission. The
  strong maintained-counter control is retained; no service advantage follows
  from answer-byte equality.
- **Exploratory source transfers:** eleven attempted cases contain seven
  comparable results (two wins, three ties, two losses), three VOID cases and
  one Packaging resource UNKNOWN. Both Click losses, approximately 2.09402%
  and 2.58401%, are reproduced and retained. No layout is refitted on these
  transfer outcomes.

The independent artifact is `results/v11/independent_compiler_audit.json`.
Twelve audit tests pass, including actual audit-path rejection of altered
held-out totals, a changed normalized status, a forged service-answer digest
and a source-transfer byte total. Syntax validation also passes. Original
observations are unchanged.

A provenance qualification remains explicit: the original run report's
`environment` digest covers Python/platform, rather than every dependency.
The Jinja dependency-repair attempt therefore requires its separate dated
inventory/deviation record; equal coarse environment IDs alone do not prove
identical installed package sets. Cross-arm byte comparisons use the same
retained traces. This record neither retroactively freezes the earlier
environment nor turns the controlled cohort into a random project sample.

**Gate result: PASS for the audited mathematics, restricted scope, retained
arithmetic and claim labels.** Resource UNKNOWN/VOID outcomes remain as such.
Human scientific review, novelty assessment and final submission declarations
remain author responsibilities.

## Stronger result: complete strict-epoch partitions

A further analytical result closes a lifecycle limitation of the original
persistent-refresh construction. It has been independently verified by an
exact rational subset DP and a separate literal set-based traversal of all
**2,752 labeled unordered trees** on six leaves. The subset DP imports none
of the discovery LP, HACT compiler or producer score helpers.

### Construction and equal information

Let $G=\{0,1,2,3\}$ and $O=\{4,5\}$. Every epoch partitions all six checks
into exactly three nonempty completion windows. Each check completes exactly
once, and the objective charges one initially unknown full-tree construction.
The order of those three windows is immaterial to the packet objective.
Define four exchangeable partition laws; a block type $(g,o)$ records how
many $G$ and $O$ checks it contains:

| Law | Block types | Number of equiprobable labeled partitions |
|---|---|---:|
| $A$ | $(4,0),(0,1),(0,1)$ | 1 |
| $B$ | $(2,1),(2,0),(0,1)$ | 12 |
| $C$ | $(2,1),(1,1),(1,0)$ | 24 |
| $D$ | $(2,0),(1,1),(1,1)$ | 12 |

Set $P=\tfrac78A+\tfrac18B$ and
$Q=\tfrac9{10}A+\tfrac1{20}C+\tfrac1{20}D$. These have 13 and 37 support
partitions respectively, with all probabilities retained exactly.
For either law the probability that a given pair shares a completion
window is $11/12$ within $G$, $1/32$ between $G$ and $O$, and zero for the
pair in $O$. Every singleton has one completion per epoch. Thus singleton
and pairwise completion counts agree exactly. Equivalently, choosing one
of the three windows uniformly gives singleton probabilities $1/3$ and
pairwise probabilities equal to these pair-coincidence values divided by
three. The number of windows is also the same in both laws.

Nevertheless, the expected number of windows touching all of $G$ is $9/8$
under $P$ and $6/5$ under $Q$. The exact co-activity matrix therefore loses
information relevant to the strict-epoch cost, even after the full initial
construction and complete coverage of every check are included.

### Price-family theorem and proof

For any maximum arity $b\ge6$ and $S>0$, suppose

$$
 \frac{16}{11}<\frac HS<\frac{28}{17}.
$$

Among all shapes and leaf permutations, $P$ uniquely prefers the tree whose
root children are the four-leaf $G$ subtree and the two singleton $O$ leaves;
$Q$ uniquely prefers a flat six-leaf root. Sibling orders are equivalent.
The costs are

$$
 J_P(G\text{-tree})=\frac{49}{8}H+\frac{41}{2}S,\qquad
 J_Q(G\text{-tree})=\frac{31}{5}H+\frac{104}{5}S,
$$

$$
 J_P(\mathrm{flat})=J_Q(\mathrm{flat})=4H+24S.
$$

Here the complete-epoch cost is exactly one construction plus three refresh
contributions, with no incomplete-check or cross-epoch evidence reuse.

**Reduction over every topology.** For any nonempty internal coverage set,
its node weight (construction plus number of windows touching it) lies in
$[2,4]$ in every individual partition. Contract a nonroot internal child
with arity $d=2$ or $3$ into its parent. The parent's arity grows by $d-1$
and that child's packet disappears. The cost decrease is at least

$$
 2(H+Sd)-4S(d-1)=
 \begin{cases}2H,&d=2,\\2(H-S),&d=3.\end{cases}
$$

Both are positive throughout the interval. A six-leaf tree with $I\ge3$
internal nodes must have such a nonroot child: otherwise
$\sum_v(d_v-1)\ge1+3(I-1)\ge7$, contradicting
$\sum_v(d_v-1)=6-1=5$. Contraction remains feasible because its new arity
cannot exceed the six leaves and $b\ge6$. Repeating the operation strictly
improves every larger topology until at most two internal nodes remain.
Thus every optimum is either flat or a root with exactly one internal
child covering a subset of size two through five.

**Finite affine certificate.** There are 56 such subsets. Exchangeability
reduces them to the following eleven classes. The entries are node weights
$w_D=1+\mathbb E_D[\text{windows touching the subset}]$:

| Subset $G$ count | Subset $O$ count | $w_P$ | $w_Q$ |
|---:|---:|---:|---:|
| 0 | 2 | 3 | 3 |
| 1 | 1 | $95/32$ | $95/32$ |
| 2 | 0 | $25/12$ | $25/12$ |
| 1 | 2 | $63/16$ | $63/16$ |
| 2 | 1 | $97/32$ | $121/40$ |
| 3 | 0 | $17/8$ | $43/20$ |
| 2 | 2 | $191/48$ | $119/30$ |
| 3 | 1 | $49/16$ | $491/160$ |
| 4 | 0 | $17/8$ | $11/5$ |
| 3 | 2 | 4 | $319/80$ |
| 4 | 1 | $49/16$ | $31/10$ |

A subset of size $k$ gives total cost
$4c(7-k)+w_Dc(k)$. Its normalized difference from flat, at $r=H/S$, is
$w_Dr+4+k(w_D-4)$. Every row except $(4,0)$ is strictly positive at both
endpoints $16/11$ and $28/17$, so remains positive throughout; the minimum
endpoint margin across these other rows is $129/88$. For the $(4,0)$ row,
flat's regret under $P$ and the grouped tree's regret under $Q$ are

$$
 a=\frac{28S-17H}{8}>0,\qquad b=\frac{11H-16S}{5}>0.
$$

All larger trees are also dominated componentwise by flat. If contraction
ends at flat or another two-node class, this follows immediately. If it
ends at the $G$ tree, the cost gain of at least $2(H-S)$ exceeds $a$, since

$$
 2(H-S)-a=\frac{33H-44S}{8}>0.
$$

This proves both the global optimum claim and that only the two displayed
tree classes can be nondominated. A pairwise-only rule receives identical
inputs. If it chooses the grouped tree with probability $t$, its regrets
are $a(1-t)$ and $bt$. Consequently its sharp deterministic minimax regret
is $\min(a,b)$ and its sharp randomized minimax regret is $ab/(a+b)$,
attained at $t=a/(a+b)$.

At the default prices $H=512,S=320$, the grouped costs are 9,696 bytes under
$P$ and $49,152/5=9,830.4$ under $Q$; flat costs 9,728 under either. The
unique optimal topologies therefore differ. Deterministic minimax regret
is 32 bytes; randomized minimax regret is $512/21\simeq24.381$ bytes, attained
by grouping $G$ with probability $5/21$. At the price interval endpoints one
law ties the two trees, so the open inequalities are necessary for the stated
disjoint-unique-optimum result.

### Verification and precise scope

The implementation and complete coefficient certificate are in
`experiments_v11/strict_partition_witness.py` and
`results/v11/strict_partition_witness.json`. The reference enumerates all
90 complete three-window set partitions; an independently generated literal
hierarchy list contains exactly 2,752 trees. Exact rational minimum costs and
unique optimum counts agree between both paths. Tests verify the entire
56-subset affine certificate, both price boundaries, multiple interior prices
and fanout caps, and the contraction reduction's structural premise on every
enumerated tree. An integration test also exercises the actual optional
full-wave refiner on exact repeated epochs representing the two rational
mixtures and independently prices its differing outputs.

This is a constructed theorem under the general completion-window model,
not observed software performance. Its windows have varying sizes (for
example $A$ uses 4,1,1), so it is not a counterexample for the specific current
six-check CLI execution with a fixed eight-record flush; that execution would
produce one global completion window. The theorem supplies complete strict
epochs with nonempty disjoint windows and one cold build, while preserving
that batching-policy distinction explicitly.
