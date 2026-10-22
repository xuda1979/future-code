# Reproducing HACT v14

Run in `hact-paper/Adaptive_HACT_v5` using Python >=3.11. The revision was
checked with Python 3.12.14, numpy 2.3.5, pytest 9.0.2 and pytest-asyncio 1.3.0.
The local environment reuses installed dependencies; a fresh package-index
installation is delegated to the included GitHub Actions workflow.

## Restore, verify, test

The public source stores the complete v11–v14 raw observations in a lossless
split ZIP under `data/observations`. Hydration is offline and requires only the
standard library. It verifies all parts, the assembled archive, exact member
inventory and each original file. Existing matching files are retained; different
files and symlink paths reject. Interrupted restoration is safely resumable.
Earlier result directories are ordinary source files and remain unchanged.

```sh
python tools/hydrate_observations.py
python tools/verify_manifest.py
python -m pip install numpy==2.3.5 pytest==9.0.2 pytest-asyncio==1.3.0
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=. python -m pytest -q -p pytest_asyncio.plugin
PYTHONPATH=. python -m experiments_v14.exchangeable_study --check
PYTHONPATH=. python -m audit.check_v14
PYTHONPATH=. python -m experiments_v14.report --check
```

`OBSERVATION_ARCHIVE.json` binds every original path, size and SHA-256. The
release manifest independently includes every restored path as well as all
archive parts. Ignoring the hydrated copies in Git does not exclude them from
integrity checks. Do not run the explicit manifest refresh to fix a failed
verification. It intentionally refuses to rebaseline changed packed observations.

The v14 producer checks 70 exact small cases and re-encodes previously retained
public runs. `--check` recomputes scientific values, ignoring only newly measured
compile seconds; it does not replace the retained record. The independent audit
imports neither the optimizer nor producer. Measured compile times are descriptive
and are not compared to historic timings from another host.

## Earlier gates remain required

```sh
PYTHONPATH=. python -m audit.check_v5
PYTHONPATH=. python -m audit.numbers_audit
PYTHONPATH=. python -m audit.check_v9
PYTHONPATH=. python -m experiments_v10.exact_separation
PYTHONPATH=. python -m experiments_v11.theory_generalization --full --output /tmp/hact-v14-general.json
PYTHONPATH=. python -m experiments_v11.strict_partition_witness
PYTHONPATH=. python -m audit.check_v11_compiler
PYTHONPATH=. python -m experiments_v11.report --check
PYTHONPATH=. python -m experiments_v12.fixed_batch
PYTHONPATH=. python -m experiments_v12.robustness --check
PYTHONPATH=. python -m audit.check_v12
PYTHONPATH=. python -m experiments_v12.report --check
PYTHONPATH=. python -m experiments_v13.adoption_study --check
PYTHONPATH=. python -m audit.check_v13
PYTHONPATH=. python -m experiments_v13.summary_span
PYTHONPATH=. python -m experiments_v13.report --check
python tools/verify_manifest.py
```

Use a new output path where a command refuses overwrite. The workflow also
recomputes the service oracle, query trace and frozen source/synthetic controls.
These commands do not execute a new upstream checker campaign, hosted model or
physical-network experiment. Recorded suite runs and artificial schedule changes
retain their original sampling units and exclusions.

## Build the manuscripts

`paper/journal.tex` is the primary IEEE source. `paper/main.tex` preserves full
proofs and historical analysis. Attributed/blinded JSS variants are generated;
the complete artifact contains identifying provenance and is not anonymous.
Use a clean build directory per source to avoid stale auxiliary files:

```sh
PYTHONPATH=. python -m experiments_v14.report --check
python tools/prepare_jss.py
mkdir -p /tmp/hact-v14-ieee-build
cd paper
pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/tmp/hact-v14-ieee-build journal.tex
pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/tmp/hact-v14-ieee-build journal.tex
pdflatex -interaction=nonstopmode -halt-on-error -output-directory=/tmp/hact-v14-ieee-build journal.tex
```

Repeat with unique output directories for `main.tex`, `jss.tex` and
`jss_blinded.tex`; inspect references, warnings and rendered pages. Compilation
is separate from empirical provenance. No final journal submission is automated.
