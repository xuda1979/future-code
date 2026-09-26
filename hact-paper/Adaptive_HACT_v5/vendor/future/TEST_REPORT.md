# Future Code Control Plane 1.2.0 - verification report

## Verdict and scope

**PASS for the declared local verification contract.** The complete development suite
ran **263 tests with zero failures, errors or skips**. This is 69 additional
cases beyond the 194-test 1.1.0 baseline. It is not a claim that every possible defect
has been eliminated or that hosted LLM reasoning has been validated.

This package modifies the runnable 1.1 companion. The original uploaded TypeScript
archive was truncated; the missing original engine/UI is still not reconstructed.
All new model-driven exercises use explicitly scripted outputs. Local HTTP, subprocess,
database, scheduler, filesystem, acceptance gates and reporting behavior are real.

This report records development-tree verification. Exact final-ZIP extraction, manifest
verification and re-executed tests are supplied in the accompanying release-verification
JSON. Do not infer those results from a development-tree test alone.

## Executed checks

| Check | Observed result | Evidence |
|---|---|---|
| Baseline v1.1 suite | 194 passed, 34.45 seconds | `evidence/v1.2/baseline.txt` |
| Final complete suite | 263 passed, 43.23 seconds; no failures/errors/skips | `evidence/v1.2/pytest-final.txt`, `junit.xml` |
| Runtime statement coverage | 2420/2687 = **90.06%** | `evidence/v1.2/coverage.json` |
| Runtime branch coverage | 892/1094 = **81.54%** | Same coverage record |
| Cheap source/config checks | 35 Python files; 3.11 grammar and current-interpreter compilation; example schemas valid | `evidence/v1.2/static-checks-final.json` |
| Runtime dynamic decomposition | 85 logical tasks, 21 coordinators, recursive four-way delegation; 106 requests; parent `max_attempts=1` resumes | `tests/test_coordination.py::test_dynamic_tree_85_tasks_rehydrates_local_managers` |
| Large hierarchy lifecycle | 585/585 logical tasks done; 512 leaves plus 73 integrators; 64 active slots observed | `evidence/v1.2/scale-512.json` |
| Malformed/pressure tests | Unicode byte pressure, 120 deterministic randomized context cases, pagination, scoped reads, mail backpressure, stale notes and fences | `tests/test_coordination.py`, `test_coordination_edges.py` |
| Post-failure feedback | A failing executable addition test rejected the candidate; corrected candidate and final integration passed | `evidence/v1.2/local-http-demo.json` |
| Real local HTTP resilience | 10 requests, 1 injected 503, 5 TCP connections | Same HTTP fixture record |
| Offline package build/install | Wheel built without package-index access; 17 installed runtime files hash-matched; installed 64-leaf example passed | `evidence/v1.2/install-smoke.json`, `installed-demo.json` |
| Runtime source identity | Runtime file hashes recorded before final tests match current source | `evidence/v1.2/tested-runtime-source.json` |

Coverage percentages are separate statement and branch fractions, not the combined
coverage tool percentage. Missing branches are visible in the JSON and text reports.
Test-suite timings are single local observations; the two suites contain different
numbers of tests and do not establish a speed comparison.

## Does manager context stay small as the graph grows?

| Measurement | 64 leaves | 512 leaves |
|---|---:|---:|
| Total logical tasks | 73 | 585 |
| Integrators | 9 | 73 |
| Maximum ownership depth | 2 | 3 |
| Observed maximum direct children | 8 | 8 |
| Observed peak active workers | 32 | 64 |
| Root request bytes | 11,320 | 11,344 |
| Largest request bytes | 11,320 | 11,368 |
| Configured input ceiling | 16,384 bytes | 16,384 bytes |
| Maximum coordinator child cards | 8 | 8 |
| Context audit records | 73 | 585 |
| Model fixture | Scripted | Scripted |
| Task semantic-quality verdict | UNKNOWN | UNKNOWN |

The root did not receive 512 transcripts. It received eight direct-child cards, with
computed subtree counters and optional selective references. This demonstrates bounded
input representation and working runtime topology on the fixture; it does not establish
that a real model will correctly solve or integrate 512 hard tasks. Timestamps and small
counter changes can slightly change byte counts on rerun. Bytes are not token counts.

The fixture is read-only and has no semantic acceptance gate. Its orchestration verdict
is PASS while individual task-quality verdicts remain UNKNOWN. A model summary is never
silently promoted to a verified scientific or engineering claim.

## Reproduced defects and regression fixes

The new tests reproduce and guard: successful delegation incorrectly consuming failure
attempts; lifetime fan-out bypass through repeated or incremental admission; inconsistent
ownership/depth; short-context mailbox pages allowing premature completion; cursor
advancement on failed model requests; malformed result arguments raising unhandled type
errors; truncated observations claiming a full artifact that had not been stored; missing
pages of uncertainties/evidence; and Unicode requests exceeding a character-only bound.

The last mailbox/type regressions failed before the patch (three failures, 21 passes) and
passed afterward (24 passes). Raw records are `mailbox-regression-before.txt` and
`mailbox-regression-after.txt`. Existing report-schema assertions were deliberately
updated from ten tables/schema one to thirteen tables/schema two; tests still validate
exact table keys, escaping, health behavior and deterministic rendering.

## Reproduction commands

Run from the extracted source root in a virtual environment with the locked dependencies:

```bash
python scripts/check_source.py
python -m coverage run --branch -m pytest -q -o faulthandler_timeout=20 --junitxml=junit.xml
python -m coverage report
python examples/hierarchy_demo.py --output ./empty-hierarchy --leaves 512 --workers 64
python examples/demo.py --output ./empty-http-demo
python scripts/release.py verify --root . --manifest RELEASE-MANIFEST.json
```

Do not direct a fixture at an existing project. Fixtures refuse nonempty output directories.
The dependency lock and actual versions are recorded in `evidence/v1.2/environment.json`.
A public package-index installation was not tested. CI and deployment files are templates,
not evidence of executed hosted CI or production rollout.

## Explicit unverified boundaries

No hosted LLM endpoint, real-model success rate, long-running unattended production job,
large-repository benchmark, 256-slot load test, distributed cluster, Windows runtime,
accelerator workload, external billing, vulnerability scan, third-party linter, static
type checker or independent human/security review was exercised. Python execution was
on Linux/Python 3.13.5; a 3.11 grammar pass is not a 3.11 runtime pass.

The runtime remains single-host with SQLite and serialized integration. Native path and
publication checks are not an OS sandbox. Configured tests or CLI programs can execute
arbitrary code under their OS permissions; use an unprivileged outer container/VM and a
disposable checkout. Context-limit enforcement is not proof of factual accuracy or
proof that omitted detail was irrelevant. No policy, cancellation, budget or approval
boundary was removed to make the daemon appear continuously successful.
