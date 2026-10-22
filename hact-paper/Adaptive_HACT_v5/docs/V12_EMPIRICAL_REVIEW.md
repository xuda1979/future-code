# V12 empirical referee review and descriptive robustness checks

Reviewed 2026-10-21 against the v11 manuscript, measurement implementations,
frozen public-suite records, compiler receipts, source transfers and service
trials. This is an AI-assisted internal review, not external peer review.
The initial robustness analysis is retrospective. A separately frozen follow-up
experiment is documented at the end of this review.

## Assessment

The retained arithmetic and experimental provenance support the narrow claims
made about these observations. The strongest remaining problem is scientific
interpretation: every admitted project's training, validation and held-out
executions have the same completion pattern. The second problem is that service
timings include instrumentation that serializes state to calculate accounting
metrics. These findings need explicit treatment in the manuscript before it is
described as submission-ready. Neither defect licenses discarding unfavorable
data or inferring a speedup from another endpoint.

The evidence supports a representation model, bounded fitting on observed
patterns, semantic conformance, and an unfavorable measured service comparison.
It does not establish predictive generalization to unseen completion patterns,
production demand, intrinsic data-structure speed, or agent productivity. A
top-journal case must therefore stand on the information results and a useful
engineering boundary, not the apparent size of the execution count.

## Material findings and required revisions

| Finding | Evidence | Required manuscript treatment |
|---|---|---|
| Training and held-out packet objectives repeat the same pattern | For Click, Jinja, Pluggy, attrs and ExceptionGroup, all five normalized executions have one identical completion order and one identical multiset of eight-completion waves. Packaging alone has two patterns and was excluded from optimization. | Call the public split a repeated-execution holdout. State that it tests repeatability of fitting and recording, not generalization to new completion patterns. Validation cannot reveal pattern overfitting in this cohort. |
| The headline execution count is dominated by the excluded project | Packaging contributes 5 × 26,948 = 134,740 of 151,380 executions, approximately 89.0%. The admitted five-project compiler cohort comprises 25 runs and 16,640 check executions. | Report the six requested and five admitted projects prominently. Do not use 151,380 as the denominator of successful compiler or service evidence. The complete execution count remains correct and should be retained with its scope. |
| Timings include accounting instrumentation | `IndexedFlatLedger._ingest` serializes its full index and ledger each batch to calculate `storage_bytes`; `HactService._ingest` serializes records, positions, layout and capsules for that metric. Both `record_of` paths serialize accessed rows to count scanned bytes. The outer service timer includes this work. | Call the values instrumented-prototype operation times. They are real observations but do not isolate the minimum cost of the underlying data structures or predict optimized deployment performance. If an instrumentation-free sensitivity is added, it needs a separate frozen experiment and must retain v11 unchanged. |
| The service disadvantage is robust to the reported aggregation choice | All 30 matched timing blocks have HACT32/counter ratios above one, ranging 1.21624–2.85011. Each of the ten trace-level paired medians is above one. | Add a short descriptive sensitivity sentence. Do not turn 30 correlated blocks into a population sample or confidence interval. |
| Three repeats expose nontrivial host variability | The largest within-trace max/min for either compared arm is 1.40963, on Click run 4's counter arm. The largest relative difference between median paired ratios and ratio of arm medians is 5.15415%. | Preserve the stated original estimand and report the range as sensitivity. The observations cannot establish stable absolute latency on other hosts. |
| Units need consistent naming | The service file has 12 requested trace inputs: ten admitted traces from five projects and two resource-excluded Packaging traces. Each admitted trace has three timing blocks and four arms. | Use “five projects, ten held-out traces, three timing repeats per trace” rather than alternating between five and ten “cases.” The 5,040 answer checks are conformance checks, not experimental units. |
| The controlled consumer is unusually favorable to a maintained ledger | Queries use fixed groups, status, missing IDs, failures, coverage and replay. The counter ledger maintains counts for the declared groups; complete lists still require record access. | Keep the ledger as a strong relevant control, but describe the demand contract as controlled. Do not generalize either arm's outcome to arbitrary subtree queries or production diagnostic demand. |
| The largest registry was not measured to exhaustion | Packaging's exclusion is a declared preanalysis resource admission. The approximately 5.81 GB dense matrix requirement is arithmetic; no full compiler OOM or measured RAM trace was produced. | Prefer “resource exclusion” or “optimization UNKNOWN” to wording suggesting an observed runtime failure. Retain its complete records and do not count the fallback as a successful learned method. |
| Real execution does not make historical transplants native bug episodes | The eleven candidates transplant old production modules into newer unchanged release tests; three are VOID and one resource UNKNOWN. Seven priced transfers produce two wins, three ties and two losses. | Retain the explicit exploratory label. These traces provide useful changed-pattern stress tests and counterexamples to universal adoption, not a benchmark of eight certified natural bugs. |

The fixed-wave objective is an initial construction cost plus a sum of touched
packet costs over waves. Thus equality of the wave multiset makes the objective
equal for **every** layout, not merely the six measured candidates. The new
fingerprint check distinguishes the completion sequence, ordered wave sets,
and the objective's unordered wave multiset; it does not infer objective
identity merely from equal byte totals.

## New descriptive sensitivity result

For each trace and repetition, form the ratio of its measured HACT32 operation
sum to the counter ledger operation sum from the same randomized-order block.
The numerator and denominator are observations of instrumented prototypes on
the same host, executed sequentially within the block. The ratio is not a
simultaneous hardware control. Ratios below are rounded for presentation;
the JSON records exact rational ratios of the persisted decimal times.

| Held-out trace | Paired ratio min–max | Median paired ratio | Ratio of arm medians |
|---|---:|---:|---:|
| Click run 3 | 2.371–2.498 | 2.498 | 2.391 |
| Click run 4 | 1.910–2.850 | 2.382 | 2.329 |
| Jinja run 3 | 2.387–2.408 | 2.406 | 2.387 |
| Jinja run 4 | 2.000–2.669 | 2.193 | 2.306 |
| Pluggy run 3 | 1.216–1.659 | 1.447 | 1.447 |
| Pluggy run 4 | 1.462–1.639 | 1.552 | 1.552 |
| attrs run 3 | 2.327–2.575 | 2.361 | 2.361 |
| attrs run 4 | 2.482–2.613 | 2.561 | 2.491 |
| ExceptionGroup run 3 | 1.383–1.471 | 1.421 | 1.421 |
| ExceptionGroup run 4 | 1.439–1.493 | 1.445 | 1.454 |

The existing manuscript's ratio of mean trace-median times remains unchanged:
Click 2.35896, Jinja 2.34526, Pluggy 1.50082, attrs 2.42324 and ExceptionGroup
1.43714. These are different descriptive aggregations of the same observations.
No project-level significance test, bootstrap confidence interval or new
experimental success rate is added.

## Proposed manuscript sentences

For the public execution protocol:

> All five admitted projects produced exactly the same completion order and
> wave partition in their five process runs. Their held-out packet costs
> therefore assess repeatability on one observed completion pattern per project;
> they do not test generalization to unseen patterns. Packaging produced two
> patterns but was excluded by resource admission. The six-project campaign
> contains 30 complete runs; the admitted compiler cohort contains 25 runs and
> 16,640 check executions.

For service results:

> A retrospective descriptive check retains all ten admitted traces and all
> three timing blocks per trace. HACT32 is slower than the counter ledger in
> each of the 30 matched blocks, with ratios from 1.216 to 2.850. The maximum
> within-trace max/min for either arm is 1.410. These ranges describe the observed
> host and do not form a confidence interval or add independent project samples.

For the timing boundary:

> These instrumented-prototype timings include canonical serialization used to
> count logical storage and scanned bytes. They measure the retained services
> with that accounting enabled; they do not isolate the intrinsic update or
> query complexity of the data structures. The unfavorable comparison is
> sufficient to reject a speedup claim for this implementation and demand,
> while optimized deployment performance remains unmeasured.

For the contribution and abstract:

> The empirical component is a bounded case study and deployment-boundary
> evaluation. Across five admitted projects, primary packet savings occur on
> two repeated patterns and are small; exploratory changed-source transfers
> include losses. The instrumented service is slower than the maintained-counter
> control. The analytical information limit is therefore the central positive
> result, and is not an empirical agent-acceleration result.

## Fairness and integrity checks that passed

- Both compared services receive the same immutable snapshots and declared
  request schedule. Common snapshot preparation and the reference oracle are
  outside their operation timers. Construction, every ingest, queries and codec
  round trips are inside those timers; fitting is separately reported.
- Arm order is randomized within each of three repeated blocks. No unfavorable
  arm or timing block was dropped. Packaging's two exclusions remain UNKNOWN.
- Answer, epoch, page and raw/compressed byte signatures agree across all arms
  and repeats of each retained trace. Common codec byte equality is an expected
  conformance property and is already correctly distinguished from superiority.
- The primary cap32 comparison and secondary cap64 comparison retain their
  predeclared roles. Same-order refinement can isolate a topology change,
  but does not establish that higher-order information caused the practical
  improvement. The existing manuscript correctly preserves this distinction.
- Old v11 evidence files are unchanged. The new projection binds its inputs,
  checks the frozen case manifest and source hashes, rejects missing arms,
  duplicate repetition identities, invalid times, mismatched query slots,
  inconsistent answer/codec signatures and hidden UNKNOWN cases.

## Reproduction and limits

```sh
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q tests_v12/test_robustness.py
python -m experiments_v12.robustness --check
```

Sixteen focused tests pass, including a fixture where median paired ratios and
ratio of medians differ, preservation of an unfavorable repeat, and deliberately
corrupted timing/codec/cohort records. `results/v12/robustness.json` contains the
projection and all 30 source-trace hashes. The independent v11 raw-record audit
remains necessary for semantic correctness; this descriptive projection does
not replace it or retrospectively establish a complete environment identity.
## Separate follow-up: disabling observational byte serialization

After the preceding retrospective review, the root agent froze
`docs/V12_SERVICE_ABLATION_PROTOCOL.md` before a new timing campaign. This is a
separate follow-up experiment, not a correction to or replacement of v11 data.
The implementation was independently inspected by the root agent before launch.
`results/v12/service_ablation/FROZEN_INPUTS.json` records 78 source, protocol,
test, and input hashes, a fixed 30-block randomized eight-arm schedule, and a
runtime inventory containing all 127 discovered distribution records. Duplicate
entries for attrs, packaging, pip, and pluggy are retained. The source and input
hashes still match after execution.

The four original services and four subclasses with observational byte
serialization disabled used the same ten admitted traces, unchanged fitted
layouts, eight-completion ingestion, three repetitions, semantic cache, and
answer workload. The subclasses remove only build, update, storage and scan
byte observation. Record copying, identity/evidence digests, kernel refresh and
packet serialization, maintained counters, validation, answer paging,
compression and decompression remain. Disabled byte measurements are stored as
null. The common answer-method implementation is inherited unchanged; actual
service wire lengths and decoded semantics are checked against independently
reconstructed oracle pages. `oracle_wire_sha256` identifies those reconstructed
expected wire bytes, not an independently captured transport stream.

The correctness preflight passed 168 oracle/codec checks, including rewind and
foreign snapshot rejection for all eight arms. The campaign completed in
190.325 seconds: 240 successful service trajectories and 10,080 answer checks.
Both Packaging traces remain UNKNOWN under the frozen registry-size admission
rule, so whole-cohort status remains UNKNOWN while admitted-case status is
PASS. No timing-driven implementation changes or reruns were made. Parent
coordination paused the other local process campaign during timing; this does
not establish an otherwise exclusive or production-representative host.

Selected cap-32 HACT was slower than the maintained-counter ledger in all 30
paired timing blocks with the original byte observers and all 30 blocks with
those observers disabled. The paired ratios ranged from 1.144480 to 2.858308
with instrumentation and from 1.134876 to 4.630073 with byte observers disabled.
These are observed ranges, not confidence intervals. The three repeats of each
trace do not create independent projects.

| Trace | Instrumented HACT/counter, ratio of arm medians | Byte observers disabled HACT/counter, ratio of arm medians |
|---|---:|---:|
| click_run_3 | 2.139702 | 3.066464 |
| click_run_4 | 2.185229 | 3.156766 |
| jinja_run_3 | 1.964252 | 3.095146 |
| jinja_run_4 | 2.562594 | 3.268461 |
| pluggy_run_3 | 1.353115 | 1.698288 |
| pluggy_run_4 | 1.543135 | 1.535252 |
| attrs_run_3 | 2.771953 | 3.451210 |
| attrs_run_4 | 2.505393 | 3.623242 |
| exceptiongroup_run_3 | 1.404976 | 1.975532 |
| exceptiongroup_run_4 | 1.457971 | 1.880655 |

For continuity with the original project aggregation, ratios of the mean
trace-median service times are:

| Project | Instrumented | Byte observers disabled |
|---|---:|---:|
| Click | 2.163406 | 3.111690 |
| Jinja | 2.231855 | 3.178695 |
| Pluggy | 1.448301 | 1.614746 |
| attrs | 2.635452 | 3.540312 |
| ExceptionGroup | 1.429087 | 1.923025 |

Disabling the byte observers decreased the median operation sum for each of
the four arms on every admitted trace. The counter ledger retained
20.55–70.07% of its instrumented median time; selected HACT retained
25.59–90.38%. Their relative decreases are heterogeneous, including a slightly
smaller HACT/counter ratio on Pluggy run 4. At project aggregation the relative
HACT/counter gap increased for all five projects. Thus observer costs materially
affect the numerical ratios but do not explain away the negative service result
on this workload. This does not predict the costs of optimized production
implementations, nor does it estimate network or end-to-end agent performance.

Suggested manuscript sentence:

> In a separately frozen eight-arm follow-up retaining all functional kernel
> and answer-codec work, removing observational byte serialization reduced
> absolute prototype times but selected HACT still exceeded the maintained
> counter ledger in every one of 30 matched timing blocks; observed ratios were
> 1.13–4.63. These local descriptive timings do not establish production costs.

`experiments_v12/observer_ablation.py check` verifies the frozen source/input
identity and reproduces `SUMMARY.json` from `raw.json`. A separate read-only
audit checked all 240 execution identities against the frozen schedule,
operation/query timing sums, nonnegative finite times, 42 query rows per arm,
all semantic/oracle-wire signatures, and both exclusions. The original
robustness projection still verifies. The combined robustness and observer
ablation test suites pass all 31 tests.
