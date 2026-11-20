# rnd_plan.md issue disposition — 2026-11-20

Rule applied (project feedback): every change must win an A/B experiment vs
no-change; if no provable advantage, the change is not accepted.

| # | Plan issue | Disposition | Evidence |
| --- | --- | --- | --- |
| 1 | Repository bloat | **Fixed** (269863a): untracked 165 paper/evidence/validation assets (~13.9 MB). | `metrics_baseline.json` vs `metrics_slimmed.json` vs `metrics_current_20261120.json`: git status 42→22→25 ms, ls-tree 27→10→12 ms, grep 98→71→66 ms. Wins held 3 commits later. |
| 2 | Control-plane policy stacking (80 docs, 6 memory mechanisms) | **Not changed.** docs/agent-platform is operator documentation; it is not loaded by the runtime or the agent loop. No measurable runtime metric moves by merging/deleting docs, and deletion loses operator history. No provable win → rejected per the rule. | Runtime source imports none of these docs (grep over `src/` for doc names). |
| 3 | Python/TS glue split (87 KB single-file proxy) | **Not changed.** The proxy is the deployed model gateway (future-code.sh, DEPLOY-LINUX.md) with full test coverage (test_model_endpoints, test_provider_stream_completion). A TS rewrite is an architecture proposal (plan §3.2), not a defect fix; proving it better requires the live-model layer, which is not runnable here (no codex/claude binaries; gateway/results empty). Unmeasurable rewrite → rejected per the rule. | experiments/agent-benchmark-20261119/RESULTS.md "What did not run". |
| 4 | Sidecar loader/patch evolution | **Verified already converged; premise partially wrong.** `tests/correctness/*-loader.mjs` are Node module-isolation test harnesses for CI (registered by tracked tests), not unconverged features. The features they isolate — StreamingToolExecutor, toolResultBudgetPolicy — live in `src/`. The genuinely stale copies under experiments/first-commit-20261111/ were untracked in 269863a. | `src/services/tools/StreamingToolExecutor.ts`, `src/utils/toolResultBudgetPolicy.ts` exist; loaders referenced by `tests/correctness/*.test.ts` in the green gate. |
| 5 | CI sprawl (8 workflows) | **Not changed.** 6 of 8 workflows are path-filtered and only run when their files change; hact-journal-evidence.yml never runs on core-code PRs. Removing them would lose verified coverage with no measurable productivity gain. No provable win → rejected per the rule. | Trigger blocks in .github/workflows/*.yml (6/8 have `paths:`). |
| — | hact-paper payload (132 MB, 63% of tracked bytes) | **Deliberately retained.** RELEASE_MANIFEST.json hash-verifies these files and hact-journal-evidence.yml depends on them; `.rgignore` already excludes the heavy result JSONs from agent search, and post-slimming latency probes are already fast (status 25 ms, grep 66 ms), so the remaining cost is clone size only. Moving to a data repo breaks the evidence workflow and cannot be A/B-proven as a productivity win here. Revisit only if clone size becomes a measured problem. | This directory's metrics JSONs; hact-journal-evidence.yml trigger + verify_manifest.py. |

Fixes shipped alongside (each A/B-verified):

- dp4 side-route URL normalization (bdc3f60): baseline proxy fails 3 new
  regression subtests (404 loop on complete-URL secrets); fixed proxy passes
  6/6; full correctness gate green.
- Unsafe session-registry test umask robustness (0c6dc1b): spurious CI
  failure under umask 077 eliminated; suite 46/46 green.

Gates at push time (Node 22.16.0, umask 077 environment):
test-correctness (TS suites + 46 py + 62 research-jobs) OK;
test-resilience 62 OK; test-foundry OK (124 s); test-commands OK.
