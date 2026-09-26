# Adaptive HACT v3.0

**Learned Layouts and Migration-Aware Verification for Agent Harnesses**

Read `paper/main.pdf`, `docs/RESPONSE_TO_REVIEWERS.md`, and
`docs/V3_REVISION_AND_TEST_REPORT.md`. The paper distinguishes theoretical
assumptions, measured results, scripted integration tests, and remaining gaps.

## What is implemented

A stable semantic registry defines the checks a candidate must pass. Learned
spectral and average-linkage proposals change only the certificate display order;
a full-completion-wave dynamic program fits each proposal. A separate validation
set selects one. The exact compiler is classical alphabetic-tree machinery applied
to this objective, not a claim to globally optimize all permutations.

A coupled fixed-share controller selects from a frozen layout catalogue before
seeing each current event. It prices actual canonical layout manifests and cold
certificate reconstruction. Canonical-ID evidence survives valid display
migration; candidate epochs, conflicting records, and layout-generation fences
prevent stale publication. These are trusted local checks, not cryptographic
remote attestation, a sandbox, or distributed consensus.

`ichact.future_bridge` is an actual subprocess acceptance plug-in for Future Code
Control v1.2. The vendored runtime remains unmodified. The supplied campaign runs
its supervisor, parallel child workers, private attempts, model HTTP adapter,
quality gates and integration path. Model replies are scripted; SQLite and HTTP
application checks and all orchestration operations are real.

## Results and limitations

| Measurement | Recorded result |
|---|---|
| Shuffled-cluster ordering, 20 seeds | 26.38% fewer bytes vs original-order DP; 95% interval [25.94%, 26.79%] |
| Long-shift online streams | Coupled-share cost ratio 0.845 to frozen, including migrations |
| Stationary / rapid-shift online streams | Regressions of 7.88% / 16.45%; retained as negative results |
| Fresh source checks | 24 paired runs; 16.63–56.14% fewer certificate bytes; essentially unchanged wall time |
| Actual harness | 9 episodes, 2 concurrent workers, 40-check SQLite/HTTP fixture; all completed |
| Small harness layout comparison | Fixed and learned tie at 97,920 bytes; strict verification adds about 5 s vs direct gates |
| Prototype tests | 187 pass; 43 are new relative to v2 |
| Vendored Future Code tests | 263 pass |
| Independent stored-evidence audit | 80 ordering workloads, 80 online streams, 33 archived source replays, 24 fresh paired runs, 9 harness episodes |

No hosted LLM, actual API token/billing measurements, SWE-bench run, natural
historical bug campaign, Windows test, multi-host production deployment, or
independent external security audit was performed. Provider token fields are
`null`, not fabricated zeros. A count of checks is not a count of agents.

## Environment and installation

Measured: Linux x86_64, Python 3.13.5. Python >=3.11 is declared but other versions
are unverified. The strict wrapper uses POSIX process groups. An internet
connection is needed only to obtain unavailable dependencies; no paid API is
needed for any recorded experiment.

```bash
python -m pip install -r requirements-test.txt
python -m pip install --no-deps .
```

Exact requirements record the tested environment, not a claim of current latest
versions. Use a virtual environment. Source snapshots and their license notices
are under `vendor/`; see `NOTICE.md` before redistribution.

## Verify the release without rerunning a mutation campaign

From this directory:

```bash
python tools/verify_manifest.py
python -m pytest -q tests tests_v1 tests_v3
python audit/check_v3.py
```

The manifest excludes itself and is a checksum record, not a signature. The audit
reconstructs costs and checks real packet streams without importing the producer
optimizer, kernel, or cost helpers. Do not infer checker adequacy from arithmetic
agreement.

## Run a new actual harness exercise

The launcher requires a nonexistent destination outside this artifact and leaves
released measurements untouched:

```bash
python tools/reproduce.py --destination /tmp/adaptive-hact-new-run \
  --tier harness --repetitions 3
```

It runs direct, fixed, and learned modes in rotated order. Each root delegates to
two workers, each worker submits a bad candidate then the known correct source,
and actual checks reject/accept those candidates. A transient model-endpoint HTTP
503 is injected. The fixture makes only loopback HTTP calls.

For the whole v3 campaign, including ordering, drift, source replay, fresh
executions, harness, statistics and figures:

```bash
python tools/reproduce.py --destination /tmp/adaptive-hact-full \
  --tier full --repetitions 3
```

Fresh evidence is written inside the new destination. Prior v2 source mutation
outcomes are still an explicit input to this campaign; this command does not
rerun all 121 archived v2 interventions. It reruns the frozen 12-candidate paired
v3 cohort. Controller traces are deterministic simulations of verification
traffic; the source/harness experiments execute actual code.

## Use the strict gate on a project

Initialize on a reviewed trusted baseline, keeping the contract and reports
outside candidate write scopes:

```bash
python -m ichact init --project /work/trusted-baseline \
  --contract /work/contracts/approved.json \
  --output /work/reports/baseline --test-path tests

python -m ichact verify --project /work/candidate \
  --contract /work/contracts/approved.json \
  --output /work/reports/candidate-001
```

`--layout file.json` optionally supplies a full semantic-ID layout.
`--order file.json` separately supplies a complete test execution order. Neither
may omit checks. `PASS` requires complete current evidence. A real failure may
terminate early; missing, skipped, stale, timed-out or incompatible evidence
cannot become a pass. Exit codes are 0 for PASS, 1 for FAIL, 2 for UNKNOWN in the
bridge. Detailed records and actual packet streams are retained outside the
candidate; final reports are not an external merge operation.

Schema-1 v2 contracts must be reinitialized on a reviewed baseline. Schema-2 pins
the checker and environment, and protects added/deleted/changed acceptance files.
Do not automatically reapprove contracts simply to make a gate green.

## Actual Future Code integration

See `docs/FUTURE_CODE_INTEGRATION.md`. `ichact.future_bridge` works as a normal
GateSpec subprocess, and non-pass exits block integration. The runtime handles
its own private workspaces and source-fingerprint checks. The online selector and
migration guard are a separately tested library path; a self-retuning hosted
agent deployment was not evaluated.

## Layout generation API

```python
import json
from ichact.layout import fit_catalogue, select_validation

# Complete immutable semantic IDs in approved contract order.
registry = tuple(json.load(open('/work/contracts/approved.json'))['registry'])
# Each episode is a list of waves; each wave lists canonical integer indices.
training = json.load(open('/work/traces/training.json'))
validation = json.load(open('/work/traces/validation.json'))
catalogue = fit_catalogue(registry, training)
selected, scores = select_validation(catalogue, validation)
with open('/work/contracts/layout.json', 'w') as out:
    json.dump(catalogue[selected].to_dict(), out, indent=2)
```

Training/validation data must exist; the example invents no observations. Catalogue
manifests are referenced control artifacts and can be larger than the 3,072-byte
individual certificate cap. Bytes and UTF-8 lengths are not token counts.

## Organization

`hact/` and `ichact/`: kernel, compiler, learned layouts, online policy, strict CLI.
`experiments_v3/`: current protocols and executable I/O fixture.
`results/v3/`: new raw/derived evidence. `historical/`: clearly labeled v2
manuscript and evidence, not current results. `experiments/`, `tests/`, and
`tests_v1/`: retained earlier algorithms/fixtures and regression tests. Older
experiment scripts are historical; use the v3 launcher rather than running them
against the new results layout. `audit/`: independent v3 auditor.
`paper/`: current LaTeX, generated tables, plots, and PDF.

No credentials or production systems are required. Run untrusted candidate code
in a container/VM; source hashes and private copying do not sandbox Python.
