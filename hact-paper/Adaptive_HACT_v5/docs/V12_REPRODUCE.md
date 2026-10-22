# Reproducing the v12 review package

Run from `hact-paper/Adaptive_HACT_v5`. Python 3.12 is the measured interpreter
family. Numerical replay needs numpy, pytest and pytest-asyncio; the complete
installed execution inventory (including duplicate editable/install metadata)
is retained in the frozen follow-up manifests. Historical source receipts
retain their original environment limitations.

## Arithmetic, semantic and provenance checks

```sh
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q -p pytest_asyncio.plugin
python -m audit.check_v5
python -m audit.numbers_audit
python -m audit.check_v9
python -m audit.check_v11_compiler
python -m experiments_v11.report --check
python -m experiments_v12.fixed_batch
python -m experiments_v12.robustness --check
python -m experiments_v12.observer_ablation check
python -m audit.check_v12
python -m experiments_v12.report --check
python tools/verify_manifest.py
```

These commands inspect and reconstruct the retained observations; they do not
need a live model, upstream test installation or paid service. The independent
v12 audit uses its own literal JSON-tree packet scorer and reconstructs raw
semantic answers, codec pages and operation sums. Producer-code agreement
alone is not the release gate. Corruption tests cover changed costs, schedules,
missing arms, hidden exclusions, invalid counters, timings and wire signatures.

## PDF builds

The artifact includes unmodified IEEEtran and the elsarticle class linked from
Elsevier's official instructions. A TeX installation needs amsmath/amsthm,
booktabs/tabularx, TikZ, hyperref/xurl, microtype and scalable Latin Modern fonts.

```sh
python tools/prepare_jss.py
cd paper
latexmk -pdf -interaction=nonstopmode -halt-on-error journal.tex
latexmk -pdf -interaction=nonstopmode -halt-on-error jss.tex
latexmk -pdf -interaction=nonstopmode -halt-on-error jss_blinded.tex
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
```

The JSS generator preserves one scientific source, creates attributed and
blinded variants, and builds flat source archives. PDF metadata/timestamps can
change on a rebuild; the release manifest binds the delivered bytes. Do not
refresh the manifest merely to suppress a failed provenance check.

## New actual executions and timing

The original follow-up protocols are in `docs/V12_*PROTOCOL.md`. Source trees,
commits, modules, commands, seeds and generated-metadata provenance are captured
in `results/v12/schedule_shift/FROZEN_MANIFEST.json` and the separate repair
manifest. Every requested combination remains recorded. The initial six
ExceptionGroup runs are VOID because a generated runtime module was not bound
before execution. `docs/V12_GENERATED_METADATA_REPAIR.md` documents the child
campaign and `generated_version.py` preserves its pre-execution bytes.

`results/v12/service_ablation/FROZEN_INPUTS.json` binds the ten admitted
trajectories, two resource exclusions, all producer dependencies and the full
randomized eight-arm schedule. `raw.json` retains every timed operation and
answer signature. Its timing excludes common snapshot/oracle preparation and
includes construction, each ingest and cold/warm query/codec work. Disabled
byte counters are null, not measured zeroes. The campaign was run after the
upstream dispatch campaign ended; no other project experiment ran concurrently.

The collectors refuse to overwrite frozen results. For a new replication,
use a separate output directory and record a new pre-execution contract and
runtime inventory. Use the retained commands and full registries without
subsampling, and report all failures. A fresh timing run is a new observation,
not a requirement that the archived host-specific seconds recur exactly.

## Evidence scope

The original v11 source/trace observations remain immutable. V12 reinterprets
the repeated holdouts, adds actual dispatch-shift executions and isolates
observer costs. Neither a new encoding nor a repeated process increases the
number of independent projects. Packaging remains outside the dense compiler
and service budgets. The fixed-eight mathematical witness is a constructed
information limit, not an empirical software speedup.
