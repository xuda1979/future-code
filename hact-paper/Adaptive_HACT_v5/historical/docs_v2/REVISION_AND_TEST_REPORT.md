# IC-HACT v2.0: Revision and Executed-Test Report

**Date:** September 18, 2026. **Manuscript:** Frontier-Aware Verification with
Soundness-Separated Learning. This is a substantial research revision, not a
claim of top-conference acceptance or a completed industrial deployment.

## What changed relative to HACT v1

| Old limitation | Revision | Why it matters |
|---|---|---|
| Optimized sets of jointly invalidated checks | Optimize ordered completion frontiers and charge full new-epoch construction | A system may invalidate all checks but discover a defect after only one; progress traffic is not determined by the initial stale set |
| Individual-activity information-loss result | New four-obligation separation even with identical **joint** invalidation distributions | Establishes why the previous sufficient information is insufficient for progressive verification |
| Mostly synthetic packet savings | Real source interventions in existing NetworkX, Toolz, and Future Code tests; direct process timings | Separates protocol efficiency from actual testing latency |
| Risk of treating impact estimates as authority | Advisory scheduling with an independently enforced complete registry | Missing learned edges cannot authorize an unexecuted check as a current PASS |
| Abstract freshness discussion | Executable local epoch fencing, immutable identities, conflict revocation, protected acceptance inputs | Stale, omitted, conflicting and modified-test evidence has tested rejection paths |
| A plausible specialized model could be overfit | Preserve the negative conditional-tree result and add a fresh confirmation cohort | The revised default is not presented as selected without seeing pilot results |

The greedy fault-set prioritizer and alphabetic dynamic-programming machinery are
established methods and are explicitly credited. The graph records finite effects
of controlled mutations; the paper does not call it complete causal discovery.

## Actual experimental scope

The scoped unmodified baselines pass 170 NetworkX tests, 148 Toolz tests, and
138 Future Code tests: **456 distinct tests across the three chosen scopes**.
A separate Future Code full-suite execution passes **263 tests**; its overlapping
138 core tests are not counted again as additional distinct tests.

The experiment predefined **121 source mutations** at nonoverlapping AST sites:
45 training, 43 development, and 33 newly frozen confirmation cases. A NetworkX
development candidate timed out and remains UNKNOWN. There are 120 complete
oracle runs. Survivors are retained; a survivor is not proof that the mutation is
semantically harmless. The mutations are controlled synthetic defects in real
code, not naturally occurring historical bugs or LLM-generated repairs.

The fresh confirmation cohort was introduced after development showed that
per-source tree fitting overfit. It uses new sites, fixed original training, and
unchanged serialized plans. It is a documented local freeze, not a third-party
preregistration. Confirmation tests known projects and mostly known source files;
it is not a leave-project-out test.

## Practical measurements

| Measurement | Observed result | Interpretation |
|---|---|---|
| Confirmation aggregation traffic, fixed compact-eight vs pooled frontier | 234.5 -> 210.3 KiB/candidate; **10.33% reduction**, paired source-cluster 95% CI [8.86%, 11.66%] | Actual kernel-serialized aggregation bytes in replay over real test outcomes; not network bandwidth or LLM token measurements |
| Confirmation checks to first failure, call-profile vs conditional | 26.17 -> 13.78; **47.34% fewer**, CI [19.26%, 77.46%] | Applies to 23 rejected confirmation candidates; not an elapsed-time reduction |
| Confirmation actual process time, call-profile vs conditional | 2.012 -> 1.980 seconds; **1.58% reduction**, CI [0.62%, 2.01%] | Mean of per-candidate medians over three repeats in a separate 12-candidate timing cohort |
| Development actual process time | **0.45% slower**, reduction CI [-1.31%, 0.36%] | The timing benefit is small and not consistently reproduced across the two cohorts |
| Per-source tree specialization on development | **26.93% more traffic** than pooled | Negative result retained; pooled is the disclosed revised default |
| Strict-wrapper overhead beyond the pytest subprocess | **0.301-0.517 seconds** | Includes copying, identities, acceptance contract, and certificate work; larger than the small ordering-time gain |
| Maximum aggregation packet | **3072 bytes** | Local message cap only; not a bound on all agent contexts or total memory |

Timing evidence comprises **276 development and 108 confirmation subprocess
executions (384 total)**. All recorded final verdicts agree with their complete
scoped oracle; none of these timing runs timed out. Timing includes startup,
collection, imports, tests, evidence writing, and order planning. Source copying
and tree fitting are excluded there and measured separately. Do not describe the
47.34% count improvement as a 47.34% acceleration.

## Executable use and failure handling

The generic verifier really ran three project lifecycles:

| Project | Trusted baseline | Deliberate faulty candidate | Original code restored | Protected-test edit |
|---|---|---|---|---|
| NetworkX | PASS, 170 checks | FAIL after 1 check | PASS, 170 checks | Rejected |
| Toolz | PASS, 148 checks | FAIL after 43 checks | PASS, 148 checks | Rejected |
| Future Code | PASS, 138 checks | FAIL after 1 check | PASS, 138 checks | Rejected |

These are known-fault functional smoke cases, not a randomized latency benchmark.
Restoration copies the original source; an LLM did not repair these candidates.
The practical result is a candidate-stage gate with real reports and evidence,
not merely an architecture diagram. It needs an approved meaningful test suite,
and an external integration service must still protect the final merge.

The unpruned call-profile unsafe-reuse comparator has **zero naturally observed
false PASS** in this cohort. In a deliberately severe, outcome-independent
75%-edge-pruning replay, the unsafe comparator would falsely accept 8 of the 23
rejected confirmation candidates. This is an adversarial ablation, not a measured
failure rate of NameRTS, and not a claim that ordinary coverage selection failed.
Strict mode does not use graph absence to authorize reuse.

## Verification of the prototype and stored evidence

The final local suite reports **144 passed**, no failures/errors/skips: the
original 90 HACT tests and 54 additional tests. Cases cover complete coverage,
missing leaves, exhaustive small-tree optimization, data validation, cap checks,
ABA and same-content epoch changes, late results, conflicting submissions,
idempotent delivery, local races, identity changes, malformed test orders,
modified protected tests, symlinks, and source mutation during execution.

The independent auditor uses only the standard library. It verifies all 121
source interventions and disjoint sites, 300 certificate decisions, all 384 timing
verdicts, and 17 paired statistical comparisons, regenerating bootstrap intervals
without importing producer cost helpers. A deliberately corrupted packet total is
rejected. This is a distinct checking implementation, not an external human audit.

The source tests and independent audit are repeated from the final extracted ZIP.
The separate release verification JSON records the actual extracted-run outputs,
archive hash, PDF hash, and manifest checks. Source changes after packaging would
invalidate those identities. Raw records contain exact commands, statuses,
outcomes, source hashes, timing samples, and frozen plans.

## Limits on the contribution

A certificate summarizes a declared test contract, not all possible behavior.
Hashing is identity binding, not remote attestation. The guard assumes a trusted
checker; private file copies are not an OS security boundary. No hosted model,
API cost, autonomous patch quality, multi-host consensus, large live-agent fleet,
Windows execution, or production deployment was measured.

The study supplies a specific algorithmic object, an information-separation
proof, a working gate, executable evidence, ablations and negative results. A
stronger conference submission still needs representative real bug histories,
independent repositories, standardized agent-generated changes, stronger fully
implemented testing baselines, and prospective end-to-end evaluation. These are
outstanding empirical questions, not claimed completed results.
