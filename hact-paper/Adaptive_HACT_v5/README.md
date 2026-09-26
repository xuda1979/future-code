# Adaptive HACT v5.0

**Service-Matched Verification Evidence and Deployment Boundaries**

Start with `paper/main.pdf`, `docs/RESPONSE_TO_REVIEWERS.md`, and
`docs/V5_OPERATING_GUIDE.md`. This is a research artifact, not a production
security service or an accepted conference paper.

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

Historical v3/v4 observations are preserved separately. In particular, the older
288 loopback transfers, exact-layout savings, and strict-wrapper timing are not
new v5 tests or measurements of the new balanced default.

## Install and run

Use Python 3.11 or later; the recorded host used Python 3.13.5/Linux. A virtual
environment is recommended. `requirements-test.txt` records the tested dependency
versions. Fresh installation from a package index and Windows were not tested.

```bash
python -m pip install -r requirements-test.txt
python -m pip install --no-deps --no-build-isolation .
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q -p pytest_asyncio.plugin
python -m audit.check_v5
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
