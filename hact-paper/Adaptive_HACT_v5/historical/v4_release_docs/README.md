# Adaptive HACT v4.0

**Bounded Verification Evidence for Bandwidth-Constrained Systems**

Read `paper/main.pdf`, `docs/RESPONSE_TO_REVIEWERS.md`, and
`docs/V4_REVISION_AND_TEST_REPORT.md`. The manuscript separates current measurements,
archived experiments, design properties, conditional guarantees, and unmeasured claims.

## What this release is for

HACT maintains a trusted, current acceptance contract while allowing its evidence
layout to change. The useful target is bounded diagnostic traffic and constrained
evidence export, **not faster local pytest or better LLM reasoning**. Ordinary
supervisor status uses a small layout-independent projection. Detailed evidence is
retrieved separately. A passing contract does not prove arbitrary program correctness.

The default practical selection API is `ichact.window.PricedWindow`: a deterministic
64-event migration-priced window over precompiled layouts. The earlier coupled
fixed-share method is retained for research, with its analysis moved to an appendix;
it is not promoted over the better practical comparator.

`ichact.blocked.fit_blocked` optionally restricts exact dynamic programming to blocks
of 32 checks under a fixed backbone. It is exact only in that constrained class.
Order learning remains separate and potentially expensive. The measured blocked
trees were 1.54–5.34% worse than a simple balanced tree on the same learned order;
retain that candidate and the incumbent during validation, rather than using block
compilation automatically.

`ichact.exposure` supplies bounded canonical records, reversible compressed wire
formats, root status, and whole-packet diagnostic pagination. It validates encoding
structure, not a remote producer's authority. `tools/export_evidence.py` exports a
trusted report and packet archive without overwriting existing evidence.

The existing strict CLI and actual Future Code gate bridge remain available. The
vendored Future Code v1.2 runtime is unmodified. The v3 scripted model endpoint is
not replaced by live inference in this release.

## New evidence and its limits

| Measurement | V4 result |
|---|---|
| Root-only supervisor input | 12/12 paired projections byte-identical; 593–594 UTF-8 bytes; zero layout benefit |
| Exhaustive diagnostic input | 148 versus 87 pages across 12 archived candidates; each page at most 16,384 bytes |
| Byte savings after whole-epoch compression | NetworkX 47.92%; Toolz 5.80%; Future Code 23.60% |
| Receiver-paced TCP at 64 KiB/s, compressed | 6.624 versus 4.413 seconds total for 12 exports, averaged over two repetitions |
| New transport executions | 288 real loopback TCP transfers; archived payloads, not new checker or LLM results |
| New compiler workloads | 18; 128, 512, and 1,024 checks; three seeds and two families |
| At 512 checks, same-order blocked fitting | About 25–26 times faster than exact DP; not the complete pipeline; held-out penalties remain |
| At 1,024 checks | Block fitting 0.26–0.28 s; order learning 2.84–3.20 s; exact baseline not executed |
| Priced-window compatibility | Exact action/cost replay on all 80 archived online streams, 163,840 events |
| Prototype suite | 253 passed, including 66 new cases beyond v3 |
| Unmodified Future Code suite | 263 passed separately |
| Independent reconstruction | 24 archives, 288 transfers, 18 compiler traces, 80 online replays, 125 summary numeric comparisons |

Compression and layout must be compared under the same encoding. Whole-epoch
compression batches a completed archive; it is not the same latency service as
streaming individual packets. The CLI defaults to independent packet compression.

Root-only status and a flat final-status ledger can be smaller than the diagnostic
archive because they provide a different service. No tree optimization is needed
for the small root interface. Page counts are exhaustive-reader counts, not observed
LLM behavior. Byte measurements are not tokenizer counts: no tokenizer was available,
network installation failed, and both token counts and provider usage remain null.

Historical v3 outcomes remain negative controls: essentially unchanged checker
wall time and about five seconds of strict-wrapper overhead on its small harness.
No hosted model, SWE-bench, new natural-issue cohort, real WAN/edge deployment,
Windows test, independent security review, or distributed consensus was evaluated.

## Environment and installation

Recorded: Linux x86_64, Python 3.13.5, zlib 1.3.1. The declared Python >=3.11 range
is not a test matrix. POSIX process groups are used by the strict wrapper. Install
in a virtual environment; dependency downloads need network access. The experiments
themselves use no paid services or credentials.

```bash
python -m pip install -r requirements-test.txt
python -m pip install --no-deps .
```

`requirements-test.txt` records the tested dependencies, not latest-version claims.
Source/license snapshots are under `vendor/`; see `NOTICE.md`.

## Verify released measurements

```bash
python tools/verify_manifest.py
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q -p pytest_asyncio.plugin
python audit/check_v4.py
python audit/check_v3.py
PYTHONPATH=vendor/future/src PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
  python -m pytest vendor/future/tests -q -p pytest_asyncio.plugin
```

The manifest is a checksum listing, not a signature. Auditors use independent code
paths but are not third-party replications. The v3 auditor covers only historical
v3 evidence; it does not relabel that evidence as new.

## Try bounded evidence export without a model

The following input is a real archived v3 report. The output must not already exist.

```bash
python tools/export_evidence.py \
  --report results/v3/fresh_checkers/networkx/networkx_confirm_000-fixed8/report.json \
  --packets results/v3/fresh_checkers/networkx/networkx_confirm_000-fixed8/certificate_packets.bin \
  --output /tmp/hact-export-demo --mode packet_zlib
```

This writes `status.txt`, `evidence.hact`, `diagnostic-*.txt`, and `export.json`.
It is a presentation/export operation, not a command that authorizes an untrusted
report or deploys anything. Detailed examples and policy semantics are in
`docs/V4_OPERATING_GUIDE.md`.

## Reproduce new v4 measurements in isolation

```bash
python tools/reproduce_v4.py --destination /tmp/hact-v4-new-run
```

The destination must be new and outside the release. This copies the frozen v3
input records, runs 288 new transport transfers and 18 new compiler workloads,
replays the priced-window rule, regenerates numeric tables, audits, and tests.
It does not rerun the original source checkers or call a model. Timings naturally
vary by machine. Compile `paper/main.tex` twice in the new copy to update its PDF.

The earlier actual harness campaign can still be rerun separately:

```bash
python tools/reproduce.py --destination /tmp/hact-harness-new-run \
  --tier harness --repetitions 3
```

It uses the real supervisor, workers, workspaces, subprocess gates and integration,
but scripted model replies and deliberate faults. Do not report it as live-LLM
patch generation. Existing v3 experiments and logs are explicitly historical.

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


## Release layout

`hact/`, `ichact/`: production kernels, compilers, controllers, gate and evidence views.
`experiments_v4/`, `results/v4/`: new v4 measurements and their records.
`experiments_v3/`, `results/v3/`: retained earlier experiment implementation and data.
`historical/`: earlier manuscripts, response and evidence; not current results.
`audit/`: independent v3 and v4 reconstruction paths.
`tests*`: regression and new tests; `paper/`: current LaTeX, tables and PDF.
`docs/`: frozen contracts, reviewer responses, provenance and operating instructions.

Keep all contracts, checker code, references and monotone state outside candidate
write scopes. Run untrusted candidate code in an outer container/VM. Digests and
private workspaces alone provide neither sandbox isolation nor remote authentication.
