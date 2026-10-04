# Sovereign runtime validation

Base revision: `aa7f326c0895cdf6782910d0e73645872d724d11`. Local runtime: Node 24.19.0 on Linux; the existing CI uses Node 22.16.0.

## Required gates

| Launcher | Node test invocations | Python test invocations | Result |
|---|---:|---:|---|
| `node scripts/test-correctness.mjs` | 40 | 16 | PASS; no skips |
| `node scripts/test-resilience.mjs` | 152 | 7 | PASS; no skips |
| `node scripts/test-foundry.mjs` | 352 | 0 | PASS; no skips |
| `node scripts/test-swarm.mjs` | 89 | 0 | PASS; no skips |
| `node scripts/test-commands.mjs` | 82 | 0 | PASS; no skips |

The launchers intentionally overlap suites; these are invocation counts, not a claim of unique tests. The focused sovereignty and real-project suites contain 14 tests covering admission, immutable evidence, retractable claims, transitive invalidation, revalidation gates, independent adjudication, replay, cached integration and policy abstention.

## Real-source evaluation

A frozen independent checker reproduces the receipt-budget defect on the input revision before trial execution. Three alternating baseline/candidate pairs then edit that real repository source and pass task plus final integration checks. The corresponding `inlineReceipt` input validation fix is included in this change.

The recorded report is [real-project-replay.json](validation/real-project-replay.json). Decision: `OFFLINE_BOUNDARY_ONLY`; six successful trials; zero live model calls; speedup intentionally null. Source hashes, protocol identity, every trial and accepted artifact/proof references are retained.

No model API credentials were configured in the authoring environment. The live evaluator is implemented, but live productivity, billed-dollar efficiency and comparisons with other coding agents remain unmeasured. The full Bun terminal application and adversarial OS isolation were not certified by these core gates.
