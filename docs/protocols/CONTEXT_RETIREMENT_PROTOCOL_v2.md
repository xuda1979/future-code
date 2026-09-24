# Pre-Registered Context-Retirement Protocol (v2, frozen)

**Frozen:** 2026-09-24, committed to git before any v2 cohort data was
generated. v1 (2026-09-23) ran to completion and fired its closures; v2
is a new study, not an amendment of v1. The v1 cohort remains frozen and
reportable; nothing in v2 reinterprets it.

**Research question (unchanged in substance, sharpened in design):**
When can an agent stop remembering its execution history without losing
the current evidence and obligations needed to finish correctly — and in
which cost regime does the answer pay?

v1's three closures established: (i) frontier retirement does not beat
masking on submitted bytes (null closure fired, −4.4% pooled, worse on
two of three families); (ii) it does cut retrieval operations 48.3% at
equal correctness; (iii) grouped evidence layouts beat flat delta
ledgers only in the dense-update stratum. v1's arm list, however, was a
hand-picked set of ten combinations, its closure rule was a single
pooled byte threshold, and its capsule accounting was evaluated only as
an end-of-run total. v2 repairs the design, not the conclusion.

## What v2 changes relative to v1 (all frozen ex ante)

1. **Full factorial instead of hand-picked arms.** Three factors:
   retention R, scheduler S, evidence layout E.
   - R ∈ {full-replay, masking, summary-reset, bounded-hier,
     verified-board, frontier, frontier-adaptive} (7 levels).
   - S ∈ {fixed, adaptive} (2 levels).
   - E ∈ {flat, hact} (2 levels), evaluated once per cell on the
     held-out half as in v1 (it is a serialization ablation, not a
     retention policy).
   Every R×S combination is run (14 policy runs per cell). Factor
   contrasts (main effects and the R×S interaction) are estimated
   directly from the full grid; no pairwise arm comparison substitutes
   for a factor contrast.
2. **Adaptive coordination arm (new).** `frontier-adaptive` extends
   verified-frontier retention with a demand-driven retention budget.
   Mechanism, frozen: each retained interface binding carries a use
   counter incremented whenever it is served (retained-fresh) or
   re-observed; at the end of every episode, bindings with zero uses
   over the trailing USE_WINDOW = 8 episodes are evicted unless they
   are (a) in the current working set, (b) a pending obligation, (c)
   in the dependency footprint, or (d) opened within the last
   USE_WINDOW episodes. Counters are integers; the policy is
   deterministic given the episode stream.
3. **Three-evaluation separation for capsule audits.** Each run's
   accounting is split into three disjoint phases, reported separately:
   - **Construction (episodes 0–4):** bootstrap accounting, including
     first-contact fetches.
   - **Steady state (episodes 5–34):** the regime the closures read.
   - **Audit tail (episodes 35–39):** at each tail episode an
     independent auditor compares the policy's capsule against the
     stream's ground truth (last-change episode per gate; the true
     pending-obligation set derived from observed facts and the
     obligation window). Recorded defects: (A1) a retained binding
     whose stored generation is older than the stream's current
     generation for that gate (stale retention); (A2) capsule pending
     set ≠ true pending set in either direction (missing or phantom
     obligation); (A3) a required read served from a binding that A1
     or A2 has already marked defective. Audit defects are reported
     per phase and do not enter the run's byte/ops totals; a run with
     any A3 defect is rejected regardless of the acceptance contract.
4. **Two cost regimes, both frozen.**
   - **Regime B (bandwidth-bound):** cost = context bytes + retrieval
     bytes, as in v1.
   - **Regime O (round-trip-bound):** cost = context bytes + retrieval
     bytes + OPSBYTE × retrieval ops, with OPSBYTE = 4096 B frozen
     (one on-demand round trip costed as 4 KiB of latency-equivalent
     bytes). Sensitivity at OPSBYTE ∈ {1024, 16384} is reported, not
     selected post hoc.
   Both regimes are reported for every arm. No closure rule reads
   regime B alone.
5. **Scale.** Sizes n ∈ {128, 512, 1024, 4096}; families ∈
   {clustered, independent, global}; seeds 55011–55017 (7); episodes
   40. Grid: 4 × 3 × 7 = 84 cells × 14 policy runs = 1176 runs.
   **Long-horizon sub-cohort:** n = 1024, episodes = 160, all three
   families × 7 seeds × R ∈ {masking, frontier, frontier-adaptive} at
   S = fixed (42 runs), to test whether the operation advantage grows
   with horizon. Evidence ablation (E) runs on the main cohort only.
6. **Closure rules (frozen).**
   - **Null closure (v2):** frontier is promotable only if it reduces
     regime-O cost per accepted run by ≥ 20% versus masking pooled
     over families AND shows no family stratum in which it regresses
     by more than 10%. Failure of either clause rejects promotion;
     the result is then reported as "correctness-preserving but not
     cost-advantaged in regime O."
   - **Attribution closure (v2):** the scheduler factor S is
     byte-neutral by design; if the estimated S main effect on
     regime-B cost exceeds 1% of the grand mean, the accounting is
     declared leaked and all S-related results are void. The R×S
     interaction on makespan rounds must be reported either way.
   - **HACT closure (v2, conditional):** grouped layouts are promotable
     only as a conditional component: they must beat flat delta export
     by ≥ 5% on held-out evidence bytes in the dense stratum (global
     family) while the density decision rule (select tree iff measured
     update density ≥ 0.5 on the training half) is stated and its
     pooled regret reported.
   - **Adaptive-coordination closure:** frontier-adaptive is promotable
     only if (a) its acceptance equals frontier's (no additional
     defects or losses), (b) it reduces frontier's regime-O cost by
     ≥ 10% pooled, and (c) it does not increase any family stratum's
     regime-O cost by more than 5%. Otherwise adaptive coordination is
     reported as not worth its complexity at mechanism level.
   - **Audit closure:** any arm exhibiting A3 defects in the audit tail
     is reported as audit-failing even if its acceptance contract
     passes; promotion of an audit-failing arm is prohibited.
7. **Reporting discipline.** Factor contrasts, family strata, phases,
   and both regimes are reported for every promotable claim. The v1
   cohort is reported once as history and never re-analyzed. Deviations
   from this document after the commit that freezes it are protocol
   violations and must be disclosed in the manuscript.

## Frozen constants

Per-call header h = 64 B; per-fact framing 32 B; summary 96 B; capsule
base 160 B; interface binding 16 B; pending obligation 48 B; aggregate
invariants 64 B; status-board row 48 B; evidence record 64 B; use
window 8 episodes; audit tail 5 episodes; construction phase 5 episodes;
OPSBYTE 4096 B (sensitivity 1024, 16384); obligation window 6 episodes
(unchanged from v1); dependency footprint D = 12 (unchanged).
