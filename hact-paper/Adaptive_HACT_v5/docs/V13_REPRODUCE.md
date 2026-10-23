# Reproducing HACT v13

Run from hact-paper/Adaptive_HACT_v5 with Python >=3.11 and the existing
requirements-test.txt dependencies. This pass used Python 3.12.14, numpy 2.3.5,
pytest 9.0.2 and pytest-asyncio 1.3.0. Dependencies recovered from the previous
artifact environment were imported into a fresh local environment; this is not
a claim of a new clean package-index installation.

```sh
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q -p pytest_asyncio.plugin
python -m experiments_v13.summary_span
python -m experiments_v13.adoption_study --check
python -m audit.check_v13
python -m experiments_v13.report --check
python -m audit.check_v5
python -m audit.numbers_audit
python -m audit.check_v9
python -m audit.check_v11_compiler
python -m audit.check_v12
python -m experiments_v11.report --check
python -m experiments_v12.robustness --check
python -m experiments_v12.report --check
python tools/verify_manifest.py
```

The v13 study replays exact enumeration, fixed seeded synthetic draws and
retrospective diagnostics from retained data. It executes no new upstream
suite, language-model API or physical-network experiment. --check never
replaces the retained result. Seeded prefixes are nested; their rows must not
be treated as independent project or workflow replications.

The independent audit imports no production scorer or producer experiment.
The exact summary-span calculation uses rational elimination. The four-leaf
regressions cover all permutations and feasible complete-epoch supports.

The plan digest binds layouts, packet/support parameters, error probability,
TV radius, horizon and installation charge. It cannot establish pre-calibration
chronology or IID sampling; those remain external evidence requirements.
Advice is explicitly conditional. Missing evidence yields UNKNOWN, and even
positive advice cannot grant PASS or trigger a migration.

## Build

```sh
python -m experiments_v13.report --check
python tools/prepare_jss.py
latexmk -cd -pdf -interaction=nonstopmode -halt-on-error paper/journal.tex
latexmk -cd -pdf -interaction=nonstopmode -halt-on-error paper/jss.tex
latexmk -cd -pdf -interaction=nonstopmode -halt-on-error paper/jss_blinded.tex
latexmk -cd -pdf -interaction=nonstopmode -halt-on-error paper/main.tex
```

journal.tex is the primary scientific source; JSS variants are generated.
The complete package contains identifying provenance. A blinded main manuscript
alone does not anonymize the full archive. No final submission is performed.
