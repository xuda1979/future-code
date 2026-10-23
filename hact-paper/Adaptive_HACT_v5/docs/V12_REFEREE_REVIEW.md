# HACT v12 internal referee review and revision response

Date: 2026-10-21. Reviewer: AI-assisted internal review coordinated by Codex,
with separate mathematical and empirical checks. This is not external human
peer review. The review began from local v11 commit
`e67afe9c3950b9b1d3691a3c62a066893cb9ac1f`.

## Editorial assessment

V11 required major scientific revision before a credible submission. Its
strongest result was the exact information separation, but the connection to
fixed batching was incomplete and the practical evidence was easier to
overinterpret than the text acknowledged. V12 resolves those specific issues
through a proof extension, new controlled executions, a frozen service ablation,
and explicit limits on inference. The resulting paper is a defensible
theory-and-systems boundary study for JSS. TSE is a higher-risk alternative:
the significance of this particular packet objective and the narrow consumer
cohort remain potential rejection grounds. Formatting cannot resolve them.

The empirical negatives are part of the scientific result. Neither the reviewer
nor the authors should promote secondary endpoints, remove losses, or describe
complete repeated suites as independent generalization evidence.

## Major issues and completed response

| Referee concern | Revision and evidence | Remaining scope |
|---|---|---|
| The complete-epoch theorem uses three variable windows, unlike fixed-eight execution. | Added an exact uniform filler-allocation lemma and a 24-check fixed-eight construction. All singleton and bivariate completion-rank laws agree, but the two feasible embedded layouts prefer opposite actions. Exact references, exhaustive small-width allocations and 600 deterministic supported-sequence checks validate implementation. | Candidate-class/local obstruction; no global 24-leaf optimum claim. |
| “More samples cannot help” overstates equality of population summaries. | Replaced that sentence with an explicit exact-population information interface; explained that empirical summary-vector fluctuations can carry higher-order information. | No finite-sample statistical-equivalence or real-valued timing-law theorem. |
| The novelty claim blends established methods with the contribution. | Added an ingredient/contribution table and narrower claims for alphabetic DP, clustering, epochs/fencing, subtree refinement, validation and codecs. | No priority claim for trees, hypergraphs, caching, seriation or ordinary DP. |
| Held-out processes may repeat training patterns. | Independently fingerprinted all 30 original traces. All five admitted projects repeat identical completion orders and objective wave partitions across runs 0–4. The abstract, protocol, results and threats now state this. | The original split establishes repeatability, not unseen-pattern prediction. |
| Headline sample size is misleading for optimized comparisons. | Distinguished 151,380 total executions from 16,640 in the five-project admitted cohort; Packaging supplies 89% of the total and remains excluded from fitting. | Five convenience-sampled projects; individual checks are not independent projects. |
| There is no direct controlled transfer test for completion schedules. | Frozen layouts were evaluated on actual file-group and item-shuffled suite executions, three fixed seeds each. Initial 30 executions plus 6 provenance-repair executions yield 30 admitted comparisons and 6 preserved VOID records. Primary outcomes versus historical selection are 3 wins / 18 ties / 9 losses. | Artificial dispatch interventions; no natural workflow prevalence or causal higher-order-effect inference. |
| Service timing includes costly byte-count instrumentation. | Kept v11 observations intact and ran a new eight-arm ablation crossing four services with instrumentation on/off. All 240 executions and 10,080 oracle/codec checks passed. HACT remains slower in all 30 paired blocks in both states. | Observer-disabled prototypes, not optimized production services. |
| New experiments could inherit incomplete environment identity. | Froze duplicate-aware package/location inventories and source/input hashes before both follow-ups. A missing generated ExceptionGroup metadata hash caused six explicit VOID results; a separately frozen child reran all six schedules. | The improved v12 provenance does not retroactively repair v11 identifiers. |
| Timing repeats might support exaggerated significance. | Added paired descriptive ranges and retained ratio-of-case-median estimands. No confidence interval, population superiority test or pseudo-replication claim. | Host-specific repeated measurements. |
| Submission preparation lacks a realistic venue and complete source package. | Prepared attributed and blinded elsarticle variants, IEEE alternative, flat source ZIPs, unsent JSS letter, highlights, provenance, reproduction guide and review checklist. | Current portal-specific rules could not be verified through HTTP403 pages; final author facts remain unasserted. |

## Interpretation after revision

The persistent-refresh global-optimum theorem and the six-check complete-epoch
theorem remain valid. The new lift establishes a stronger information-interface
result without changing their assumptions. Exact population pairwise laws do
not determine every subtree-hit probability, even under equal-width complete
batching. This justifies retaining full completion sets when the stated packet
objective matters; it does not prove that a learned tree is useful for ordinary
status queries.

Primary cap32 refinement is not robustly beneficial across the tested shifts.
The service ablation closes the observer-cost confound without revealing a
speedup. With observers disabled, project ratios of mean case-median HACT/counter
operation times are 1.61–3.54; all 30 paired-block ratios are above one. A
maintained-counter ledger is the supported default for this controlled demand.
Different consumers, sparse large-registry fitting and natural maintenance
histories are future research questions, not missing positive numbers to invent.

## Evidence and verification map

- Mathematical review and exact certificate: `docs/V12_THEORY_REVIEW.md`,
  `results/v12/fixed_batch.json`, `tests_v12/test_fixed_batch.py`.
- Original evidence interpretation: `docs/V12_EMPIRICAL_REVIEW.md`,
  `results/v12/robustness.json`.
- Dispatch protocols and raw data: `docs/V12_SCHEDULE_SHIFT_PROTOCOL.md`,
  `docs/V12_GENERATED_METADATA_REPAIR.md`, `results/v12/schedule_shift/`,
  `results/v12/schedule_generated_metadata/`.
- Service protocol and raw data: `docs/V12_SERVICE_ABLATION_PROTOCOL.md`,
  `results/v12/service_ablation/`.
- Independent follow-up audit: `audit/check_v12.py` and its corruption tests.
- Manuscript arithmetic projection: `experiments_v12/report.py`,
  `results/v12/manuscript_numbers.json`.
- Final checks: `.ai-loop/v12/reports/author_review_checks.json`.

No journal submission, external message, consent attestation, paid service or
repository push was performed during this revision. The earlier automatic
approval rejection of a GitHub push remains in force; this pass does not retry it.
