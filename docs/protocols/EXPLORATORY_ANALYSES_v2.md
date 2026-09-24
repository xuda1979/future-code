# Pre-Specified Exploratory Analyses on the Frozen v2 Cohort

**Written and committed 2026-09-24, AFTER the v2 cohort was generated and
frozen.** Every analysis below is therefore **exploratory, not
confirmatory**. The confirmatory results of this paper remain exactly the
five closure rules of the frozen v2 protocol, evaluated on the frozen
cohort. This document exists to prevent post-hoc analysis shopping: the
analyses are specified in full here, committed to git, and then run once.
Any analysis not listed here that later appears in the manuscript must be
labeled a post-hoc addition and its motivation disclosed.

## E1. Round-trip break-even rule (replaces the 3-point sensitivity)

For each stratum (pooled; clustered; independent; global) with per-accepted
regime-B means $B_f, B_m$ (frontier, masking) and per-accepted ops means
$o_f, o_m$, define the cost ratio
$R(c) = (B_f + c\,o_f)/(B_m + c\,o_m)$ for round-trip price $c \ge 0$.
Report: (a) $R(c)$ over $c \in \{0, 256, 512, 1024, 2048, 4096, 8192,
16384, 32768\}$ as a table; (b) the closed-form break-even
$c_\rho = (\rho B_m - B_f)/(o_f - \rho o_m)$ at gate $\rho = 0.8$ (the
frozen 20% promotion gate), with its validity conditions stated
($\rho \in (B_f/B_m,\; o_f/o_m)$ when $o_f < o_m$; no crossing when
$o_f = o_m$); (c) the same $c_\rho$ for the 25% and 15% gates as a
robustness band. This is a re-parametrization of already-frozen
quantities; no new runs.

## E2. Distributional robustness on the frozen grid

(a) **Paired sign test, regime O**: over the 84 cells (S=fixed), count
cells where frontier's cost per accepted run is below masking's; report
the count and the exact two-sided binomial p-value. (b) Same for regime-B
bytes. (c) **Per-seed ranges**: for each of the 7 seeds, the mean ops
reduction and mean regime-O reduction over that seed's 12 cells; report
min/median/max across seeds. No new runs.

## E3. Real-trace replay (new data, labeled exploratory)

**Source.** This repository's own git history (`git log --reverse
--no-merges --name-only --pretty=format:%H` from the initial commit
through the commit preceding this document). Registry = every file path
appearing in any such change set (deleted files remain in the registry,
mirroring retired components); gate index = rank in the sorted registry.
Episodes = commits in chronological order; the invalidated set of a
commit = its changed registry files.

**E3a. Evidence-layout ablation on the real trace.** Train = first half
of commits, held-out = second half. Compute flat vs hact held-out bytes
with the frozen 64 B record cost, the trace's train-half update density,
the density rule's selection, and the rule's regret versus the per-cell
oracle. Report even if regret is nonzero — especially then.

**E3b. Retirement replay on real invalidation patterns (hybrid,
disclosed).** The trace carries no obligations or dependency footprints,
so the frozen persistence machinery (obligation openings with the frozen
family rates applied to the trace's own change sets, dependency footprint
D=12, payload model) is overlaid on the real invalidation sets. This is
**real invalidation structure with synthetic obligation structure** and
is labeled as such. Arms: masking and frontier at S=fixed, 7 seeds for
the synthetic layer (55011–55017). Report: ops reduction, regime-B
delta, regime-O reduction, acceptance, per-seed range. Purpose: test
whether the frozen cohort's ops result survives real burstiness
(the trace's change-set size distribution is whatever the history is,
not a frozen family).

**Disclosed scope limits.** One repository; one trace; the repository is
the paper's own artifact (self-referential, not independent); commit
granularity is coarser than episode granularity; merges are excluded;
the synthetic overlay is not real obligations. No claim from E3 is
confirmatory.

## E4. Sufficiency proposition (theory, no new runs)

State and prove, scoped to the frozen engine semantics and the
reliable-retrieval assumption: for every finite episode stream in which
each due obligation's gate appears in that episode's required reads (a
property the frozen stream generator guarantees by construction), the
frontier policy incurs zero staleness defects and zero obligation
losses, and every obligation opened at episode $o$ with $o + W \le E-1$
is resolved. Together with the measured necessity result
(summary/reset fails), this upgrades the conversion rule from an
empirical regularity to necessity-plus-sufficiency within the model.

## E5. Monotonicity proposition (theory, no new runs)

State and prove: with $B_f, B_m, o_f, o_m \ge 0$ and $o_f < o_m$,
$R(c)$ is monotone on $c \ge 0$, and for any $\rho \in (B_f/B_m,
o_f/o_m)$ the inequality $R(c) \le \rho$ holds exactly for
$c \ge c_\rho$. Consequence: a deployment pilot that estimates the four
means, plus the deployment's round-trip price, yields an exact go/no-go
decision for the promotion gate; no sweep is needed.
