# R&D capability review — 2026-10-28

Reviewed runtime: `09e812a` on `main`. This review focuses on general research
and development lasting many iterations, with opaque external LLM APIs. The
separate recovery-continuity PR #83 was open at review time and is not included
in this change. Domain methods and evaluators remain project-owned adapters.

## Assessment

The core already has durable execution, independent acceptance, hypothesis
frontiers, finite experimental design, evaluator-guided program search,
experiment promotion, scientific findings and project knowledge. The next
capability gains should come from making these mechanisms deliver more verified
objectives with less repeated work, and demonstrating that on real projects.
Adding more agent roles alone does not establish a capability improvement.

## Priorities grounded in the implementation

| Priority | Observed boundary | Proposed next change | Evidence to require |
| --- | --- | --- | --- |
| 1 — implemented here | Automatic project context used the newest three cards matching any term; a 512-character joined query could exclude scope/check identifiers. See `SwarmDriver.execute` and `ProjectKnowledge.search`. | Preserve query sources, rank distinct matches, select complementary coverage, authenticate selected cards, and retain the original explicit search API. | An old specific reference survives newer broad matches; long goals retain scope/check retrieval; unchanged private-source, byte, replay and acceptance boundaries. |
| 2 — independent search progress | `discoveryRuntime.ts` admits one whole round at a time and stops on a failed round. A slow family delays the next round; one completed adapter failure blocks further search. | Add opt-in per-family progress and recovery budgets on the existing scheduler. Persist proposal/evaluator checkpoints; distinguish rejected candidates from infrastructure failures. Preserve a diversity floor and frozen search ceilings. | Inject a slow or malformed proposer in one family while healthy families continue. Bound all extra calls, preserve candidate lineage, reproduce restart behavior, and retain independent evaluations. |
| 3 — reuse across replanning | `experimentBinding` and `experimentPromotion` bind ordinary experiment reuse to both run and task. A new task/run cannot reuse a previous expensive execution, even if project inputs are identical. | Add an opt-in project experiment catalogue for eligible replay-safe computation, with exact code/data/environment/adapter/input identities, permission checks and explicit replicate IDs. Reuse observations as computation evidence, not as new independent replications. | A replan avoids duplicate eligible work; a changed dependency, seed, environment, grant or external effect rejects reuse. Final acceptance independently rebuilds its evidence. |
| 4 — one durable objective path | Interactive `/goal` has durable host continuation but reaches REVIEW from a goal-file declaration; `/loop` supplies instructions. Foundry/Swarm has the stronger independently verified objective lifecycle. These paths remain separate. | Offer an explicit bridge from a reviewed objective/specification to `swarm supervise`, with shared status and recovery reporting. Project packs supply the research tools and validators. Keep ordinary small interactive tasks lightweight. | Run the same multi-day objective through interruption, model outage, remote-job reconciliation and final acceptance from the user-facing entrypoint. A model's completion statement must not certify the objective. |
| 5 — capability measurement, alongside every change | `validateProjectPair` permits recipe differences on one runtime. The existing runner does not itself compare runtime revisions or strong external agents. Offline fixtures establish mechanisms, not research productivity. | Extend the evaluation harness with pinned runtime/agent adapters and held-out, multi-step R&D objectives. Compare equal-model harnesses separately from best-product comparisons. | Measure verified objectives/hour, acceptance rate, paid requests, repeated experiments, recovery loss, wall time and complete dollar measurements where available; keep failed trials and missing values. |

The second and third items are likely to save substantial work when experiments
are slow or objectives are frequently replanned. That is an engineering
hypothesis, not a measured speedup. Prioritize them using traces from actual
objectives, including tasks that a simpler agent cannot finish within the same
budget. Preserve the existing >=2x long-R&D throughput target as an unachieved
acceptance target, not a claim about this PR.

## Scope and evidence for the implemented change

The change uses the existing literal term index and immutable cards. It adds no
embedding service, model request, scientific authority, domain policy or schema
migration. Ordinary chronological searches and their keyset cursors remain
available, including for reading multipart human guidance.

Two production-worker regressions reproduce the missed reference on the old
implementation: forty newer broad matches hide an older specific reference;
and a long goal displaces the task's file/check identifiers. With ranked context,
both references are delivered while the same two scripted model replies produce
a patch that passes the existing independent check. Additional tests cover
complementary selection, filters before the candidate cap, byte bounds, source
integrity, restart determinism and trust revocation.

This is a retrieval improvement. It does not show that a live LLM will use the
reference correctly or finish more research objectives. Retrieval remains
literal; synonyms, repeated high-scoring generic cards, and references outside
the 32-candidate pool can still be missed. SQLite aggregates matching index
postings, so the candidate cap is not a constant-time guarantee. A live paired
evaluation should measure downstream experimental repetition and verified
completion before assigning a productivity gain.

## Practical validation sequence

1. Keep the frozen objective, independent evaluator, model access, initial
   knowledge and resource budget identical across runtime revisions.
2. Include development/debugging, a computational research search, and an
   objective with remote experiments and interruptions. Put domain validators
   and data in project fixtures rather than the shared runtime.
3. Alternate revision order, retain failures, and record the exact knowledge
   cards exposed to each task. Include both cold-start and accumulated-history
   conditions so memory quality is distinguishable from additional knowledge.
4. Require improved verified completion or reduced work at equal acceptance,
   without weakening checks, bypassing permissions, resetting budgets or
   relabeling reused observations as independent evidence.

No live paid model experiments were run for this review.
