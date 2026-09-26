# Adaptive HACT v3.0 — revision and test report

## Delivered scope

Current 19-page paper; LaTeX source and generated plots/tables; stable-ID layout
compiler and migration guard; coupled fixed-share catalogue controller; strict
pytest CLI; actual Future Code acceptance bridge; experiments, raw observations,
independent auditor, reproducibility launcher, and source/vendor notices.

This is the verification research prototype plus an integration plug-in for the
previously delivered Python companion. It does not restore the missing engine
from the user's original truncated source archive or claim to replace its UI.

## Verification actually completed

| Check | Observation |
|---|---|
| Prototype full suite | 187 passed; zero failures/errors/skips |
| Vendored Future Code v1.2 suite | 263 passed |
| New I/O fixture | 40 checks passed on its trusted baseline |
| Ordering experiment | 80 workloads: 4 families × 20 seeds; 40,960 held-out episodes |
| Online experiment | 80 streams × 2,048 = 163,840 events |
| Source replay | 33 archived v2 cases; not called fresh data |
| Fresh source checking | 24 paired candidate executions plus 3 baselines and 3 restorations |
| Actual primary harness campaign | 9 episodes across direct/fixed/learned gates; 2 parallel workers |
| Reproduction launcher functional smoke | New destination; 3 additional three-mode episodes, excluded from primary timings |
| Independent audit | 63 packet streams, 2,305 packets, 32 bootstrap comparisons plus all recorded cost paths |
| Installed-package smoke | 15 runtime Python files matched source hashes; installed real pytest bridge accepted correct code and rejected an injected fault |
| PDF QA | All 19 pages rendered and visually inspected; no overfull LaTeX boxes in final build |

The standalone release-verification JSON supplies final extracted-ZIP test output,
manifest counts and archive hash. Do not infer those from a draft filename.

## Primary measurements

On shuffled synthetic clusters, selected learned display order reduces bytes by
26.38% relative to original-order DP, with seed-bootstrap interval [25.94%,26.79%].
The independent control is -0.04% with an interval crossing zero. The finite
catalogue uses standard spectral/cluster proposals and an exact full-wave tree
compiler; no global permutation optimality is claimed.

Online coupled share has a mean long-shift cost ratio 0.845 relative to frozen
including migration. It is 7.88% worse on stationary streams and 16.45% worse on
rapid shifts. A priced window heuristic does better in several regimes. These
negative results are retained. The theorem requires a fixed catalogue and
exogenous full-information loss sequence; it is not a guarantee for a reactive
LLM manager or a continually changing candidate family.

Fresh source checks emit 16.63–56.14% fewer certificate bytes than fixed8, but
aggregate outer-wrapper duration is essentially unchanged: 39.69 s vs 39.77 s.
The actual harness emits 97,920 bytes in both strict layouts. Median episodes are
12.98 s direct, 18.11 s strict fixed8, and 18.12 s strict learned. The added strict
protection is measurable overhead, not a demonstrated speedup.

## Actual commands

```bash
python -m pytest -q tests tests_v1 tests_v3 --junitxml=results/final_tests.xml
(cd vendor/future && PYTHONPATH=src python -m pytest -q)
OPENBLAS_NUM_THREADS=1 python -m experiments_v3.bench ordering
OPENBLAS_NUM_THREADS=1 python -m experiments_v3.bench online
OPENBLAS_NUM_THREADS=1 python -m experiments_v3.bench scaling
python -m experiments_v3.real_sources replay
python -m experiments_v3.real_sources run
python -m experiments_v3.harness --repetitions 3
python -m experiments_v3.summarize
python audit/check_v3.py
python -m experiments_v3.figures
(cd paper && pdflatex -interaction=nonstopmode -halt-on-error main.tex)
```

Use the isolated reproduction launcher rather than overwriting released outputs.
Some older logs record early intermediate suites (179/185 tests); the current
full suite is 187. Those development logs are retained as provenance, not current
acceptance evidence. Functional smoke under concurrent test load is not part of
the primary timing comparison.

## Trust and correctness boundaries

Every pass refers to a full approved registry and identified source/checker/
environment. The stable-ID migration layer rebinds canonical evidence and revokes
old tickets. Legacy contracts must be reviewed and reinitialized rather than
silently updated. Private file copies and hashes are not a sandbox: hostile code
must run behind an appropriate external isolation boundary with no access to
trusted contracts or secrets. A local report is not an atomic external merge.

An initial draft summary used the wrong name for the selected-method cohort,
which would have produced empty sums. The issue was detected during inspection,
fixed before publication, and replaced with an explicit nonempty paired-cohort
check. No zero-imputed or erroneous draft measurement appears in the current
paper. The independent auditor cross-checks cohort membership and actual bytes.

## Not tested or not established

Hosted model inference and autonomous patch discovery; provider token usage or
billing; natural historical bugs or SWE-bench; Windows; multi-host service;
production safety or performance; long-duration drift under reactive agents;
complete software correctness beyond approved checks; global optimality of the
learned permutation; external independent replication or security certification.
