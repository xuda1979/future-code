# Response to the October review

The revision adds new, separately identified follow-ups and improves the
explanation of the existing results. It does not claim that HACT beats the
maintained-counter ledger, that a hierarchical consumer has been demonstrated,
or that a top-journal acceptance decision is assured. The theorem statements
and all 522 archived observations remain unchanged.

## Consumer utility and the packet objective

Section 2 now distinguishes the evaluated fixed-group API from a consumer
that explicitly requires intermediate hierarchical capsules. The former does
not require a tree; maintained counters are the supported service choice.
A remote incremental auditor is presented only as a possible contract to
evaluate. A ledger could emit the same required stream. Flat deltas, batching,
compression and lifecycle costs need equal-service controls. Existing capsules
are not Merkle membership proofs or enclave attestations; such applications
would require additional protocols and evidence. No hypothetical scenario is
presented as an observed favorable workload.

## Sparse ordering and Packaging

The optional prototype in `ichact/sparse.py` stores exact positive pair counts,
constructs a deterministic maximum-Jaccard spanning forest and obtains a DFS
display order. It is a different heuristic from dense average linkage. It has
an explicit positive-edge limit and never drops leaves or silently truncates
edges. Separate validation compares original and sparse compact layouts using
complete-wave costs and incumbent-favoring ties.

The new replay uses Packaging's full 26,948-check registry, training runs 0--1,
validation run 2, and retained holdouts 3--4. There are 94,350 positive pairs.
The complete child process stays under a 2 GiB address-space limit with peak
RSS 335,134,720 bytes (319.6 MiB). Fit plus validation after loading takes
1.37 seconds on this host. Each holdout costs 70,116,096 rather than
111,199,936 padded bytes (36.95% less). An independent literal tree traversal
checks both prices. These are repeated-pattern replays, not new test runs,
new independent projects, natural-shift evidence, cap64 fitting or a large
service benchmark. Historical dense-compiler and service exclusions remain.

## cap32, compact8 and cap64 transfer

Section 5.2 now explains the structural restriction explicitly: below a full
64-leaf compact8 ancestor, cap32 solves its eight-leaf blocks independently.
It cannot merge across those block boundaries or change that ancestor;
cap64 opens that decision. Ragged boundaries can have other sizes. Neither
the primary endpoint nor the historical fitted layouts are changed.

All 30 admitted dispatch traces are rescored with the frozen cap64 layouts
against both the historical compact and symmetric baselines. Against the
historical compact layout, cap64 has 12 wins/3 ties under file-group shuffling
and 12 losses/3 ties under item shuffling. Against the symmetric baseline it
wins all 15 file-group traces and loses all 15 item-shuffled traces. The
supplement reports each project's three-seed ranges. The six original VOID
runs stay excluded and retained. There is no new fitting or checker execution.

## Calibration horizon

The supplement gives the standard empirical-Bernstein alternative, with an
attributed formula from Maurer and Pontil (2009), Theorem 4 and Corollary 5.
At range 3,584 bytes, K=1, delta=0.05 and m=50, its finite-range term alone
is 629.6 bytes, exceeding the 32-byte mean saving in the constructed example,
even with zero observed variance. It does not automatically make that example
practical at 50 epochs. The discussion distinguishes calibration variance
from unsupported IID/shift assumptions, installation cost and consumer value.
Wasserstein or moment-based alternatives need a justified metric/regularity
class and deployment uncertainty; they are future work, not implemented
certificates. The 100,000-prefix synthetic experiment is not an operational
recommendation or an estimate of the minimum sufficient sample size. All
original public-project certificate outcomes remain UNKNOWN.

## Readability, diagrams and CPU diagnosis

The manuscript consolidates validity qualifications in Section 9, explicitly
states the service decision in Section 2, and adds a nine-leaf optimum diagram.
The supplement adds the four six-check partition orbits, the cap64 table and
the CPU breakdown. The epoch and partial-refresh constructions remain distinct.

The new profiles cover all ten previously admitted cases and both
observer-disabled arms. cProfile uses process CPU time and profiles only
build/ingest/query operations; input snapshots and the oracle are outside.
All 840 answer checks agree. Disjoint exclusive categories sum to 100%.
Across projects, tree-module functions account for 9.0--58.4%, JSON work
15.4--35.2%, and hashing 0.9--1.9% of HACT's profiled operation CPU.
The supplement also reports counter shares, zlib, kernel and other work.
`walk`, `to_dict` and `validate_tree` dominate the larger Click tree profile.
Allocation is not separately isolated. These instrumented shares locate
implementation work; they do not causally decompose the unprofiled 1.61--3.54x
elapsed-time difference and do not replace the observer table's historical timings.

## Minor issues checked against source and arithmetic

1. The original observer table consistently labeled its last columns
   **Inst., Off**. Its Pluggy and ExceptionGroup values were mathematically
   correct in that order. The revision places **Off, On** next to the disabled
   millisecond columns and explains the ratio in the caption. All five rows
   are reordered consistently; no raw timing or ratio is changed. The
   independent projection audit is updated to require that exact header and
   arithmetic order. Its derived receipt is refreshed; the old receipt remains
   available in the immutable parent commit. No measured record is regenerated.
2. Figure 1's source already says `epoch and generation fence` once. The
   reported duplicate `and` is absent; no such text correction is applied.
3. The Proposition 4 source has `exact conformance checks`; the reported
   duplicated suffix is absent. Its proof is preserved.
4. Both the equation and the subsequent completion-hyperedge definition use
   lowercase `e` in the current source. No artificial notation change is made.
5. Reference [6] already spells *SIAM Journal on Discrete Mathematics*
   correctly. Its publisher DOI was verified; the title is preserved.
6. Immutable historical model snapshots cannot be recovered from the
   experiment manifests. The supplement states that limitation explicitly;
   the current assistant's family label is not assigned to historical runs.

The new protocol is an internal pre-execution freeze, not an external
preregistration or independent human review. AI assistance stays disclosed.
The journal submission remains paused for review of this new revision.
