# HACT v12 mathematical referee review

Internal review completed 2026-10-21. This is an analytical and implementation
review, not independent human peer review or a guarantee of journal acceptance.
The v11 evidence was read without modification. The new reference and tests are
independent of the v11 witness generator and import no HACT code for the
population calculations.

## Verdict and scope

The persistent-refresh theorem and the six-check complete-epoch theorem are
mathematically valid under their stated affine prices, arity constraints and
information interfaces. The proposed uniform filler lift is also valid. It
gives a stronger, exact result for the implementation's fixed-eight policy:
two laws on complete permutations of 24 checks have identical distributions of
every individual completion rank and every pair of completion ranks, yet prefer
opposite members of a specified two-layout candidate class. The candidate
regrets retain the six-check values exactly. This proves a local decision
obstruction under fixed-eight batching; it does not prove that either embedded
layout is globally optimal over all trees on 24 leaves.

The two original proofs need no numerical correction. Their minimax quantities
are sharp for the two constructed worlds. State that restriction explicitly.
Sibling orders are equivalent; uniqueness means uniqueness of the labeled
unordered hierarchy, not a unique serialization order. In the original
complete-epoch theorem, uniformly ordering its three blocks equalizes
window-specific first and second moments, but unequal block sizes do not give
the stronger completion-rank claim until the equal-width lift is applied.

One wording correction is needed: equality of exact population summaries does
not establish equality of the joint finite-sample distribution of a vector of
empirical pairwise statistics. That vector's fluctuations can contain
higher-order information. Describe the lower bound as applying to selectors
whose supplied information is exactly the indicated population summaries.
The rank corollary covers any deterministic transformation of the individual
or bivariate rank laws. It does not identify joint distributions of three or
more ranks, real-valued elapsed completion times, or full-wave training data.

## General filler lift

Let a law partition `n` labeled original checks into exactly `q >= 2` nonempty
blocks, each of size at most `w >= 2`. Put `F = qw - n >= 2`. Add `F`
distinguishable filler checks. Conditional on the original partition, allocate
them uniformly among the `F! / product_a (w - |B_a|)!` assignments that fill
every block to width `w`. Finally choose a uniform random ordering of the `q`
blocks and independently choose a uniform ordering within every completed
block. These last permutations do not change co-wave events or costs.

Write `p_ij` for the original co-wave probabilities. For any original `i` and
any distinct fillers `f,g`, the completed law has

\[
 p_{if}=\frac{w-1-\sum_{j\ne i}p_{ij}}{F},\qquad
 p_{fg}=\frac{qw(w-1)-(2w-2)n+2\sum_{i<j}p_{ij}}{F(F-1)}.
\]

Original-original probabilities remain unchanged. To prove the first formula,
condition on the original partition: `f` is placed in `i`'s block with
probability `(w-|B(i)|)/F`, and
`E|B(i)| = 1 + sum_(j != i) p_ij`. For the second formula, put
`s_a=|B_a|` and `d_a=w-s_a`. Conditional on the partition, two distinct fillers
share a block with probability `sum_a d_a(d_a-1)/(F(F-1))`. Expansion gives

\[
 \sum_a d_a(d_a-1)
 =qw(w-1)-(2w-2)n+2\sum_{i<j}\mathbf1\{i,j\text{ share a block}\}.
\]

Thus any two original laws with equal pairwise co-wave probabilities retain
equal pairwise probabilities on the entire enlarged registry. This is an exact
finite-probability identity, with no sampling or limiting approximation.

## Completion-rank corollary

Let `N=qw` and use ranks `1,...,N`, with batch index `beta(r)=ceil(r/w)`.
Each check's rank is uniform. For distinct checks `i,j`, let `p_ij` now denote
their completed co-wave probability. Independent uniform block and within-block
permutations give

\[
 \Pr(R_i=r,R_j=s)=
 \begin{cases}
 0,&r=s,\\
 p_{ij}/[qw(w-1)],&r\ne s,\ \beta(r)=\beta(s),\\
 (1-p_{ij})/[q(q-1)w^2],&\beta(r)\ne\beta(s).
 \end{cases}
\]

Indeed, conditional on a shared block, that block has each of the `q`
positions equally likely and the ordered distinct within-block ranks are
uniform over `w(w-1)` possibilities. Conditional on separate blocks, their
ordered block positions are uniform over `q(q-1)`, and their within-block
positions are independently uniform. There are `qw(w-1)` ordered rank pairs
of the first kind and `q(q-1)w^2` of the second. The total mass is therefore one
and each row and column sums to `1/N`. Consequently matching completed
co-wave matrices imply matching full bivariate completion-rank laws.

## Fixed-eight two-candidate theorem

Use the six-check laws `P,Q` from the complete-epoch theorem, with
`G={0,1,2,3}` and `O={4,5}`. They have three source blocks, maximum source block
size four, and original pair probabilities `p_GG=11/12`, `p_GO=1/32`,
`p_OO=0`. Apply the lift with `q=3`, `w=8`, `n=6`, and `F=18`.
There are 24 distinct checks, every check completes exactly once, and the
actual fixed-eight policy produces exactly three full batches. The new
co-wave classes are:

| Pair class | Exact probability |
| --- | ---: |
| G-G | 11/12 |
| G-O | 1/32 |
| O-O | 0 |
| G-filler | 67/288 |
| O-filler | 55/144 |
| filler-filler | 191/612 |

The entire 24 by 24 matrix matches under the two lifted laws; its diagonal is
one and each row sums to eight. The completion-rank corollary then gives equal
univariate and bivariate rank laws, including equal relative-order and
rank-distance distributions for each check pair.

To specify feasible full layouts, put the six originals below one child of a
common binary root and all 18 fillers below the other child. Use the same
filler tree in both candidates: a ternary root over three six-leaf stars.
For the originals choose either a six-leaf star `T_F` or a ternary root over
the four-leaf star `G` and the two singleton leaves in `O`, called `T_G`.
Both full candidates are feasible for every fanout `b>=6`, including the
artifact's `b=8`, and are contiguous in the common leaf order `0,...,23`.

Every common node has the same coverage and arity in the two candidates.
For every padded outcome, the candidate cost difference is exactly the
original six-check subtree cost difference, including the cold construction.
Fillers change neither the set of original blocks that hit an original-only
node nor its arity. Uniform ordering and within-block shuffling leave these
hit counts unchanged. Thus, for `S>0` and `16/11 < H/S < 28/17`,

\[
 J_{\widetilde P}(T_F)-J_{\widetilde P}(T_G)
 =\Delta_P=(28S-17H)/8>0,
\]
\[
 J_{\widetilde Q}(T_G)-J_{\widetilde Q}(T_F)
 =\Delta_Q=(11H-16S)/5>0.
\]

Here `T_F,T_G` denote the full embedded candidates. Their shared-node expected
cost may differ between worlds; cancellation is between candidates within
each world. Do not claim that a single constant is added in both worlds.

A selector given only the matching population univariate and bivariate rank
laws must use the same distribution on these two candidates in both worlds.
If its probability of choosing the group candidate is `a`, its regrets are
`(1-a) Delta_P` and `a Delta_Q`, relative to the better candidate in that world.
The sharp deterministic two-world minimax regret is
`min(Delta_P,Delta_Q)`. The sharp randomized regret is
`Delta_P Delta_Q/(Delta_P+Delta_Q)`, attained at
`a=Delta_P/(Delta_P+Delta_Q)`. This optimization claim is over exactly the
two displayed full candidates, with common context fixed.

At `H=512,S=320`, the exact complete costs, including all filler nodes and the
outer root, are:

| Lifted world | Full flat candidate | Full group candidate |
| --- | ---: | ---: |
| P | 74109260/1547 | 74059756/1547 |
| Q | 74106752/1547 | 371325824/7735 |

The wrong-choice regrets are `32` and `512/5` bytes. The deterministic minimax
regret is `32`, the randomized regret is `512/21`, and the optimal group
probability is `5/21`. These are constructed byte-cost effects, not observations
of public software performance or claims of substantial practical magnitude.

## Manuscript-ready theorem statement

The following can be inserted after the filler lemma and rank corollary above;
the displayed cancellation argument is its proof.

```latex
\begin{theorem}[Pairwise rank information under fixed-eight batching]
\label{thm:fixed-eight-pairwise}
For every fanout $b\ge6$, $S>0$, and $16/11<H/S<28/17$, there exist
two laws $\widetilde P,\widetilde Q$ on complete permutations of 24 labeled
checks with identical univariate and bivariate completion-rank distributions.
Flushing every eight completions yields exactly three full batches under
either law. There are two specified feasible layouts, differing only in a
six-check subtree, for which the unique preferred candidate differs between
the laws. Their positive wrong-choice regrets are
\[
 \Delta_P=(28S-17H)/8,\qquad \Delta_Q=(11H-16S)/5.
\]
For selectors restricted to these two candidates and supplied only the exact
population univariate and bivariate rank laws, the sharp two-world
deterministic minimax regret is $\min(\Delta_P,\Delta_Q)$, and the sharp
randomized minimax regret is
$\Delta_P\Delta_Q/(\Delta_P+\Delta_Q)$.
This is a two-candidate statement, not a global optimum claim over all
24-check trees.
\end{theorem}
```

## Independent verification and reproducibility

New files: `experiments_v12/fixed_batch.py`,
`tests_v12/test_fixed_batch.py`, and `results/v12/fixed_batch.json`.
All probabilities and costs use exact rational arithmetic. The reference
independently enumerates source partitions using three-color assignments;
it does not import the v11 subset recursion or any optimizer/scorer.

- Full independent assignment enumeration at `w=4,F=6` covers 740 weighted
  padded P partitions and 2,540 weighted padded Q partitions. It confirms the
  closed-form lift and a separate conditional-deficit calculation. It also
  confirms the hypergeometric full-tree expectation formula on three layouts
  with mixed original/filler coverage.
- Full permutation enumeration for a small two-block law independently checks
  the completion-rank formula. Exact 24-rank probability tables check unit
  normalization, uniform row and column marginals, zero diagonal, and the
  correct total co-wave mass for every pair class and both boundary cases.
- For every source support point, both a forward and reverse filler allocation
  and all six block permutations give 600 representative full 24-check orders.
  The real `ichact.frontier.completion_waves` yields three batches of eight,
  and real `ichact.layout.Layout.cost` equals the independent literal packet
  evaluator for both trees. Every observed difference equals the original
  six-check difference. These examples check implementation conformance;
  the population proof integrates all filler allocations exactly.
- Four distinct admissible price pairs verify preserved analytic regret
  formulas. Deliberate corruption of moments, full costs, candidate scope,
  rank probabilities, consistently wrong rank classes, source probabilities,
  cold-build convention, minimax values and registry size is rejected.

Commands run from the project root with the existing virtual environment:

```text
/workspace/scratch/bd256f27e4fd/hact-venv/bin/python -m experiments_v12.fixed_batch --write
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 /workspace/scratch/bd256f27e4fd/hact-venv/bin/python -m pytest -q tests_v12/test_fixed_batch.py
```

Result: **30 tests passed in 1.02 seconds**. The exact certificate reports
24 checks, batch width eight, the stated regrets and 600 conformance orders.
There is no random sampling in the new proof or certificate, no global search
over 24-check trees, and no modification of previous-version observations.
