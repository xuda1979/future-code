# Adaptive HACT v5 — Revision and test report

## Scope

This release revises the v4 paper and artifact in response to the compiler,
cost-benefit, physical-WAN and BPE feedback. The no-DP practical catalogue is now
primary. Exact DP is a reference; block DP is an appendix ablation. Missing
physical-WAN, actual BPE, live-model and natural-bug experiments remain explicit.
The manuscript is not claimed accepted or publication-ready by an outside review.

## New runtime/API work

- `ichact/practical.py`: original/incumbent and learned-order compact balanced8
  layouts; deterministic ties, registry/cap validation, no exact/block fitting.
- `ichact/deployment.py`: service-matched conditional gain, strict break-even,
  explicit missing/negative/invalid-input handling and decimal arithmetic.
- `ichact/token_budget.py`: whole-text tokenizer invocation and dual byte/token
  admission. Test-only counters are labeled and not published as BPE data.
- `ichact/tls_probe.py`: verified TLS connection, bounded framed transfer, digest,
  length and packet-count acknowledgment checks. Local compatibility only.
- Opt-in CLI tools for practical compilation, actual BPE measurements and authorized
  TLS measurements; isolated v5 reproduction launcher; independent v5 audit.

The original Future Code runtime is unmodified. The prototype's release-version
assertion now checks **5.0.0** in both package metadata and runtime; it was not
removed or weakened to make tests pass.

## Executed experiments and counts

| Category | V5 scope |
|---|---|
| Fresh synthetic layout workloads | 27 = 3 sizes x 3 families x 3 seeds |
| Per workload | 128 train, 128 validation, 256 held-out epochs |
| New serialization replays | 36 layouts over 12 archived logical candidates |
| New source checker / model trials | 0 / 0 |
| Conditional deployment scenarios | 27 = 3 codecs x 3 rates x 3 overhead assumptions |
| Actual BPE attempts | 2 requested encodings; both UNKNOWN; no counts |
| Physical-WAN trials | 0; no authorized remote endpoint pair |
| New unit/contract/tamper tests | 76 |

Frozen inputs are in `docs/V5_EXPERIMENT_CONTRACT.json`; raw observations are in
`results/v5/`. Historical v3/v4 records retain their provenance and are not new
success trials. Synthetic ranges summarize three seeds, not a confidence interval
obtained by treating every episode as an independent deployment.

## Observed results

Clustered held-out padded savings are 23.43%, 10.75% and 5.56% at 128, 512 and 1,024
checks. Independent/global controls have essentially no improvement. The practical
catalogue still spends about three seconds learning an order at 1,024 checks on
this host; no per-action hot-path speedup is claimed.

The balanced source replay reduces whole-epoch compressed bytes by 41.84%, 4.36%
and 18.53% for NetworkX, Toolz and Future Code. It remains 11.68%, 1.52% and 6.67%
larger than the learned exact layout in those same projects. This is the explicit
quality-cost trade-off, not a claim that balanced fitting is the byte optimum.
Root cards are identical in all 12 triples, at 593-594 bytes. Exhaustive page counts
are 148 fixed, 95 balanced, 87 exact, with a 16,384-byte request cap.

Fixed and balanced compressed bytes total 416,046 and 299,081. At an assumed
64 KiB/s and zero additional per-copy processing, their modeled difference is
1.784744 seconds per twelve-candidate cohort copy. With assumed once-per-candidate
extra costs of 0.05/0.5/5 seconds, the minimum profitable copies of that same cohort
are 1/4/34. These assumptions do not import measured overhead from another fixture.
There is no new WAN or end-to-end speed measurement here.

## Tests and independent checks

Commands used:

```bash
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q -p pytest_asyncio.plugin
# Then run the same command from vendor/future, separately.
python -m audit.check_v4
python -m audit.check_v5
python tools/compile_practical.py --input examples/practical_input.json --output NEW_DIR
python -m pip install --no-deps --no-build-isolation --target NEW_INSTALL_DIR .
python tools/reproduce_v5.py --destination NEW_EXTERNAL_DIR
```

Development tree: **329 passed**, no failures/errors/skips in the final run.
The unchanged Future Code suite: **263 passed** separately. XML results and raw
logs are saved under `results/v5/`. The installed-package smoke compared **22
runtime Python files** with source and exercised balanced selection, current full
contract authorization, compression roundtrip and strict break-even. It ran using
the installed package outside the project import path. This was an offline local
build/install, not a fresh package-index installation or Windows test.

The v5 independent auditor imports no producer optimizer, selector or codec. It
recomputes initialization/wave costs, held-out selection, serialized envelopes and
compression, stable source/result identities, page counts, root invariance,
27 break-even scenarios and **131 summary numerical comparisons**. The earlier
v4 independent audit was also rerun. A full isolated reproduction reran the 27
frozen workloads, all source replays, planning and tests (329 passed); all scientific
records were identical except measured fitting times. Replayed source/planning
JSON bytes were identical. This is an independent implementation path,
not an external security assessment. The final release verification sidecar records
extracted-ZIP tests, source-file hashes and archive integrity.

## Failures, recovery and transparency

1. The first synthetic command exceeded the execution time limit after 26 complete
   records. No worker remained. Explicit resume skipped the recorded cases and
   completed the remaining frozen case without changing input/selection policy.
2. A new `test_audit.py` collided with an old module basename; it was renamed to
   `test_v5_audit.py`. The collection failure log is retained.
3. The old runtime/version assertion initially disagreed with 5.0.0 metadata.
   Both explicit version declarations were updated together; the check remains.
4. During planning-script development, an absent method label produced an empty
   aggregation. Complete-pair and positive-byte validation plus tamper tests now
   reject that case. Invalid intermediate output was replaced before reporting;
   final results were independently reconstructed from real method labels.
5. Both tokenizer attempts lacked `tiktoken`; package/vocabulary retrieval failed.
   A connector-discovered alternative artifact was expired. No toy BPE or byte
   ratio was used. Both output records say UNKNOWN with null counts.
6. No physical-WAN hosts or designated LLM endpoint were provided or found through
   an authorized measurement configuration. No private credential search or public
   evidence upload was attempted.

## Runtime and reproducibility

Recorded environment: Linux x86_64, Python 3.13.5, NumPy 2.3.5, SciPy 1.17.0,
pytest 9.0.2, pytest-asyncio 1.3.0, HTTPX 0.28.1. Full environment metadata is in
`results/v5/environment.json`. Existing benchmark source versions remain vendored
with their provenance/license notices. Package files are checksum listed; the
manifest is not a digital signature. PDF sources and all historical data needed
for the audits are included. No font files or temporary certificate private keys
are shipped.

## Remaining evidentiary gaps

Actual public-vocabulary BPE, paired physical-WAN delivery, live-LLM patches,
natural historical bugs and production multi-host deployment remain unmeasured.
The provided instruments and their local tests do not close those gaps. The
strongest supported result is conditional reduction of the required diagnostic
evidence, not universal local runtime, token-cost or autonomous-agent improvement.
