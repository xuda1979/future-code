# Adaptive HACT: v14 journal revision

**Publication status:** the source/manuscript PR is a draft. Automatic approval
review requires explicit authorization for the exact raw-observation archive
and release metadata; the public PR therefore lacks those files and cannot yet pass its evidence
gate. The full author-review package preserves them privately. See
[the concrete payload and blocker](submission/PUBLICATION_STATUS.md).

Start with the [IEEE manuscript](paper/journal.pdf),
[scientific review and response](docs/V14_REFEREE_REVIEW.md) and
[reproduction guide](docs/V14_REPRODUCE.md). This is a theory-led paper on
information limits and safe adaptation of verification evidence, with measured
applicability boundaries. IEEE Transactions on Software Engineering remains the
ambitious target. The requested PR publishes the reviewable work; it is not a
journal submission or a guarantee of acceptance.

V14 complements the pairwise-information lower bound with an **exact global
tree/permutation optimizer under exchangeable complete batches**, using
O(b n²) arithmetic operations and O(b n) states. The size-state method is a
specialization of established batch-update tree optimization, with close prior
art explicitly compared. Independent enumeration agrees in **74,245 feasible
tree comparisons across 70 cases**. The earlier conditional adoption rule and
semantic migration invariant remain intact.

The stronger no-learning baseline beats frozen full-wave cap32 refinement on
**all 15 item-shuffled traces** and loses on **all 15 file-group traces**. It costs
**21.26–62.13% more on original repeated-order holdouts**. This retrospective
re-encoding adds no upstream execution. Packaging's resource exclusion, the
historical 3 wins / 18 ties / 9 losses and the maintained-counter ledger's
service advantage remain explicit. Natural consumer and agent speedups remain
unestablished; no positive packet result is substituted for them.

The complete author-review package transports v11–v14 observations in a
hash-bound lossless archive. Public reproduction requires the pending archive
parts described above. Restore the exact original paths before any test or audit:

```sh
python tools/hydrate_observations.py
python tools/verify_manifest.py
```

See [reproduction](docs/V14_REPRODUCE.md) for dependency installation, all
historical gates and PDF builds. The release manifest includes every restored
raw file, so transport compression does not remove evidence. JSS variants are
generated from the same primary source; the extended analysis retains full
proofs and historical results.

Authors remain **Da Xu and Fei Wang**, **China Mobile Research Institute**;
correspondence **xudayj@chinamobile.com**. [Author review](submission/AUTHOR_REVIEW.md)
records final factual inputs needed before journal submission. Earlier upload
holds are superseded by the user's explicit instruction to publish this PR.

## Historical v13

The v13 review and reproduction guides remain in docs/V13_*. Its release
manifest and author handoff are preserved in historical/v13_*.

## Historical v12 and earlier records

The material below preserves prior revision descriptions; it is not the current
readiness assessment.

# Adaptive HACT: v12 journal revision

Start with the [JSS-format manuscript](paper/jss.pdf), the
[referee review and revision response](docs/V12_REFEREE_REVIEW.md), and the
[author-review guide](submission/AUTHOR_REVIEW.md).
The [IEEE version](paper/journal.pdf) is an ambitious alternative;
[full analysis](paper/main.pdf) preserves historical material.
Authors: **Da Xu and Fei Wang**, **China Mobile Research Institute**;
correspondence: **xudayj@chinamobile.com**.
**No journal submission or repository push was performed in this revision.**

V12 adds an exact fixed-eight information-separation extension, corrects the
interpretation of repeated completion patterns, and supplies two separately
frozen follow-ups. Thirty admitted dispatch-shift executions yield three wins,
eighteen ties and nine losses for primary refinement versus historical compact
selection; six initial provenance exclusions are preserved. All 240 service
ablation arms pass 10,080 answer checks. Removing byte observers reduces time
but leaves HACT slower than maintained counters for every paired block.

The contribution is an information limit and a semantic adaptation framework
with measured applicability boundaries. It is not a general agent-speedup or
service-superiority claim. See [venue decision](submission/JOURNAL_DECISION.md),
[reproduction](docs/V12_REPRODUCE.md), [theory review](docs/V12_THEORY_REVIEW.md),
and [empirical review](docs/V12_EMPIRICAL_REVIEW.md).

## Historical v11 and earlier records

The following sections preserve earlier descriptions and validation counts;
they are not the current readiness assessment.

# Adaptive HACT: v11 author review

**Read [the concise journal manuscript](paper/journal.pdf)**, then
[the author-review guide](submission/AUTHOR_REVIEW.md).
The [full analysis](paper/main.pdf) retains historical experiments and proofs.
Authors: **Da Xu and Fei Wang**, **China Mobile Research Institute**;
corresponding author **xudayj@chinamobile.com**.
**No editorial submission has been made. The user will review before submission.**

V11 adds a packet-price-general information theorem, a complete-epoch
separation with a sharp minimax penalty, independently checked references,
and optional bounded full-wave subtree refinement. Thirty actual suite runs
on six new public projects record 151,380 check executions. Primary compiler
savings are small; larger cap64 gains are explicitly secondary. Partial
source-transfer losses, slower tree service costs and Packaging resource
failures are retained. No live-agent speedup or population-level superiority
is claimed.

Start with [claims and evidence](docs/V11_CLAIMS_AND_EVIDENCE.md),
[reproduction](docs/V11_REPRODUCE.md), [data deviations](docs/V11_PUBLIC_DATA_DEVIATIONS.md)
and [independent review](docs/V11_INDEPENDENT_THEORY_REVIEW.md).
All old results retain their original version/provenance.

## Historical v10 review and earlier records

The following material records the earlier review and its then-current
validation counts. It is not the current v11 submission-readiness assessment.

# Adaptive HACT: manuscript v10 and submission-readiness review

Start with `paper/main.pdf` and `docs/V10_SUBMISSION_READINESS.md`. The authors
are **Da Xu and Fei Wang**, **China Mobile Research Institute**; corresponding
author: **xudayj@chinamobile.com**. V10 adds a proved all-topology separation,
an independent exact reference, corrected bibliography metadata and a precise
interpretation of common-codec byte equality. The v5-v9 empirical records
retain their original provenance. **No journal submission has been made**:
independent service-utility evidence and final author/venue checks remain open.

`docs/V10_CONFIRMATORY_PROTOCOL.md` proposes the next study; it is neither
preregistered nor executed. The analytical witness is not another repair,
checker trial or agent run. `docs/V9_CORRECTION_CONTRACT.md` remains the detailed
contract for the corrected service code, resource accounting and numerical audit.

## V10 analytical result

Two nine-check completion distributions have identical singleton and pairwise
probabilities but disjoint globally optimal tree sets under the implemented
packet prices. The exact reference allows every tree shape and permutation;
it considers 115,462 feasible root partitions over 511 nonempty subsets per
case. The refresh optima are 3,856 and 3,936 bytes; their shared 4,224-byte
construction cost preserves the separation. Eight tests include independently
implemented literal-tree enumeration on smaller cases. This demonstrates an
information limit of pairwise summaries, without claiming an empirical
beyond-pairwise compiler advantage.

Current local validation: **533 tests passed**, plus the independent v5/v9
audits, historical 70-entry arithmetic audit and exact v10 witness check.

## Practical recommendation

For a trusted root-status consumer, use the small status projection. For final
per-check statuses, a flat ledger may suffice. Neither needs an optimized tree.
Where intermediate hierarchical evidence is already required, compare codecs
first; then evaluate the incumbent against a compact balanced eight-ary tree on
a training-learned average-linkage order. Separate validation scores complete
completion waves. Ties retain the incumbent. The practical path calls **no exact
or block DP**. Exact DP remains an offline reference/optional candidate; block DP
is a retained ablation, not the default.

`ichact.practical` constructs this catalogue. `ichact.window.PricedWindow` still
selects among precompiled layouts using the frozen 64-event priced window.
Learning never changes the required check set or grants a publication pass.
The existing strict gate and Future Code bridge accept a precompiled layout;
the runtime is not silently converted into a live self-retuning LLM service.

## Measured v5 evidence

| Item | Result and boundary |
|---|---|
| New synthetic workloads | 27; three seeds x three families x three sizes, each with separate 128/128/256 train/validation/held-out epochs |
| Clustered held-out padded savings | 23.43%, 10.75%, 5.56% at 128, 512, 1,024 checks |
| Independent/global controls | Essentially zero; one small independent-seed gain at 512 checks |
| Source evidence | 36 layout replays of 12 archived candidates; **zero new checker or model trials** |
| Compressed savings, learned balanced vs original fixed8 | NetworkX 41.84%, Toolz 4.36%, Future Code 18.53% |
| Exact-DP negative control | Learned balanced remains larger than learned exact on all three source projects |
| Root input | Identical in 12/12 triples, 593-594 UTF-8 bytes |
| Exhaustive diagnostic pages | Fixed 148; learned balanced 95; learned exact 87; byte cap 16,384 |
| Prototype tests | 329 passed (76 new cases); Future Code separately 263 passed |
| Independent v5 audit | 27 workloads, 36 replays, 27 conditional planning scenarios, 131 numeric comparisons |
| Actual public-vocabulary BPE | UNKNOWN; no installed tokenizer or downloaded vocabulary; no byte-ratio proxy |
| Physical WAN / live LLM | NOT RUN; local TLS protocol tests are neither |

## Corrected v9 service-equal evidence

| Item | Result and boundary |
|---|---|
| Independent semantic oracle | 168/168 comparisons agree with archived-record reference answers; 84 layout-invariance checks |
| Query study | 364 paired rows over 24 trajectory/layout traces; includes Q3, both layouts and real cold/warm cache queries |
| Compressed answer bytes | 422,976 per arm; equality follows from common semantics and codec, with no storage bytes counted as traffic |
| Query cache | 182 actual hits per arm; epoch changes invalidate cached answers |
| Bounded delivery | All descriptors count inside the cap; oversized atomic items reject; complete decoding is checked |
| Frozen ablation correction | Original-order DP costs 5.12% more across all workloads (15.17% on clustered); frequency costs 7.56% more on clustered |
| Small reference correction | Maximum observed gap is 5.93%, only over permutations of one balanced topology |
| Generated manuscript evidence | Independent audit regenerates signed result prose, macros and query table and rejects tampering |

`results/v8` is retained unchanged. Its earlier service implementations bypassed
maintained query state, failed to apply the learned leaf order, left caches
unused, and could overshoot the page cap. Its storage-plus-network cost metric
and several manuscript interpretations are withdrawn. Do not cite those records
as current comparative service evidence. `results/v9` contains the corrected
retrospective execution and numerical re-analysis, not new checker or LLM trials.
The strict byte-and-time rule cannot be met under the common deterministic
codec: equal answers must produce equal wire bytes. This is a conformance
check, not a bandwidth-superiority experiment. General diagnostic and
agent-productivity benefits remain unestablished.

## Install and run

Use Python 3.11 or later; the recorded host used Python 3.13.5/Linux. A virtual
environment is recommended. `requirements-test.txt` records the tested dependency
versions. Fresh installation from a package index and Windows were not tested.

```bash
python -m pip install -r requirements-test.txt
python -m pip install --no-deps --no-build-isolation .
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q -p pytest_asyncio.plugin
python -m audit.check_v5
python -m audit.numbers_audit
python -m audit.check_v9
python -m experiments_v10.exact_separation
python tools/verify_manifest.py
```

To test the unchanged Future Code runtime separately, run the same pytest command
from `vendor/future`. Its 263 tests are not added to the prototype count.

Compile a candidate from a JSON object with exactly `registry`, `training` and
`validation` fields (waves contain canonical zero-based indices):

```bash
python tools/compile_practical.py --input examples/practical_input.json --output /tmp/hact-layout
```

The output directory must not exist. This produces `layout.json` and advisory
`selection.json`; it does not deploy a layout, edit the project or grant a pass.

Reproduce the v5 experiments in an isolated, new directory:

```bash
python tools/reproduce_v5.py --destination /tmp/hact-v5-reproduction
```

This reruns the frozen synthetic study and re-aggregates historical check records.
It does not execute hosted models, perform a WAN upload or download a tokenizer.
Detailed timings may change by host. Original BPE-unavailability records are
retained as historical provenance, not presented as a new measurement.

## Cost accounting

`ichact.deployment.assess_delivery` requires matching service IDs and explicit
application bytes, effective goodput and incremental costs. Missing values return
UNKNOWN. Distinct services return INCOMPARABLE. It uses
`gain = copies * (byte_saving / goodput - extra_per_copy) - extra_once`.
Strict equality is not a win. This is a conditional planning calculation, not a
network prediction or permission to combine unrelated timing cohorts.

## Actual tokenizer and remote-measurement tools

```bash
python tools/measure_bpe.py --cohort v5 --encoding cl100k_base --output /tmp/hact-cl100k.json
python tools/measure_bpe.py --cohort v5 --encoding o200k_base --output /tmp/hact-o200k.json
```

These require actual `tiktoken` and the requested vocabulary. They may fetch the
public vocabulary if the library is installed and its cache is absent. No provider
inference occurs. Exit 2 and null counts mean unavailable; toy counters in unit
tests are not BPE data. The dual-cap API retokenizes complete proposed pages and
never truncates mandatory packets.

`tools/tls_export_probe.py` and `tools/tls_export_receiver.py` are bounded, opt-in
measurement utilities for hosts you control. They are **not** a production server.
Read `docs/PHYSICAL_WAN_PROTOCOL.md` before any deployment. No receiver is started,
public payload uploaded, credentials searched or external service changed by the
normal tests/reproduction path. Unit TLS tests use temporary local certificates;
no private key is shipped.

## Integrity limits

The guard binds semantic IDs, source, checker, environment, epoch and generation.
A pass means the complete declared contract passed on the identified candidate,
not arbitrary program correctness. TLS authenticates a configured server, not a
checker or an entire distributed system. There is no attestation, consensus,
non-repudiation, production client-authorization service or OS sandbox. The
manifest verifies listed release bytes; it is not a digital signature.

All output commands refuse to overwrite existing measurement directories/files.
Read `docs/V5_REVISION_AND_TEST_REPORT.md` for failures, recovery, measurement
boundaries and exact validation commands. Older guides remain version-labeled
historical material, not default v5 recommendations.
