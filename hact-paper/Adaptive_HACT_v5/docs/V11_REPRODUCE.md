# Reproducing HACT v11

Run commands from `hact-paper/Adaptive_HACT_v5`. CPython 3.12 is the recorded
measurement runtime; the core package requires Python >=3.11. Offline evidence
audits need NumPy and pytest; fresh upstream collection uses the extra pinned
dependencies in `requirements-v11.txt`. No paid LLM API or accelerator is used.

## Verify the retained evidence

```sh
python -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest -q -p pytest_asyncio.plugin
PYTHONPATH=. .venv/bin/python -m audit.check_v5
PYTHONPATH=. .venv/bin/python -m audit.numbers_audit
PYTHONPATH=. .venv/bin/python -m audit.check_v9
PYTHONPATH=. .venv/bin/python -m audit.check_v11_compiler
PYTHONPATH=. .venv/bin/python -m experiments_v10.exact_separation
PYTHONPATH=. .venv/bin/python -m experiments_v11.theory_generalization --full --output /tmp/hact-general.json
PYTHONPATH=. .venv/bin/python -m experiments_v11.strict_partition_witness
PYTHONPATH=. .venv/bin/python -m experiments_v11.report --check
.venv/bin/python tools/verify_manifest.py
```

The default test discovery includes `tests_v11`. Historical and current audit
counts are correlated checks, not independent experiments. The v11 audit
reads raw records and layout JSON directly; it does not import producer
scoring or service-answer helpers. Tests deliberately corrupt numerical
totals, normalized verdicts and service answers and require audit failure.

## Re-run the existing controlled comparisons

Use a separate checkout for new measurements. Keep the original committed
records unchanged and choose explicit new output paths where supported.

```sh
.venv/bin/python -m experiments_v11.service_study \
  results/v11/public_compiler/SERVICE_CASES.json /tmp/hact-service-rerun.json
.venv/bin/python -m experiments_v11.regression_costs
.venv/bin/python -m experiments_v11.public_compiler_study --help
```

The final command lists separate fit/evaluate phases. Fitting opens runs0-2;
evaluation requires a complete frozen-fit record before opening runs3-4.
The published fit/evaluation receipts are immutable inputs to the audit.
The regression-cost projection recomputes the committed deterministic summary;
it does not re-execute upstream programs or refit a layout.
Fresh timing values will differ; do not compare new timings to old byte totals
under a different cohort, method, source identity or refresh contract.

## Fresh upstream collection

Install `requirements-v11.txt`, and clone the six repositories at the exact
commit/tag pairs in `results/v11/public_checks/FROZEN_MANIFEST.json`.
Install those checkouts editable using their declared isolated PEP517 builds.
Check actual module origins, rather than relying on duplicate distribution
metadata. The recorded Jinja dependency is Trio0.27.0. Full current and initial
dependency inventories, including their limitations, are in the public-data
deviation record.

```sh
.venv/bin/python -m experiments_v11.public_collect \
  --upstreams /absolute/path/to/upstreams --campaign independent-rerun \
  --allow-order-variation
```

A named campaign writes a separate attempt directory and preserves published
raw runs. A new campaign must receive its own reviewed normalization/sampling
manifest before replacing any analysis inputs; `--normalize` reproduces the
published source-to-canonical mapping, including the retained Jinja repair.
Repeated collector calls reuse completed receipts, so a named new campaign
is necessary to obtain new executions.

The historical-source plan is
`results/v11/public_regressions/FROZEN_SOURCE_PLAN.json`. Fetch its exact
commit/parent objects, then use `public_regressions.py --help` in an isolated
work directory. The plan selects production-module transplants into release
tests; it does not reconstruct native parent environments. Preserve startup
and registry failures. Do not replace them with handpicked successful bugs.

## Build the manuscripts and figures

`paper/IEEEtran.cls` is the unmodified IEEEtran1.8b distribution from
https://mirrors.ctan.org/macros/latex/contrib/IEEEtran/IEEEtran.cls;
its contribution/license notices are retained. A normal TeX distribution with
amsmath, TikZ, microtype, xurl and latexmk is required.

```sh
# Regenerate prose/tables/plots only when intentionally updating the projection.
.venv/bin/python -m experiments_v11.report
latexmk -pdf -interaction=nonstopmode -halt-on-error -cd paper/journal.tex
latexmk -pdf -interaction=nonstopmode -halt-on-error -cd paper/main.tex
```

Figure regeneration additionally requires matplotlib. Inspect rendered pages
after changes; successful compilation alone does not verify layout. Refresh
the publication manifest only after PDFs, source and all intended records
are final. The manifest verifies bytes, not scientific truth or a signature.
