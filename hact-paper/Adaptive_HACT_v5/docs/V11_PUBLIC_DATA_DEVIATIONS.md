# Public-software execution cohort: provenance, deviations and reproduction

Recorded 2026-10-21. This is a controlled local execution study, not a sample
of production-user demand, native bug-repair episodes, or live agents.
No HACT cost was used to select an upstream project or source-transplant case.

## Frozen frame and actual executions

`results/v11/public_checks/FROZEN_MANIFEST.json` was written before the first
upstream suite run. It binds the six release tags to commits, every tracked
source file to SHA-256, the research contract, and the initial installed
distribution inventory. `public_collect.py` runs each entire configured suite
in a fresh pytest process, without modifying its collection order or filtering
failed tests. Runs 0–1 are training, run 2 validation, and runs 3–4 held out.

| Project | Tag | Checks per run | PASS | FAIL | UNKNOWN |
|---|---|---:|---:|---:|---:|
| Click | 8.2.1 | 761 | 739 | 0 | 22 |
| Jinja | 3.1.6 | 909 | 909 | 0 | 0 |
| packaging | 25.0 | 26,948 | 26,948 | 0 | 0 |
| pluggy | 1.6.0 | 124 | 124 | 0 | 0 |
| attrs | 25.3.0 | 1,432 | 1,391 | 33 | 8 |
| exceptiongroup | 1.3.0 | 102 | 91 | 0 | 11 |

Each row has five complete executions with the counts shown, giving **30 suite
runs and 151,380 actual check executions**. Repeated checks are correlated
measurements of one release snapshot per project; they are not 151,380
independent experimental units. Skips, expected failures and unexpected passes
with an xfail marker are UNKNOWN. The 33 attrs failures per run are retained
typing-expectation failures under the recorded mypy 2.4.0 environment; this
study does not establish that they are upstream library defects.

Every evidence file records the original collection/scheduling order, actual
final-report order, all reported phases and durations, UNKNOWN/FAIL states,
collection errors/skips, imported target-module paths and file hashes, and a
bounded audit of the first 32 observed production-source calls. Those calls
establish execution provenance; they are not a coverage analysis. Only the
first 32 calls are profiled, and recorded suite timings include that overhead.
Wave construction uses successive groups of at most eight actual final reports,
as specified in the research contract. It is not a parallel-completion study.

`results/v11/public_checks/INTEGRITY_CHECK.json` independently verifies all 30
raw/normalized correspondences, all recorded phase-to-status mappings, and
that every originally tracked upstream file remains byte-identical to its
pre-run source manifest. All six projects passed those checks.

## Environment preparation and Jinja dependency repair

The initial no-build-isolation editable-install attempts lacked declared build
backend requirements (`hatch-fancy-pypi-readme`, `editables`, and `flit_scm`).
Standard isolated PEP 517 editable builds then installed all six declared
tagged releases successfully. No tracked upstream source was edited.

Jinja's first attempt failed during collection because its declared test
dependency `trio` was absent. That failed run remains untouched at
`public_checks/jinja/run_0/`. The pinned dependency `trio==0.27.0`, matching the
upstream test lock, and its dependencies outcome/sniffio were installed.
Five complete repaired runs are retained separately at
`public_checks/attempt_trio-repair/jinja/run_0/` through `run_4/`.
`ENVIRONMENT_AFTER_TRIO_REPAIR.json` records the added dependency inventory.
The original frozen manifest was not rewritten.

`ENVIRONMENT_DEVIATION.json` adds a **posthoc reconstructed** full current
distribution inventory without collapsing duplicate base/virtual-environment
records. It records resolved local distribution versions, actual imported target
module origins/hashes, the observed repair command and transcribed install
output. The original pip stdout was not saved as a contemporaneous file; the
transcription is explicitly labeled. All five repaired Jinja runs followed the
same installation. packaging runs 0–1 precede the repair and runs 2–4 follow it;
the other four complete project campaigns preceded the repair. No full package
inventory was attested at every run launch. The short environment hash cannot
prove full dependency identity across the cohort, and no such claim is made.

The environment exposes both base-runtime and virtual-environment distribution
metadata. An inventory of installed distributions may therefore include a
base-runtime version of a package also installed editable in the evaluation
environment. The target-module paths and source SHA-256 values in every run,
together with the pinned tag commits, identify the actual upstream code used.
The short `report.json` environment identifier covers Python/platform; the full
inventory and this dependency repair record supply the additional context.

## Canonical-registry instrumentation correction

The original recorder used incidental collection order as the registry order.
packaging runs 0 and 1 collected exactly the same 26,948 semantic IDs in
different orders. The first receipt for run 1 correctly rejected that ordered
comparison and remains unchanged. The raw test execution and ID sets were
complete; no test was removed or reordered to repair it.

Before HACT analysis of the corrected cohort, a separate normalization plan was
frozen at `results/v11/public_checks_normalized/NORMALIZATION_MANIFEST.json`.
The normalized evidence copies use `registry = sorted(original registry)` and
retain `collected_registry`, `scheduled`, `executed`, every phase, status and
timing exactly. Each normalized file carries its raw parent path and SHA-256.
Its report hashes the canonical registry. All projects receive the same
transformation; the raw evidence/report/receipt files remain byte-identical.

Use **`public_checks_normalized/` for compiler and service evaluation**. Its
`COLLECTION_SUMMARY.json` has `complete: true` and all 30 run receipts. The raw
run-1 packaging receipt remains an instrumentation rejection; normalization is
an explicitly disclosed preanalysis correction, not a new checker execution.
Later fail-closed normalizer guards reject empty, unfinished, timed-out or
origin-less records. None of the 30 normalized complete runs has those states.
The plan retains the hash of the normalizer when the transformation was frozen;
those later guards do not change any retained execution or normalization result.

## Separately frozen historical-source exploration

After the normal suite campaign, `public_regressions/FROZEN_SOURCE_PLAN.json`
was written before any historical-source execution. The syntax-only selection
examines at most the first 100 first-parent commits at each release tag, in
history order. It takes the first two commits whose subject matches
`\b(fix(?:es|ed)?|bugs?)\b`, case-insensitively, and which change both a
production `src/**/*.py` file and an actual pytest filename `test_*.py` under
`tests/` or `testing/`. Changed production modules must exist in the parent,
fix and selected release; absent modules are recorded as exclusions. Fewer
than two candidates are retained when the declared history has fewer matches.

For each selected commit, an isolated copy of the release receives only the
changed production modules from that commit's first parent. It runs the entire
unmodified release test contract with `--maxfail=1`. No candidate is replaced
after seeing whether it reveals a failure. All original source clones remain
unchanged. The manifest contains full commit/parent IDs, module paths and the
parent/fix/release SHA-256 values; short commit prefixes below aid navigation.

| Case | Selected fix commit | Observed completed checks | Paired analysis |
|---|---|---:|---|
| click_source_0 | b7cf06970e40 | 427 | Eligible; one FAIL |
| click_source_1 | 884af5c20fdc | 389 | Eligible; one FAIL |
| jinja_source_0 | c8fdce1e0333 | 737 | Eligible; one FAIL |
| jinja_source_1 | b4b28ec01c60 | 909 | Eligible; all PASS, retained |
| packaging_source_0 | cf2cbe2aec28 | 8,320 | Eligible; one FAIL |
| packaging_source_1 | a716c52b5f3c | 2,374 | VOID: semantic registry differs |
| pluggy_source_0 | 9d19d4b8e07d | 75 | Eligible; one FAIL |
| pluggy_source_1 | cc36605090df | 0 | VOID: pytest startup incompatibility |
| attrs_source_0 | 6fda0a4e086b | 0 | VOID: transplanted modules are incompatible |
| exceptiongroup_source_0 | d0252696636e | 18 | Eligible; one FAIL |
| exceptiongroup_source_1 | 8b8791b662c0 | 15 | Eligible; one FAIL |

There are **11 frozen candidates, nine executable traces, and eight traces with
the release semantic registry**. The nine traces include one unrevealing
all-PASS case and eight traces with an observed failure. Seven of the eight
paired-eligible traces have an observed failure. `eligible_for_paired_costs`
in each receipt distinguishes valid execution evidence from paired eligibility.

The older packaging metadata module changes source-dependent parametrization,
giving 26,942 IDs rather than the release's 26,948. It is retained but excluded
from same-registry paired costs. The old pluggy hook module lacks the
`warn_on_impl_args` keyword needed by pytest 9.0.2. The attrs transplant expects
`PY_3_8_PLUS`, absent from the release's unchanged compatibility module. Their
startup errors are retained as VOID, not program failures or evidence of speed.

These transplants can expose compatibility differences accumulated between a
historical parent and the selected release. They are **not eight confirmed
natural bugs, native parent checkouts, or independent bug-fixing episodes**.
They are exploratory source-change traces evaluated against previously frozen
release layouts. Missing obligations after early stopping remain UNKNOWN.

## Reproduction

From a clean artifact checkout, create an isolated Python 3.12 environment and
install the recorded toolchain, including pytest 9.0.2, pytest-asyncio 1.3.0,
numpy 2.3.5, hypothesis 6.170.5, pytest-mypy-plugins 4.0.3, mypy 2.4.0,
trio 0.27.0, pretend 1.0.9, freezegun 1.5.5, pympler 1.1 and cloudpickle 3.1.2.
Resolve the six repository tags in `FROZEN_MANIFEST.json` and verify their
recorded commits. Install those checkouts editable with normal PEP 517 build
isolation. The source origins must point inside the intended clones.

```sh
python -m experiments_v11.public_collect --upstreams /absolute/path/to/clones --freeze-only
python -m experiments_v11.public_collect --upstreams /absolute/path/to/clones --allow-order-variation
python -m experiments_v11.public_collect --upstreams /absolute/path/to/clones --projects jinja --campaign trio-repair --allow-order-variation
python -m experiments_v11.public_collect --upstreams /absolute/path/to/clones --normalize
python -m experiments_v11.public_regressions --upstreams /absolute/path/to/clones --freeze-only
python -m experiments_v11.public_regressions --upstreams /absolute/path/to/clones --work /absolute/path/to/new-isolated-copies
```

Use a new output workspace to rerun rather than overwrite published measurements.
The collectors resume existing receipts and refuse to overwrite an existing
isolated source-transplant directory. Preserve the published failed attempts
when reproducing the historical campaign; an already complete environment need
not intentionally reproduce a missing-dependency failure. Runtime measurements,
timestamps and unstable collection order may differ by host. Raw-to-normalized
transformations and their content hashes are deterministic for a given raw run.

Five focused recorder/normalizer/selection tests passed. They exercise actual
pytest subprocesses, collection errors, PASS/FAIL/skip/xfail/xpass handling,
duplicate/incomplete registry rejection, raw-preserving normalization and
pytest-filename eligibility. No xdist or live-agent result is claimed.
