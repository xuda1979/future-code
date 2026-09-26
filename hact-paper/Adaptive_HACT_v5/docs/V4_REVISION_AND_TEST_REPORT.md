# Adaptive HACT v4.0 — Revision and Test Report

## Scope and provenance

This is a systems revision of the v3 artifact. `docs/V4_EXPERIMENT_CONTRACT.json`
records the frozen input cohort, seeds, formats and timing protocol before new
measurements. Input archive SHA-256 is
`2ed82032b089b749117899c7e14e76b8306bb6a6f5e315b354d560909fee29bc`.
New current-host results are under `results/v4/`. `results/v3/` remains historical.
The independent v3 auditor was rerun successfully; its historical results are not
counted as new checker executions.

## Changes

New production modules: `ichact/window.py`, `ichact/blocked.py`, `ichact/exposure.py`.
New export/reproduction CLIs: `tools/export_evidence.py`, `tools/reproduce_v4.py`.
New measurements: `experiments_v4/`. New independent audit: `audit/check_v4.py`.
Package metadata and import version both read 4.0.0; this also corrects an inherited
version-string mismatch. Existing strict gate, semantic registry, generations,
source fingerprints and Future Code execution paths are retained.

The manuscript changes its title, abstract, introduction and principal claim;
fixed-share analysis moves to an appendix; new context/compression/transport and
constrained-compilation sections are added; old v3 results remain labeled archival.
The new response and operating guide are synchronized with the code and findings.

## What actually ran in v4

| Category | Count | What the count does not mean |
|---|---:|---|
| Archived checker-output streams inspected | 24, 12 matched pairs | Not 24 new checker runs |
| New receiver-paced loopback TCP transfers | 288 | Not 288 repairs, agents or WAN deployments |
| New synthetic compiler workloads | 18 | Not 18 natural software issues |
| Archived online traces replayed through the new API | 80, 163,840 events | Not new distributional evidence |
| Prototype tests | 253 passed | Not proof of absence of all bugs |
| Unmodified Future Code runtime tests | 263 passed separately | Not a live model-quality evaluation |
| Independent numeric summary comparisons | 125 | Not an external audit |

Transport uses all 24 archived streams, two timed formats, three receiver settings,
and two repetitions: 24 x 2 x 3 x 2 = 288. Order is shuffled with seed 44001. Rate
settings are 65,536 bytes/s, 1,048,576 bytes/s, and unpaced. The receiver uses real
TCP and application-level pacing, validates bounded decoding against the trusted
experimental reference, and acknowledges the result. Application bytes include
wire envelope/framing plus an 8-byte outer length and 32-byte ACK. TCP/IP/TLS bytes
are not measured. No checker is executed during a transport trial.

Compilation has sizes 128/512/1,024, clustered/independent families, seeds
44011/44012/44013, 128 training and 256 held-out episodes. Block size is frozen at 32.
Exact DP is executed only through 512. All training/held-out inputs and layouts are
stored in `results/v4/scaling.json` for independently recomputed costs.

## Measurements and negative controls

After whole-epoch compression, learned-layout byte reductions are NetworkX 47.92%,
Toolz 5.80%, Future Code 23.60%. The canonical-format reductions are 56.25%, 16.73%, 35.28%.
These are ratios of aggregate bytes within each four-candidate project cohort, not
population confidence intervals. `results/v4/summary.json` holds the unrounded data.

At 64 KiB/s, twelve canonical exports total 33.499 s fixed versus 18.954 s learned.
Whole-epoch compression makes those totals 6.624 s and 4.413 s. They average two repeats;
the compressed saving of about 2.21 s is over all 12 exports. Faster unpaced exports
are also observed because there are fewer records to encode/decode, but do not
establish faster checking or agent execution. Cold layout learning is outside the
export timer, explicitly recorded elsewhere, and must be amortized in deployment.

Root prompts are identical in all 12 pairs and range 593–594 bytes. Maximum single
compact packet is 2,482 bytes. Exhaustive diagnostic page counts sum 148 versus 87;
maximum page 16,364 bytes is under the 16,384-byte bound. Tokenizer and provider counts
are null because a real tokenizer was unavailable and network retrieval failed.

At 512 checks, same-order exact DP is about 3.43–3.46 s versus 0.132–0.136 s for block DP;
order learning additionally takes 0.53–0.58 s. At 1,024 checks block DP is 0.26–0.28 s while
ordering is 2.84–3.20 s. Held-out block costs at 512 exceed exact by 3.40% for clusters
and 0.40% for independent waves. The simple balanced tree on the same learned order
beats block DP's held-out bytes by 1.54–5.34% across the six settings. Both unfavorable
comparisons remain. The constrained compiler is not the default winner.

Historical v3 controls remain unchanged: fixed versus learned source-wrapper times
39.69 s versus39.77 s; roughly five-second strict-gate overhead on the small harness;
fixed-share regressions 7.88% stationary and 16.45% rapid. The new priced-window API
exactly reproduces its old comparator, without parameter retuning. That does not
prove a general online guarantee.

## Verification commands

```bash
OPENBLAS_NUM_THREADS=1 python audit/check_v4.py
OPENBLAS_NUM_THREADS=1 python audit/check_v3.py
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 OPENBLAS_NUM_THREADS=1 \
  python -m pytest -q -p pytest_asyncio.plugin --junitxml=results/v4/tests.xml
PYTHONPATH=vendor/future/src PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
  python -m pytest vendor/future/tests -q -p pytest_asyncio.plugin
```

The new tests cover block constraints, safe wire decoding and decompression limits,
malformed packet partitions/counts, byte-admission overflow, root-state projection,
policy sequencing/migration/checkpoints, metadata consistency and independently
recomputed summary tampering. An initial duplicated test-module filename prevented
collection; it was renamed and the failure retained in
`results/v4/test_collection_failure.log`. All later complete runs pass.

`audit/check_v4.py` imports neither producer optimizer nor codec. It independently
rebuilds framing/compression sizes and complete child coverage from packet records,
checks exact root identity and page packing, all 288 transfer ledgers, all 18 compiler
objectives, and the 80 old online totals. It additionally recomputes 125 numeric
summary fields. Tests show deliberate altered measurement claims are rejected.
It is still a locally authored audit path, not outside replication or certification.

The final release is extracted and tested again; its verification JSON outside the
ZIP records the final archive hash, manifest verification, installed-package smoke,
extracted test counts and visual PDF review. Test XML/logs in the package correspond
to the source freeze. Release metadata excludes itself from recursive hashing.

## Remaining unknowns

No hosted-LLM or SWE-bench evaluation; no current tokenizer measurements; no new
natural-bug cohort; no physical constrained network; no TLS/link-layer accounting;
no multi-host consensus/recovery; no Windows or Python-version test matrix; no
independent security certification. Replacing protected state can defeat local
integrity. The artifact does not turn an untrusted report into a verified fact.
