# Reproduce the review follow-ups

Use Python 3.12 with numpy 2.3.5, pytest 9.0.2 and pytest-asyncio 1.3.0.
From `hact-paper/Adaptive_HACT_v5`:

```sh
python tools/hydrate_observations.py --require-index
python tools/verify_manifest.py
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=. python -m pytest -q -p pytest_asyncio.plugin
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 PYTHONPATH=. python -m experiments_v15.review_followups --check
PYTHONPATH=. python -m audit.check_v15
PYTHONPATH=. python -m experiments_v15.report --check
```

The first new check recomputes all 30 cap64/symmetric comparisons, the full
Packaging train/validation selection, and both held-out prices using an
independent literal scorer. It verifies the source/input freeze and complete
profile accounting without regenerating host timings. The separate audit
checks cohort membership, answer equality, CPU accounting and resource receipts;
corruption tests cover missing cases, changed negatives, costs, orders and
overlapping time totals. The report gate checks all new manuscript projections.
The workflow still runs every v5--v14 arithmetic, source, service and evidence
gate. The observer table's presentation-only reordering also has a regression and an
independent header/arithmetic check. Its derived v12 audit receipt was refreshed
for the new rendered table; archived raw observations were not changed.

`results/v15/FREEZE.json` is an explicit source/input inventory made before
the new compiler/profile executions. It is not a signed timestamp, external
preregistration, full environment attestation or proof of scientific validity.
Unmodified literal scorer `audit/check_v14.py` comes from parent commit
`5b061cd4cee7e12ea4e16836c3a81e1e673893f4`. The new package also provides a
post-run dependency/environment receipt, labeled as such. No current model
snapshot is inferred for historical experiments.

The measurement runner intentionally refuses to overwrite existing outputs.
A new timing campaign needs a separate checkout and fresh output namespace
with a new source/protocol freeze; it is not a deterministic replacement for
the retained host timings. The main byte-saving claim is independently
replayable on the retained complete records. Profiling is diagnostic, not a
new estimate of unprofiled speed or a causal allocation breakdown.

The primary article is `paper/journal.pdf`; the companion is
`paper/tse_supplement.pdf`. Build their TeX sources three times, or use
`latexmk -pdf`, then run `python tools/prepare_tse.py`. The source ZIP includes
all new diagrams, projections and supporting derivations. The original
observation archive, six VOID outcomes, historical Packaging exclusions and
all v11--v14 negative results remain first-class release inputs.
