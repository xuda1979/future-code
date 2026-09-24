# Pre-Registered Context-Retirement Protocol (v1, frozen)

**Frozen:** 2026-09-23, before any cohort data was generated.
**Research question:** When can an agent stop remembering its execution
history without losing the current evidence and obligations needed to
finish correctly, and at what cost?

This protocol is mechanism-level and deterministic. It measures the
*information-flow behavior* of context policies on a fixed synthetic
cohort with frozen seeds. It is NOT a live LLM cohort: no hosted model
is called, and no token/billing claim is made. Promotion to a live
cohort requires this mechanism-level result first.

## Cohort (frozen)

- Sizes n ∈ {128, 512, 1024} component gates.
- Coupling families ∈ {clustered, independent, global} (same generators
  as the HACT workload module, same seeds).
- Seeds: 7 per cell (55011..55017). Episodes per run: 40.
- Arms receive identical episode streams and identical initial state.

## Arms (frozen, ten)

 1. `full-replay`      — re-sends the entire history every call.
 2. `masking`          — observation masking + on-demand retrieval of
                         the exact facts needed by the current episode.
 3. `summary-reset`    — periodic summary/reset every L=4 episodes.
 4. `bounded-hier`     — bounded hierarchical contexts (fixed page
                         budget, chronological retention).
 5. `verified-board`   — decentralized verified board with compact
                         status rows; no frontier reasoning.
 6. `frontier`         — verified-frontier retirement (this proposal):
                         retire history, keep typed frontier capsules.
 7. `frontier+adapt`   — frontier retirement + adaptive scheduler that
                         raises parallelism only when ready work exists.
 8. `adapt-only`       — adaptive scheduler without frontier retirement
                         (attribution ablation for arm 7).
 9. `frontier+flat`    — frontier retirement with flat evidence rows
                         (HACT ablation A: tree vs flat).
10. `frontier+hact`    — frontier retirement with HACT certificate-tree
                         evidence layout (HACT ablation A).

## Primary outcomes (frozen)

- `accepted`: project passes the frozen acceptance contract.
- `costPerAccepted`: total submission bytes / accepted count.
- `contextBytes`: mean per-call context bytes (the retirement cost).
- `stalenessDefects`: episodes answered from stale bindings.
- `obligationLoss`: obligations dropped from the active context.
- `retrievalBytes`: bytes fetched on demand (retrieval tax).
- `makespanEpisodes`: episodes until final acceptance.

Acceptance contract: an arm completes the project iff it never acts on
a stale binding AND resolves every obligation by the final episode AND
its accumulated evidence satisfies the final independent check. Any
capsule-reconstruction failure is scored against the retirement policy.

## Closure rules (frozen ex ante)

- **Null closure:** if arm 6 (`frontier`) does not reduce
  cost-per-accepted-project by ≥ 20% versus the best of arms 1–5, the
  retirement hypothesis is REJECTED at mechanism level and HACT is not
  promoted beyond serialization.
- **Attribution closure:** if arm 8 (`adapt-only`) matches arm 7
  (`frontier+adapt`) within 10% on cost-per-accepted-project, the gain
  is attributed to scheduling, not retirement.
- **HACT closure:** if arm 10 (`frontier+hact`) does not beat arm 9
  (`frontier+flat`) by ≥ 5% on evidence-layout bytes at equal
  correctness, HACT is demoted to optional; the paper's central claim
  becomes the frontier-retirement policy, not the certificate tree.
- **Quality gate:** any arm with staleness defects > 0 or obligation
  loss > 0 is scored as a policy failure for that run regardless of
  byte counts.

## Cost accounting (frozen)

Costs are bytes on the supervisor-facing submission channel: context
bytes submitted per call plus on-demand retrieval bytes. All arms pay
the same per-call header h=64 B, per-fact f=32 B, summary s=96 B,
capsule c=160 B, evidence row r=48 B, and layout-construction overhead
is measured separately, never zero-imputed. Quality is never traded
against bytes without both being reported.

## Scale

3 sizes × 3 families × 7 seeds × 10 arms = 630 runs, each with 40
episodes. Falsification statistics are reported per family and pooled;
no post-hoc arm additions. Deviations from this document after data
generation are prohibited; any deviation found must be disclosed in the
manuscript as a protocol violation.

## Amendment v1.1 (2026-09-23, still before any data generation)

No cohort data existed when this amendment was written; `git log` places
it before the first run. Two refinements, both required for the
mechanism question to be well-posed:

1. **Temporal persistence.** The HACT workload generators draw
   invalidation sets i.i.d. per episode. Context retirement is a
   *temporal* question: it matters whether a component worked on
   today is likely to be worked on again soon. Each episode therefore
   applies a persistence transition: with probability 0.6 the working
   set persists or shifts by a small step (±cluster/2); with
   probability 0.4 a fresh set is drawn from the frozen family
   generator. Marginals stay family-matched; temporal structure is
   new and is part of the frozen design.
2. **Obligation lifetimes.** An obligation opens attached to a gate
   and must be resolved exactly 6 episodes later by a required read.
   Policies that keep a typed pending set retain it; recency-only or
   summary-only retention may drop it. Loss of an open obligation is
   a project failure under the acceptance contract.

Evidence-layout accounting is refined to steel-man the flat baseline:
the flat arm reports both the full-ledger export and the delta export
(changed rows only), and the HACT closure rule is evaluated against
the *better* of the two.

## Amendment v1.2 (2026-09-23, before the final cohort run)

An engine smoke test (630 runs to /tmp, no results retained) exposed
three under-specifications. All are pinned here BEFORE the final run:

1. **Obligation retention is emergent, not nominal.** Obligations are
   pushed to every policy at opening (mandatory field, matching the
   vendored context builder's preserved mandatory fields). Retention
   until the due episode is a property of each policy's actual
   mechanism: full-replay retains (log); masking retains a plain todo
   (steel-man); bounded-hier retains (mandatory slot); verified-board
   retains (board column); frontier retains typed pending. The
   summary/reset policy compresses todos across reset boundaries with
   a seeded 50% retention per boundary crossing (prose summaries of
   long-horizon commitments are lossy). A lost obligation's due read
   is never injected: the policy does not know to act. Loss is scored
   at the due episode.
2. **Staleness is real, not nominal.** The summary/reset policy
   attends to the stream only at reset episodes (every 4th); facts
   arriving between resets are unobserved. Values retained from the
   last attended episode can therefore be stale when read; acting on
   them is a staleness defect. All other arms observe every fact
   (they are context builders, not attention policies), so their
   dropped bindings become retrievals, never silent staleness.
3. **Record costs are consistent across the evidence ablation.** The
   flat evidence ledger and the HACT tree use the same per-record
   cost, 64 B, taken from the repository's own cost model
   (`defaultCostModel`: 128 B packet overhead + 64 B per child, cap
   4096). The tree arm uses the real `compactBalanced(n, 8, depth)`
   layout with per-size depth ceil(log8 n) (4 at n=1024; the cost
   model's default height 3 cannot cover 1024 gates at arity 8) and
   pays activated-path packets plus one-time construction. The flat
   steel-man is the better of full-ledger export (header + 64n per
   call) and delta export (header + 64 per changed gate per call).
   Status-board rows remain 48 B as originally frozen (different
   artifact: present-state rows, not evidence records).
4. **Frontier capsule cost scales with contents:** 160 B typed base +
   16 B per retained interface binding + 48 B per pending obligation
   + 64 B aggregate invariants. The frontier retains the current
   working set and its dependency interfaces (relevance-based
   eviction); it is not free and not unbounded.
5. **Masking is demand-driven with no cross-call value cache** (the
   observation-masking design): every required read not in the
   current episode's facts is fetched at 64 B. It retains a plain
   todo (steel-man).
6. **Adapt-only is masking retention + adaptive scheduling** (the
   clean factorial {frontier, masking} × {fixed, adaptive}). The
   scheduler dimension costs no bytes; it is reported as makespan
   rounds: sum over episodes of ceil(ready_work / parallelism), with
   fixed parallelism 1 and adaptive parallelism rising to 8 with
   ready work. Arm 9 is the naive full-ledger flat control; arm 6
   (the proposal) uses the delta ledger.
7. **Disclosure:** the smoke test used a hand-rolled evidence model
   and nominal obligation retention; its numbers are void. The final
   cohort below is generated only by the amended engine.

## Amendment v1.3 (2026-09-23, before the final cohort run)

Engine iteration on seed 55011 (one stream, no cohort retained)
exposed a cost-model realism gap, pinned here before the final run:

8. **Facts carry payload.** A fact is an identity binding plus a
   payload (e.g., an interface summary, a log tail). Payload sizes
   follow a frozen lognormal distribution (median 128 B, sigma 0.8,
   minimum 32 B) drawn per gate from the episode stream, identical
   across arms. Episode-0 full-state observation therefore costs
   payload bytes per gate; retirement that keeps identity-only
   capsules avoids re-sending payloads. This is the cost structure in
   which retirement can beat replay, and it is the structure the
   review's accounting (s_j interface sizes) assumes.
9. **Retrieval costs payload + identity.** A re-fetch transmits the
   full fact (payload + 32 B identity/framing), not 64 B flat.
10. **Frontier capsule carries interfaces, not payloads.** The
    frontier keeps typed interface descriptors (16 B per binding:
    id, version, digest) plus pending obligations (48 B) plus
    invariants (64 B). Payloads are retrieved only when a gate is
    read. This is the review's capsule design: what crosses a
    verified frontier is interfaces and obligations, not contents.
11. **Full-replay re-sends payload history**: context bytes include
    every retained payload every call (the quadratic term I_full).
12. **Both submitted-context and retrieved bytes enter the frozen
    primary outcome.** The closure rules are unchanged.

## Amendment v1.4 (2026-09-23, before the final cohort run)

Engine verification on single streams (no cohort data generated or
retained yet) exposed four final under-specifications. Pinned here,
still ex ante:

13. **Dependency footprints.** Reads must include persistent
    dependencies on completed components — the review's exported
    interfaces crossing the frontier. Each working phase carries a
    dependency footprint D of 12 gates (frozen; a task's dependency
    count does not scale with registry size), drawn at phase start and
    persisting through persistence steps; redrawn on family redraw.
    `requiredReads = workingSet ∪ boundary-neighbors ∪ D ∪ due
    obligations`.
14. **Consistent payload accounting.** Every needed interface costs its
    payload s_g exactly once per call, in whatever channel delivers it
    (context fact, fetch, board row, or capsule entry). Channels differ
    only in framing: fact/fetch framing 32 B; capsule binding 16 B;
    board row 48 B; summary anchor 96 B. Frontier capsule = 160 B base
    + Σ_WS(16 + s_g) + 48 B/pending + 64 B invariants. Masking context
    = 64 + Σ_current(32 + s_g), fetch = (32 + s_g) per non-current
    read, no cross-call payload cache. Board = 64 + Σ_all(48 + s_g).
    Full-replay = 64 + Σ_log(32 + s_g). Bounded-hier = 64 +
    Σ_last64(32 + s_g). Summary-reset = 64 + 96 + Σ_window(32 + s_g),
    window budget 32 observations within each reset period.
15. **Summary/reset failure model.** A reset agent observes everything
    within each period; it does not sleep. Its failures are: (a)
    obligations crossing a reset boundary survive only through the
    summary, which retains each with seeded 50% probability — dropouts
    are scored lost at their due episode; (b) window overflow within a
    period evicts observations, and values then revert to the
    summary belief (state as of the last reset): reading a gate whose
    last change occurred after the last reset, from the summary
    belief, is a staleness defect (the policy cannot detect it). Never-
    seen gates are fetched, not guessed.
16. **Retrieval operations are a co-primary outcome.** `retrievalOps`
    counts fetch round trips. The frozen closure rules remain on
    bytes; ops are reported because a live fetch is a tool-call round
    trip whose per-call overhead (a model call) dominates payload
    bytes. The live-cohort hypothesis this pre-registers: frontier
    retirement reduces live cost through ops, not bytes.
17. **Evidence ablation detail.** HACT layout = learned-order
    balanced8 (order learned by spectral seriation on co-invalidation
    affinity from the first 20 episodes of each stream; publication
    evaluated on the held-out second half), one-time construction =
    Σ_internal packet bytes (repo defaultCostModel), per-episode
    publication = minimal covering packets (a node covering a fully-
    changed span costs packet_bytes(arity); uncovered leaves cost
    64 B/record). Flat steel-man = better of full export (64 + 64n)
    and delta export (64 + 64|C|) per episode on the same held-out
    half, construction = 64 + 64n.
18. **Attribution-closure limitation disclosed ex ante.** The frozen
    attribution rule compares cost-per-accepted between arm 7 and
    arm 8, but the scheduler dimension is byte-neutral by design
    (amendment item 6): it affects makespan only. If the attribution
    closure triggers on bytes, the dimension-separated reading is
    mandatory: scheduler effects are read on makespan, retirement
    effects on bytes/ops. The rule's trigger will be reported with
    this limitation rather than silently reinterpreted.
